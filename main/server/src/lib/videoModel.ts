import fs from 'node:fs';
import path from 'node:path';
import { profilePatchPath } from '../assistant/agentSettings.js';

/**
 * 视频理解模型：从 DeepSeek Harness（dsh）自己的模型配置里解析。
 *
 * 背景（2026-11 起）：「视频理解模型」不再由 Engram 单独维护 Base URL / API Key / 模型名表单，
 * 而是复用「内置 Agent 控制台 → 模型」里同一套 dsh 模型提供者配置（用户只填一个 DashScope API Key，
 * 提供商与 qwen3.8-omni-flash 由 Engram 预置，见 assistant/videoModelDefaults.ts）。
 *
 * 本模块只做**只读解析**，不启动 dsh 进程，因此视频提炼不依赖控制台是否在跑：
 *  - 提供者写在中枢 dsh profile 的 patch 层：<DSH_HOME>/profiles/web/cordis.patch.yml
 *    里顶层条目 id: llm-pi-ai 的 config.providers.<id>（dsh 设置页保存后就长这样）；
 *  - API Key 写在 dsh 凭据文件 <DSH_HOME>/.credentials.yaml 的 refs.<apiKeyEnv>。
 *
 * 解析用「按缩进读已知结构」而不是引入 YAML 依赖：仓库刻意不引 YAML（见 lib/dshConfig.ts），
 * 而且这里只读自家写入 / dsh 设置页写入的规整结构，容忍注释与空行，读不到就退化为「未配置」，
 * 不会因为用户手写怪语法把设置页打挂。
 */

/** 预置的默认提供商 id（与 console 的 provider id 规则一致：小写短横线标识） */
export const VIDEO_PROVIDER_ID = 'dashscope';
/** 设置页展示的提供商名 */
export const VIDEO_PROVIDER_DISPLAY_NAME = '阿里云百炼（DashScope）';
/** DashScope 的 OpenAI 兼容网关地址（视频 / 图文都走这一条） */
export const VIDEO_PROVIDER_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** 默认视频理解模型 */
export const VIDEO_MODEL_ID = 'qwen3.8-omni-flash';
/** 默认凭据引用名（dsh 约定：<PROVIDER>_API_KEY） */
export const VIDEO_PROVIDER_KEY_ENV = 'DASHSCOPE_API_KEY';
/** 目前只支持 OpenAI 兼容 chat/completions（视频是厂商扩展的 video_url 块） */
export const VIDEO_MODEL_API = 'openai-completions';

export interface DshProviderModel {
  id: string;
  name?: string;
  /** 上下文窗口（dsh 设置页可填；只读解析，写回时按原样保留） */
  contextWindow?: number;
  /** pi-ai 的输入能力字段 `input`（text / image / …）；与官方 inputModalities 同义、字段名不同 */
  input?: string[];
  /** 官方 DeepSeek 模型条目的输入能力字段名 */
  inputModalities?: string[];
}

export interface DshProvider {
  id: string;
  displayName?: string;
  api?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  models: DshProviderModel[];
}

/** 解析后的视频模型配置（永远带回退值，方便界面展示「默认会用什么」） */
export interface ResolvedVideoModel {
  providerId: string;
  providerName: string;
  baseUrl: string;
  api: string;
  model: string;
  apiKey: string;
  keyRef: string;
}

/**
 * 同步下来的模型配置回退（多端同步的 agent_model_config）。
 *
 * 本机 dsh 还没配上（或根本没配 dashscope）时，视频理解可以直接用同步群组里
 * 其他设备的提供商与 Key，不必等 dsh 重读配置或控制台启动。
 */
export interface VideoModelFallback {
  providers?: DshProvider[];
  /** ref → 明文 Key（只在本进程内用于发请求，绝不回显） */
  keys?: Record<string, string>;
}

/** Key 的来源：本机 dsh 配置 / 多端同步 / 都没有（前端据此显示「来自多端同步」） */
export type VideoKeySource = 'local' | 'synced' | 'none';

/** 一次解析的完整结果：resolved + 缺项（缺什么就提示什么） */
export interface VideoModelResolution {
  provider: ResolvedVideoModel;
  missing: string[];
  /** 是否找到了 dsh 里的提供者（默认预置值不算「已配置」） */
  providerFound: boolean;
  configured: boolean;
  keySource: VideoKeySource;
}

