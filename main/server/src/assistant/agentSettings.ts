import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 内置 Agent 的配置边界。
 *
 * 0.2.x 起，模型的「设置 → 模型」与「插件」页都由 DeepSeek Harness 自己的控制台管理
 * （web profile 的原生页面，Engram 通过反向代理嵌进设置页）。Engram 不再写 settings.yaml，
 * 也不再替用户写模型路由 patch——那两套已经删除。
 *
 * 本模块只保留三件事：
 *  1. 升级清理：0.1.5 时代写入的 settings.yaml，以及它被 0.2.x 一次性导入后
 *     留在 profile patch 里的旧路由条目（否则会反超用户在控制台里的选择）；
 *  2. 控制台 profile 的路径口径（Engram 只读指纹，不直接编辑这些文件）；
 *  3. 一个状态指纹：控制台改过配置（profile patch / bundle 列表 / 凭据文件）后，
 *     正在跑的聊天运行时必须重开才能用上新配置。
 */

/** 0.1.5 及更早版本写入 settings.yaml 的文件头（升级时据此识别本方遗留文件） */
export const LEGACY_SETTINGS_HEADER =
  '# Engram 内置 Agent 的模型地址配置（由 设置 → Agent 接入 → 内置 Agent 维护）。';
/** 遗留 settings.yaml 里由本方维护的顶层段（= dsh loader entry id） */
export const LEGACY_ROUTE_ENTRY_IDS = ['llm-pi-ai', 'agent-default-model'] as const;
/** 控制台与聊天运行时共用的 dsh profile（原生插件页 / 设置页管理的就是它） */
export const CONSOLE_PROFILE = 'web';

/** 遗留 settings.yaml 的路径（0.1.5 时代写入；0.2.x 只做一次性导入） */
export function agentSettingsPath(home: string): string {
  return path.join(home, 'settings.yaml');
}

/** 某个 profile 的目录 */
export function profileDir(home: string, profile = CONSOLE_PROFILE): string {
  return path.join(home, 'profiles', profile);
}

/** dsh 0.2.x 的 profile patch（控制台的设置页写这里；遗留导入也落在这里） */
export function profilePatchPath(home: string, profile = CONSOLE_PROFILE): string {
  return path.join(profileDir(home, profile), 'cordis.patch.yml');
}

/**
 * 控制台会改动的文件：profile patch、bundle 列表（装/卸插件）、凭据文件。
 * 聊天运行时的配置指纹把这些文件的内容算进去，变了就重开运行时。
 */
export function profileStatePaths(home: string): string[] {
  return [
    profilePatchPath(home),
    path.join(profileDir(home), 'package.json'),
    path.join(home, '.credentials.yaml'),
  ];
}

/** 控制台配置状态指纹（文件内容 + mtime/size；读不到按空） */
export function agentSettingsStateFingerprint(home: string): string {
  const hash = createHash('sha1');
  for (const file of profileStatePaths(home)) {
    hash.update(file);
    try {
      // 只算内容：控制台保存时可能重写同样内容，mtime 变化不该触发聊天运行时重开
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}

/**
 * 删掉本方遗留的 settings.yaml（文件头匹配才动，用户手写文件保留）。
 *
 * 为什么必须清：0.2.1 会把它导入 profile patch；若用户在控制台里改了模型，
 * 旧值可能以 profile patch 的形式继续存在，需要我们的清理配合。
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

/** 从 profile patch 文本里删掉指定 id 的顶层条目；注释与其它条目逐字保留 */
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
 * 同名条目去掉（只在本方遗留文件确实存在时动手，避免误改用户/控制台的内容）。
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

/* ------------------------------------------------------------------ *
 * 服务端「工具类」模型调用仍然复用同一份旧配置（标题自动命名、收集箱转换等）
 *
 * 注意：聊天 Agent 的模型不再走这里（由 DSH 控制台管理）。这些字段保留是为了
 * 升级后旧用户的工具类请求继续可用；新用户没填过时，这些功能会给出「未配置」提示。
 * ------------------------------------------------------------------ */

/** 自定义地址用的 provider 路由 id */
export const CUSTOM_PROVIDER_ID = 'engram-custom';
/** 自定义地址的凭据引用名 */
export const CUSTOM_KEY_ENV = 'ENGRAM_AGENT_API_KEY';
/** 工具类调用支持的线协议；默认 openai-completions */
export const AGENT_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type AgentApi = (typeof AGENT_APIS)[number];
export const DEFAULT_AGENT_API: AgentApi = 'openai-completions';

export interface CustomRoute {
  provider: string;
  baseUrl: string;
  api: AgentApi;
  model: string;
  keyEnv: string;
}

/** 归一化线协议：不认识的取值退回默认 */
export function agentApi(value: string | undefined): AgentApi {
  const api = (value || '').trim();
  return (AGENT_APIS as readonly string[]).includes(api) ? (api as AgentApi) : DEFAULT_AGENT_API;
}

/** 解析自定义地址路由：地址与模型都填了才算启用；返回 null 表示走官方地址 */
export function customRoute(config: { baseUrl?: string; model?: string; api?: string }): CustomRoute | null {
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

/** YAML 双引号标量转义（工具类配置写盘时也用它） */
export function quote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
}
