import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from '../config.js';
import { getSetting, setSetting } from '../lib/db.js';

/**
 * 内置 Agent（聊天抽屉）配置与路径。
 *
 * 与「Agent 接入」（给用户自己安装的 harness 注册 MCP）互不相干：这里是 Engram 随包
 * 内置的 dsh 运行时，DSH_HOME 放在数据目录下，凭据与知识库一起走持久卷。
 */

export interface AgentConfig {
  /** 覆盖 dsh 入口（默认用随包依赖里的 @deepseek-ai/dsh/lib/bin.js） */
  dshPath?: string;
  /** 模型名（留空用 dsh 默认；填了自定义地址则必填） */
  model?: string;
  /** 自定义 API 地址：填了就走 llm-pi-ai 自定义 provider 路由，留空走 dsh 自带的 deepseek-official */
  baseUrl?: string;
  /** 自定义地址的线协议（取值见 agentSettings.AGENT_APIS，默认 openai-completions） */
  api?: string;
  /** 模型凭据：跑 dsh 时经环境变量注入（自定义地址用 ENGRAM_AGENT_API_KEY，官方用 DEEPSEEK_API_KEY） */
  apiKey?: string;
}

export const AGENT_CONFIG_KEY = 'agent_config';

export function getAgentConfig(): AgentConfig {
  try {
    const raw = getSetting(AGENT_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function setAgentConfig(patch: Partial<AgentConfig>): AgentConfig {
  const next = { ...getAgentConfig(), ...patch };
  for (const key of Object.keys(next) as Array<keyof AgentConfig>) {
    if (next[key] === undefined) delete next[key];
  }
  setSetting(AGENT_CONFIG_KEY, JSON.stringify(next));
  return next;
}

/** 内置 Agent 的 DSH_HOME：数据目录内，与用户自己的 ~/.dsh 隔离 */
export function bundledDshHome(): string {
  return path.join(DATA_DIR, 'dsh');
}

/**
 * Agent 的工作目录：独立空目录，**不是**知识库目录。
 * 姿态是空壳工作目录（不是知识库目录）+ 知识库只经 MCP 工具；文件/命令工具的沙箱策略
 * 以 dsh 的 sdk profile 实际配置为准（设置页「内置 Agent 运行时」按 dump 如实展示）。
 */
export function agentWorkspaceDir(): string {
  return path.join(bundledDshHome(), 'workspace');
}

let cachedBundledBin: string | null | undefined;

let cachedVersions: Record<string, string | null> = {};

/**
 * 读取随包依赖的 npm 版本（读不到返回 null）。
 *
 * 设置页「内置 Agent 运行时」用它展示版本指纹；不联网、不启动子进程，纯 require.resolve。
 */
export function packageVersion(pkg: string): string | null {
  if (pkg in cachedVersions) return cachedVersions[pkg];
  let version: string | null = null;
  try {
    const require = createRequire(import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(packageManifest(require, pkg) ?? '', 'utf8'));
    version = typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    version = null;
  }
  cachedVersions = { ...cachedVersions, [pkg]: version };
  return version;
}

/**
 * 定位某个包的 package.json。
 *
 * 先走导出映射里的 `./package.json`（dsh 有）；没有导出的包（例如某些 peer 依赖）
 * 退回「解析入口 → 向上找同名 package.json」，避免把一个能读到的版本显示成 null。
 */
function packageManifest(require: NodeJS.Require, pkg: string): string | null {
  try {
    return require.resolve(`${pkg}/package.json`);
  } catch {
    /* 继续走入口解析 */
  }
  try {
    let dir = path.dirname(require.resolve(pkg));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (parsed.name === pkg) return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 解析不到就是 null */
  }
  return null;
}

/** 随包 dsh 运行时版本 */
export function bundledDshVersion(): string | null {
  return packageVersion('@deepseek-ai/dsh');
}

/** 随包 dsh SDK 客户端版本 */
export function bundledSdkClientVersion(): string | null {
  return packageVersion('@deepseek-ai/dsh-sdk-client');
}

/** 随包依赖里的 dsh 入口；未安装返回 null */
export function bundledDshBin(): string | null {
  if (cachedBundledBin !== undefined) return cachedBundledBin;
  try {
    const require = createRequire(import.meta.url);
    cachedBundledBin = require.resolve('@deepseek-ai/dsh/lib/bin.js');
  } catch {
    cachedBundledBin = null;
  }
  return cachedBundledBin;
}