/** 行首缩进宽度（空格数；配置由 dsh / 界面写入，不会出现 tab 缩进） */
export function indentOf(line: string): number {
  const match = /^\s*/.exec(line);
  return match ? match[0].length : 0;
}

/** 空行与纯注释行：解析时跳过，不算结构 */
export function isSkippable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/** 去掉 YAML 标量两侧的引号（单引号里的 '' 是一个单引号；双引号做常见转义还原） */
export function unquoteScalar(raw: string): string {
  const value = raw.trim().replace(/\s+#.*$/, '');
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return value;
}

/** 解析 YAML 流式字符串数组（`[text, image]`）；不是流式写法时返回空数组（块状序列另行处理） */
export function parseStringList(raw: string): string[] {
  const value = raw.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return [];
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => unquoteScalar(item))
    .filter((item) => item.length > 0);
}

/** 找顶层 loader patch 条目（- id: <id>）的行区间 [start, end)（缩进的 - id: 是子项，不算） */
export function findTopLevelEntry(lines: string[], entryId: string): { start: number; end: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^-\s+id:\s*(.+?)\s*$/.exec(lines[index]);
    if (!match || unquoteScalar(match[1]) !== entryId) continue;
    let end = index + 1;
    while (end < lines.length && !/^-(\s|$)/.test(lines[end])) end += 1;
    return { start: index, end };
  }
  return null;
}

/**
 * 解析顶层条目 id: llm-pi-ai 里的 providers 映射。
 *
 * 只认 dsh 设置页 / Engram 播种写入的块状结构：
 *   config:
 *     providers:
 *       dashscope:
 *         displayName: ...
 *         models:
 *         - id: qwen3.8-omni-flash
 *           name: ...
 */
