import fs from 'node:fs';
import path from 'node:path';
import { bundledDshHome, getAgentConfig, type AgentConfig } from '../assistant/config.js';
import { profilePatchPath } from '../assistant/agentSettings.js';
import { parseCredentialRefs, parseDshProviders, modelKeyRef } from './videoModel.js';

/**
 * 成文（写作）模型：跟随内置 Agent 控制台的默认模型。
 *
 * 背景：视频提炼的第二段要用「内置 Agent 的文本模型」成文。旧实现直接读 Engram 自己的
 * `agent_config`（0.1.x 面板留下的旧 Key），控制台里把默认模型切到 deepseek-v4-pro 也不会生效。
 * 这里改成读 dsh 控制台的 `agent-default-model`（profile patch 顶层条目），再按提供者解析
 * Base URL 与凭据：
 *  - 官方 deepseek：用旧面板的 Key（或 DEEPSEEK_API_KEY）走 api.deepseek.com；
 *  - 自定义提供者（如 DashScope）：用 llm-pi-ai providers 里的 baseURL/api 与 .credentials.yaml 的 Key。
 *
 * 读不到控制台配置时回退到旧 agent_config，行为与之前一致；再不行由调用方回退视频模型。
 */

export interface EditorCandidate {
  config: AgentConfig;
  label: string;
}

const OFFICIAL_PROVIDERS = new Set(['deepseek-official', 'deepseek']);
/** dsh 控制台没保存过默认模型时的 bundle 默认值（见 assistant/agentModelRoute.ts 注释） */
const BUNDLE_DEFAULT_MODEL = 'deepseek-flash';
const BUNDLE_DEFAULT_PROVIDER = 'deepseek-official';

/** 顶层条目（`- id: xxx`）的 config 直接子键；只认标量，够读 provider/model */
function topLevelConfig(text: string, entryId: string): Record<string, string> | null {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const entry = /^-\s+id:\s*(.+?)\s*$/.exec(lines[index]);
    if (!entry || entry[1].replace(/^['"]|['"]$/g, '') !== entryId) continue;
    const values: Record<string, string> = {};
    let configIndent = -1;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) break;
      if (configIndent < 0) {
        if (/^\s+config:\s*(?:#.*)?$/.test(line)) configIndent = indent;
        continue;
      }
      if (indent <= configIndent) break;
      if (indent !== configIndent + 2) continue;
      const field = /^\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (!field) continue;
      const value = field[2].trim().replace(/^['"]|['"]$/g, '');
      if (value) values[field[1]] = value;
    }
    return configIndent < 0 ? null : values;
  }
  return null;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function keyForProvider(providerId: string, apiKeyEnv: string | undefined, home: string): string {
  const refs = parseCredentialRefs(readText(path.join(home, '.credentials.yaml')));
  const ref = modelKeyRef(providerId, apiKeyEnv);
  return (refs[ref] || process.env[ref] || '').trim();
}

/**
 * 解析控制台当前默认模型对应的成文配置。
 *
 * @param home DSH_HOME（默认 <数据目录>/dsh）
 * @param fallback 旧版 agent_config（官方 Key 通常在这里）
 * @returns 带 Key 的配置；解析不到返回 null（调用方回退旧配置/视频模型）
 */
export function resolveEditorConfig(
  home: string = bundledDshHome(),
  fallback: AgentConfig = getAgentConfig()
): AgentConfig | null {
  const patch = readText(profilePatchPath(home));
  const entry = topLevelConfig(patch, 'agent-default-model');
  const provider = (entry?.provider || BUNDLE_DEFAULT_PROVIDER).trim();
  const model = (entry?.model || BUNDLE_DEFAULT_MODEL).trim();
  if (!model) return null;

  if (OFFICIAL_PROVIDERS.has(provider)) {
    const apiKey = (fallback.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
    if (!apiKey) return null;
    // 不带 baseUrl 即走官方路由；api 固定 openai-completions
    return { model, apiKey, api: 'openai-completions' };
  }

  const providerConfig = parseDshProviders(patch).find((item) => item.id === provider);
  if (!providerConfig) return null;
  const baseUrl = (providerConfig.baseURL || '').trim();
  const api = (providerConfig.api || 'openai-completions').trim();
  const apiKey = keyForProvider(providerConfig.id, providerConfig.apiKeyEnv, home);
  if (!baseUrl || !apiKey) return null;
  return { model, baseUrl, api, apiKey };
}

/** 去重并保留顺序：显式注入（测试）→ 控制台默认 → 旧 agent_config */
export function editorCandidates(options: {
  explicit?: AgentConfig;
  home?: string;
  fallback?: AgentConfig;
} = {}): EditorCandidate[] {
  const fallback = options.fallback ?? getAgentConfig();
  const consoleConfig = resolveEditorConfig(options.home, fallback);
  const list: EditorCandidate[] = [];
  const seen = new Set<string>();
  const push = (config: AgentConfig | null | undefined, label: string) => {
    if (!config || !(config.apiKey || '').trim()) return;
    const key = JSON.stringify([config.baseUrl || '', config.api || '', config.model || '', config.apiKey]);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ config, label });
  };
  push(options.explicit, '指定模型');
  push(consoleConfig, '控制台默认模型');
  push(fallback, '旧版模型配置');
  return list;
}
