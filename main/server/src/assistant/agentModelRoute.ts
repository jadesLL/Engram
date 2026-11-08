import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CONSOLE_PROFILE, agentSettingsStateFingerprint } from './agentSettings.js';

/**
 * 聊天运行时（dsh SDK）的模型路由。
 *
 * 为什么需要它：聊天走 @deepseek-ai/dsh-sdk-client，`initialize` 必须带 provider/model；
 * 不带时 SDK 兜底成 `deepseek-official` + `deepseek-v4-flash`。那个 id 不在 dsh 的模型目录里，
 * 而 dsh 对目录外模型一律返回 `inputModalities: ['text']`（dsh-llm-deepseek 的 modelInfo），
 * 于是 MCP 工具返回的图片被投影成占位文本（`model "..." does not declare image input`）——
 * 控制台模型目录里给模型勾的「图片」永远不生效，切默认模型对聊天也是空操作（2026-11-08 实测）。
 *
 * 控制台的默认模型存在 dsh 自己的 `agent-default-model` 设置里，0.2.1-rc.2 只有 dsh 网页端
 * 与 headless 读它，SDK 会话不读。所以这里按控制台同一口径把「有效默认模型」读出来，显式交给 SDK：
 *  - 用户在控制台保存过默认模型 → profile patch 顶层 `agent-default-model` 的 config；
 *  - 没保存过 → dsh 自带 bundle 的默认值（`deepseek-flash`，目录里声明了 text+image）。
 *
 * 两种来源都由 `dsh --profile web --dump-config` 逐层打印（bundle → profile patch → home patch →
 * --patch，后面的层覆盖前面的层），这里只解析、不启动 dsh；读不到就返回 undefined，
 * 聊天照旧用 SDK 默认路由（不阻断对话，只是没有目录里的能力位）。
 */

export interface AgentModelRoute {
  provider: string;
  model: string;
}

/** 顶层条目行（`- id: xxx`；缩进的 insert 子项不算，与 agentSettings.topLevelEntryIds 同口径） */
const TOP_LEVEL_ID = /^-\s+id:\s*(\S+)\s*$/;

/** dump 里 config 的直接子键行（字段固定缩进两级） */
const CONFIG_KEY = /^\s+([A-Za-z][\w-]*):\s*(.*)$/;

/** 去掉 YAML 单/双引号 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 读一个顶层条目的 `config:` 映射（只取 config 的直接子键）。
 *
 * 为什么不用 YAML 库：dump 输出带 `!!js` 自定义 tag 与分节注释，不是一份合法 YAML；
 * 这里只需要 config 下的一层标量（provider / model / reasoningEffort），逐行读足够稳。
 */
function entryConfig(lines: readonly string[], start: number): Record<string, string> | undefined {
  let configIndent = -1;
  const values: Record<string, string> = {};
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // 下一个顶层条目（或另一个 layer 的分节）
    if (configIndent < 0) {
      if (/^\s+config:\s*(?:#.*)?$/.test(line)) configIndent = indent;
      continue;
    }
    if (indent <= configIndent) break; // config 块结束
    if (indent !== configIndent + 2) continue; // 更深层是 models 之类的嵌套结构
    const match = CONFIG_KEY.exec(line);
    if (!match) continue;
    const value = unquote(match[2]);
    if (value) values[match[1]] = value;
  }
  return configIndent < 0 ? undefined : values;
}

/**
 * 从 `dsh --dump-config` 的输出解析有效默认模型。
 *
 * dump 按 layer 逐个打印、不合并；后面的层覆盖前面的层（控制台保存默认模型时写的是完整 config）。
 * 解析不到（dsh 版本变化 / 输出异常 / 没有这个条目）返回 undefined。
 */
export function parseAgentModelRoute(dump: string): AgentModelRoute | undefined {
  const lines = dump.replace(/^\uFEFF/, '').split(/\r?\n/);
  let provider: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const id = TOP_LEVEL_ID.exec(lines[index]);
    if (!id || unquote(id[1]) !== 'agent-default-model') continue;
    const config = entryConfig(lines, index + 1);
    if (!config) continue;
    if (config.provider) provider = config.provider;
    if (config.model) model = config.model;
  }
  return provider && model ? { provider, model } : undefined;
}

export interface ReadAgentModelRouteOptions {
  /** 真实 Node（桌面端不能用 Electron 的 process.execPath，见 agentNode.ts） */
  node: string;
  /** dsh 入口（bundledDshExecutable() 或用户覆盖的 dshPath） */
  dshBin: string;
  /** DSH_HOME（Engram 数据目录下的 dsh） */
  home: string;
  profile?: string;
  /** 版本号只参与缓存键（dsh 升级后默认值可能变化） */
  version?: string | null;
  timeoutMs?: number;
}

/** dsh home 级 patch（`$DSH_HOME/cordis.patch.yml`）的状态指纹；用户手改它会改变有效默认模型 */
function homePatchFingerprint(home: string): string {
  try {
    const stat = fs.statSync(path.join(home, 'cordis.patch.yml'));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/**
 * dump 缓存键：dsh 入口 / 真实 Node / 版本 / profile 配置状态（profile patch + bundle 列表 + 凭据）+ home patch。
 * 控制台保存模型会重写 profile patch → 指纹变化 → 下一轮重新 dump；内容没变时不会重复起子进程。
 */
export function agentModelRouteCacheKey(options: ReadAgentModelRouteOptions): string {
  const profile = options.profile ?? CONSOLE_PROFILE;
  return JSON.stringify([
    options.dshBin,
    options.node,
    options.version || '',
    profile,
    agentSettingsStateFingerprint(options.home),
    homePatchFingerprint(options.home),
  ]);
}

/**
 * 跑 `dsh --profile <p> --dump-config` 读有效默认模型；任何失败都返回 undefined，绝不抛。
 * 约 200~300ms，只在运行时创建/控制台改配置时发生（见 resolveAgentModelRoute 的缓存）。
 */
export function readAgentModelRoute(options: ReadAgentModelRouteOptions): AgentModelRoute | undefined {
  const profile = options.profile ?? CONSOLE_PROFILE;
  try {
    const stdout = execFileSync(options.node, [options.dshBin, '--profile', profile, '--dump-config'], {
      cwd: options.home,
      env: { ...process.env, DSH_HOME: options.home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: options.timeoutMs ?? 15000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return parseAgentModelRoute(stdout);
  } catch {
    return undefined;
  }
}

let memo: { key: string; route: AgentModelRoute | undefined } | undefined;

/** 按配置指纹缓存的 readAgentModelRoute（聊天运行时每轮都会问一次） */
export function resolveAgentModelRoute(options: ReadAgentModelRouteOptions): AgentModelRoute | undefined {
  const key = agentModelRouteCacheKey(options);
  if (memo?.key === key) return memo.route;
  const route = readAgentModelRoute(options);
  memo = { key, route };
  return route;
}

/** 单测 / 诊断：清空缓存（改配置后需要立刻重读时也可用） */
export function resetAgentModelRouteCache(): void {
  memo = undefined;
}