export function parseDshProviders(patchText: string): DshProvider[] {
  const lines = patchText.replace(/^\uFEFF/, '').split(/\r?\n/);
  const block = findTopLevelEntry(lines, 'llm-pi-ai');
  if (!block) return [];
  let providersIndex = -1;
  for (let index = block.start; index < block.end; index += 1) {
    if (/^\s*providers:\s*(#.*)?$/.test(lines[index])) {
      providersIndex = index;
      break;
    }
  }
  if (providersIndex < 0) return [];
  const providersIndent = indentOf(lines[providersIndex]);
  const providers: DshProvider[] = [];
  let index = providersIndex + 1;
  while (index < block.end) {
    const line = lines[index];
    if (isSkippable(line)) {
      index += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent <= providersIndent) break;
    const providerMatch = indent === providersIndent + 2 ? /^([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(line.trim()) : null;
    if (!providerMatch) {
      index += 1;
      continue;
    }
    const provider: DshProvider = { id: providerMatch[1], models: [] };
    index += 1;
    while (index < block.end) {
      const child = lines[index];
      if (isSkippable(child)) {
        index += 1;
        continue;
      }
      const childIndent = indentOf(child);
      if (childIndent <= providersIndent + 2) break;
      const text = child.trim();
      if (childIndent === providersIndent + 4) {
        const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(text);
        if (!field) {
          index += 1;
          continue;
        }
        const key = field[1];
        const rawValue = field[2];
        if (key === 'models' && !unquoteScalar(rawValue)) {
          index += 1;
          while (index < block.end) {
            const modelLine = lines[index];
            if (isSkippable(modelLine)) {
              index += 1;
              continue;
            }
            const modelIndent = indentOf(modelLine);
            if (modelIndent <= providersIndent + 2) break;
            const modelText = modelLine.trim();
            if (modelIndent === providersIndent + 4 && !modelText.startsWith('-')) break;
            const modelMatch = /^-\s+id:\s*(.+)$/.exec(modelText);
            if (modelMatch) {
              provider.models.push({ id: unquoteScalar(modelMatch[1]) });
              index += 1;
              continue;
            }
            if (modelIndent > providersIndent + 4 && provider.models.length) {
              const last = provider.models[provider.models.length - 1];
              const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(modelText);
              if (!field) {
                index += 1;
                continue;
              }
              const fieldKey = field[1];
              const rawValue = field[2];
              if (fieldKey === 'name') {
                last.name = unquoteScalar(rawValue);
              } else if (fieldKey === 'contextWindow') {
                const parsed = Number(unquoteScalar(rawValue));
                if (Number.isFinite(parsed)) last.contextWindow = parsed;
              } else if (fieldKey === 'input' || fieldKey === 'inputModalities') {
                const inline = parseStringList(rawValue);
                if (inline.length) {
                  if (fieldKey === 'input') last.input = inline;
                  else last.inputModalities = inline;
                } else if (!unquoteScalar(rawValue)) {
                  // 块状序列：后续以 '-' 开头的行（缩进不小于本字段）是能力项
                  const items: string[] = [];
                  let cursor = index + 1;
                  while (cursor < block.end) {
                    const itemLine = lines[cursor];
                    if (isSkippable(itemLine)) {
                      cursor += 1;
                      continue;
                    }
                    if (indentOf(itemLine) < modelIndent) break;
                    const itemText = itemLine.trim();
                    if (!itemText.startsWith('-')) break;
                    const item = unquoteScalar(itemText.replace(/^-\s*/, ''));
                    if (item) items.push(item);
                    cursor += 1;
                  }
                  if (items.length) {
                    if (fieldKey === 'input') last.input = items;
                    else last.inputModalities = items;
                    index = cursor;
                    continue;
                  }
                }
              }
            }
            index += 1;
          }
          continue;
        }
        const value = unquoteScalar(rawValue);
        if (key === 'displayName') provider.displayName = value;
        else if (key === 'api') provider.api = value;
        else if (key === 'baseURL') provider.baseURL = value;
        else if (key === 'apiKeyEnv') provider.apiKeyEnv = value;
        index += 1;
        continue;
      }
      index += 1;
    }
    if (provider.models.length || provider.baseURL) providers.push(provider);
  }
  return providers;
}

/**
 * 解析 <DSH_HOME>/.credentials.yaml 的 refs 映射（dsh-credentials-local 的格式）。
 *
 * 兼容两种写法：
 *   refs:
 *     {
 *       DASHSCOPE_API_KEY: 'sk-xxx',
 *     }
 * 以及块状 map（refs: 下按 KEY: value 缩进）。
 * 值只用于发请求，绝不回显给前端。
 */
export function parseCredentialRefs(text: string): Record<string, string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^refs:\s*(#.*)?$/.test(lines[index].trim())) continue;
    let flow = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '{') {
        flow = true;
        continue;
      }
      if (trimmed === '}' || trimmed === '},') {
        flow = false;
        index = cursor;
        break;
      }
      if (!flow && indentOf(line) === 0) {
        index = cursor - 1;
        break;
      }
      const match = /^(?:-\s*)?"?([A-Za-z0-9_./-]+)"?\s*:\s*(.+?)\s*,?\s*$/.exec(trimmed);
      if (!match) continue;
      const value = unquoteScalar(match[2]);
      if (value) out[match[1]] = value;
    }
  }
  return out;
}

/**
 * dsh 的凭据引用名约定：写了 apiKeyEnv 就用它，否则 <PROVIDER_ID>_API_KEY。
 * 导出给 lib/agentModelConfig.ts 复用（只同步被引用到的 Key，推导规则必须只有一份）。
 */
export function modelKeyRef(providerId: string, apiKeyEnv?: string): string {
  const named = (apiKeyEnv || '').trim();
  if (named) return named;
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
}

function credentialRefFor(provider: DshProvider): string {
  return modelKeyRef(provider.id, provider.apiKeyEnv);
}

/** 视频提供商优先 dashscope，其次含 qwen3.8-omni-flash 的那个 */
function pickVideoProvider(providers: DshProvider[]): DshProvider | null {
  return providers.find((provider) => provider.id === VIDEO_PROVIDER_ID)
    ?? providers.find((provider) => provider.models.some((model) => model.id === VIDEO_MODEL_ID))
    ?? null;
}

function fallbackModel(providerId: string): ResolvedVideoModel {
  return {
    providerId,
    providerName: VIDEO_PROVIDER_DISPLAY_NAME,
    baseUrl: VIDEO_PROVIDER_BASE_URL,
    api: VIDEO_MODEL_API,
    model: VIDEO_MODEL_ID,
    apiKey: '',
    keyRef: VIDEO_PROVIDER_KEY_ENV,
  };
}

/** 从某个提供商里挑视频模型：优先约定的模型 id，其次它的第一个模型 */
function pickModel(provider: DshProvider): string {
  const preferred = provider.models.find((model) => model.id === VIDEO_MODEL_ID);
  return (preferred || provider.models[0])?.id || '';
}

