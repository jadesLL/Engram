import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig } from './config.js';

/**
 * 内置 Agent 的模型路由配置。
 *
 * 0.1.5 及更早：dsh 的模型路由来自 `$DSH_HOME/settings.yaml`（llm-pi-ai 声明自定义 provider
 * 路由，agent-default-model 指默认路由）。
 *
 * 0.2.x 起（本仓库锁 0.2.1-rc.2）：settings.yaml 降级为**一次性遗留导入**——dsh 启动后把它
 * 按顶层段名导入对应 loader entry，随后改名为 settings.yaml.imported，之后再写不再生效。
 * 新的落盘通道是 **Cordis patch**（层序 bundle → profile patch → home patch → --patch）。
 *
 * 所以这里只负责「配置 → 路由判定」与「遗留文件清理」；真正写盘的是 agentPatch.ts：
 * 把路由写成 `engram.cordis.yml` 里的 llm-pi-ai / agent-default-model 两条 patch，
 * 随 SDK 的 `--patch` 显式叠加（层级最高，压过 dsh 导入的旧 settings）。
 */

/** 自定义地址用的 provider 路由 id（固定一条，每次保存整条重写） */
export const CUSTOM_PROVIDER_ID = 'engram-custom';
/** 自定义地址的凭据引用名：dsh 按 apiKeyEnv 解析，跑 Agent 时经该环境变量注入 Key */
export const CUSTOM_KEY_ENV = 'ENGRAM_AGENT_API_KEY';
/** dsh llm-pi-ai 支持的线协议；默认 openai-completions（多数中转站/网关） */
export const AGENT_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type AgentApi = (typeof AGENT_APIS)[number];
export const DEFAULT_AGENT_API: AgentApi = 'openai-completions';

/** 0.1.5 及更早版本写入 settings.yaml 的文件头（升级时据此识别本方遗留文件） */
export const LEGACY_SETTINGS_HEADER =
  '# Engram 内置 Agent 的模型地址配置（由 设置 → Agent 接入 → 内置 Agent 维护）。';
/** 遗留 settings.yaml 里由本方维护的顶层段（= dsh loader entry id） */
export const LEGACY_ROUTE_ENTRY_IDS = ['llm-pi-ai', 'agent-default-model'] as const;

export interface CustomRoute {
  /** llm-pi-ai 的 provider 路由 id */
  provider: string;
  /** 自定义 API 地址（baseURL） */
  baseUrl: string;
  /** 线协议 */
  api: AgentApi;
  /** 模型 id */
  model: string;
  /** 凭据环境变量名 */
  keyEnv: string;
}

/** 归一化线协议：不认识的取值退回默认（设置页只给三个选项，这里防手改 API） */
export function agentApi(value: string | undefined): AgentApi {
  const api = (value || '').trim();
  return (AGENT_APIS as readonly string[]).includes(api) ? (api as AgentApi) : DEFAULT_AGENT_API;
}

/**
 * 解析自定义地址路由：地址与模型都填了才算启用。
 * 返回 null 表示走 dsh 自带的 `deepseek-official`（官方地址 + DEEPSEEK_API_KEY）。
 */
export function customRoute(config: AgentConfig): CustomRoute | null {
  const baseUrl = (config.baseUrl || '').trim();
  const model = (config.model || '').trim();
  if (!baseUrl || !model) return null;
  return {
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    api: agentApi(config.api),
    model,
    keyEnv: CUSTOM_KEY_ENV,
  };
}

/** YAML 双引号标量：转义反斜杠/双引号，顺带把换行折成空格，挡掉注入 */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

/** 遗留 settings.yaml 的路径（0.1.5 时代写入；0.2.x 只做一次性导入） */
export function agentSettingsPath(home: string): string {
  return path.join(home, 'settings.yaml');
}

/**
 * 删掉本方遗留的 settings.yaml（文件头匹配才动，用户手写文件保留）。
 *
 * 为什么必须清：0.2.1 会把它导入 profile patch；若用户之后关掉自定义地址，
 * 我们的 patch 不再覆盖 llm-pi-ai/agent-default-model，导入的旧路由就会反超默认值。
 * 调用方（agentPatch.writeAgentPatch）同时会把导入到 profile patch 的同名顶层条目清掉。
 *
 * @returns true 表示确实删掉了一个本方遗留文件
 */
export function cleanupLegacySettings(home: string): boolean {
  const file = agentSettingsPath(home);
  try {
    if (!fs.existsSync(file)) return false;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(LEGACY_SETTINGS_HEADER)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** dsh 0.2.x 的 profile patch（settings 写入通道；遗留导入也落在这里） */
export function profilePatchPath(home: string, profile = 'sdk'): string {
  return path.join(home, 'profiles', profile, 'cordis.patch.yml');
}

const TOP_LEVEL_ID = /^-\s+id:\s*(\S+)\s*$/;

/** 列出 patch / dump 文本里所有**顶层**条目 id（缩进的 insert 子项不算） */
export function topLevelEntryIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = TOP_LEVEL_ID.exec(line);
    if (match) ids.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return ids;
}

/**
 * 从 profile patch 文本里删掉指定 id 的顶层条目。
 * 注释与其它条目逐字保留（文件头注释属于 dsh 的 profile 默认内容，不能顺手删掉）。
 */
export function dropTopLevelEntries(text: string, ids: readonly string[]): string {
  const wanted = new Set(ids);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const match = TOP_LEVEL_ID.exec(line);
    if (match) {
      const id = match[1].replace(/^['"]|['"]$/g, '');
      skipping = wanted.has(id);
      if (skipping) continue;
    } else if (skipping && /^\s+/.test(line)) {
      continue; // 被删条目的续行
    } else if (skipping && line.trim() === '') {
      skipping = false;
      continue;
    } else if (skipping) {
      skipping = false;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

/**
 * 清理 0.2.x 遗留导入：删本方 settings.yaml，并把 dsh 导入到 profile patch 的
 * 同名条目去掉（只在本方遗留文件确实存在时动手，避免误改用户内容）。
 */
export function cleanupLegacyRoute(home: string): { removedSettings: boolean; cleanedProfilePatch: boolean } {
  const removedSettings = cleanupLegacySettings(home);
  if (!removedSettings) return { removedSettings: false, cleanedProfilePatch: false };
  const patch = profilePatchPath(home);
  try {
    if (!fs.existsSync(patch)) return { removedSettings, cleanedProfilePatch: false };
    const text = fs.readFileSync(patch, 'utf8');
    const next = dropTopLevelEntries(text, LEGACY_ROUTE_ENTRY_IDS);
    if (next === text) return { removedSettings, cleanedProfilePatch: false };
    fs.writeFileSync(patch, next, 'utf8');
    return { removedSettings, cleanedProfilePatch: true };
  } catch {
    return { removedSettings, cleanedProfilePatch: false };
  }
}