/** 缺哪一项就点哪一项：设置页状态、任务报错与 MCP 提示共用这一个判定 */
export function missingVideoModelFields(model: ResolvedVideoModel): string[] {
  const missing: string[] = [];
  if (!model.model) missing.push('模型名');
  if (!model.baseUrl) missing.push('Base URL');
  if (model.api !== VIDEO_MODEL_API) missing.push('OpenAI 兼容协议');
  if (!model.apiKey) missing.push('API Key');
  return missing;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 解析视频理解模型（纯读文件，不启动 dsh）。
 *
 * @param home dsh 的 DSH_HOME（Engram 随包运行时是 <数据目录>/dsh）
 * @param fallback 多端同步下来的提供商与 Key：本机缺 Key（或根本没有视频提供商）时兜底，
 *                 让「另一台设备配过、这台还没同步落盘」的场景也能直接提炼视频
 */
export function resolveVideoModel(home: string, fallback: VideoModelFallback = {}): VideoModelResolution {
  const localProviders = parseDshProviders(readText(profilePatchPath(home)));
  const refs = parseCredentialRefs(readText(path.join(home, '.credentials.yaml')));
  const fallbackProviders: DshProvider[] = fallback.providers ?? [];
  const fallbackKeys: Record<string, string> = fallback.keys ?? {};

  const localProvider = pickVideoProvider(localProviders);
  const syncedProvider = localProvider ? null : pickVideoProvider(fallbackProviders);
  const provider = localProvider || syncedProvider;

  if (!provider) {
    const fallbackModelValue = fallbackModel(VIDEO_PROVIDER_ID);
    return {
      provider: fallbackModelValue,
      missing: ['视频模型提供商'],
      providerFound: false,
      configured: false,
      keySource: 'none',
    };
  }

  const keyRef = credentialRefFor(provider);
  const localKey = (refs[keyRef] || process.env[keyRef] || '').trim();
  // 本机有 provider 但缺 Key 时：优先按本机 ref 找同步 Key；对端同名 provider 若用了不同的
  // apiKeyEnv，也按它推导出的 ref 再试一次（两台设备的 dsh 设置可能不同名）
  const syncedProviderForKey = pickVideoProvider(fallbackProviders);
  const fallbackKeyRef = syncedProviderForKey ? credentialRefFor(syncedProviderForKey) : keyRef;
  const syncedKey = localKey
    ? ''
    : String(fallbackKeys[keyRef] ?? fallbackKeys[fallbackKeyRef] ?? '').trim();
  const apiKey = localKey || syncedKey;
  const keySource: VideoKeySource = localKey ? 'local' : syncedKey ? 'synced' : 'none';
  const model = pickModel(provider);
  const baseUrl = (provider.baseURL || (provider.id === VIDEO_PROVIDER_ID ? VIDEO_PROVIDER_BASE_URL : '')).trim();
  const api = (provider.api || VIDEO_MODEL_API).trim();
  const resolved: ResolvedVideoModel = {
    providerId: provider.id,
    providerName: provider.displayName || (provider.id === VIDEO_PROVIDER_ID ? VIDEO_PROVIDER_DISPLAY_NAME : provider.id),
    baseUrl,
    api,
    model: model || VIDEO_MODEL_ID,
    apiKey,
    keyRef,
  };
  const missing = missingVideoModelFields(resolved);
  return { provider: resolved, missing, providerFound: true, configured: missing.length === 0, keySource };
}

/** 预置提供商的 profile 内容（播种到 dsh 设置里；与 dsh 设置页保存的字段同名） */
export function videoProviderDefaultProfile(): Record<string, unknown> {
  return {
    displayName: VIDEO_PROVIDER_DISPLAY_NAME,
    apiKeyEnv: VIDEO_PROVIDER_KEY_ENV,
    api: VIDEO_MODEL_API,
    baseURL: VIDEO_PROVIDER_BASE_URL,
    models: [{ id: VIDEO_MODEL_ID, name: VIDEO_MODEL_ID }],
  };
}

/** 是否已经存在视频模型提供商（用于播种幂等判断；不读凭据） */
export function hasVideoProvider(home: string): boolean {
  const providers = parseDshProviders(readText(profilePatchPath(home)));
  return providers.some(
    (provider) => provider.id === VIDEO_PROVIDER_ID || provider.models.some((model) => model.id === VIDEO_MODEL_ID)
  );
}
