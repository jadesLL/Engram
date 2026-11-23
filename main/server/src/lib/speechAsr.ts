import { getSetting, setSetting } from './db.js';

/**
 * 专用语音识别模型（ASR）的配置存储。
 *
 * 为什么不复用内置 Agent（dsh）的模型配置：ASR 的接口形态不是 chat/completions
 * （OpenAI 兼容转写接口、DashScope 原生 multimodal-generation 等），dsh 的模型页配不进去。
 * Engram 因此单独维护一份「语音输入专用」的 ASR 配置：
 *
 *  - 只存一份设置 `speech_asr_config`（JSON），随「设置」分类同步给群组内设备；
 *  - **API Key 不回显**：对前端的公开结构只有 hasKey，原文只用于服务端发请求；
 *  - 不写日志、不写 dsh 的凭据文件；清理时连 Key 一起清掉。
 *
 * 支持四类接口（都是客户自己填地址 / 模型 / Key）：
 *  1. OpenAI 兼容转写接口（`/audio/transcriptions`，Whisper / SiliconFlow / 自建服务）；
 *  2. OpenAI 兼容对话接口（`/chat/completions` + input_audio，支持音频输入的对话模型）；
 *  3. 阿里云百炼原生接口，Qwen-Audio-ASR 形态（content 用 input_audio）；
 *  4. 阿里云百炼原生接口，Qwen3-ASR 形态（content 用 audio）。
 */

export const SPEECH_ASR_CONFIG_KEY = 'speech_asr_config';
/** 引擎 id（与模型引擎 `model:<provider>:<model>`、本机引擎 `local` 区分） */
export const SPEECH_ASR_ENGINE = 'asr';
/** 配置值上限：四个短字段 + 一个 Key，远小于同步偏好的 256KB 上限 */
export const SPEECH_ASR_CONFIG_MAX_BYTES = 16 * 1024;

export type SpeechAsrProtocol =
  | 'openai-transcriptions'
  | 'openai-chat-audio'
  | 'dashscope-audio'
  | 'dashscope-qwen3';

export interface SpeechAsrConfig {
  version: 1;
  protocol: SpeechAsrProtocol;
  /** Base URL 或完整接口地址（两种都接受） */
  baseUrl: string;
  model: string;
  /** 界面展示名，可空（默认「专用语音识别」） */
  name: string;
  /** 明文 Key：只在服务端内存 / 同步偏好里流转，任何接口都不回显 */
  apiKey: string;
}

/** 协议元信息（前端渲染选项与占位提示，只在这里维护一份） */
export interface SpeechAsrProtocolMeta {
  id: SpeechAsrProtocol;
  label: string;
  hint: string;
  baseUrlPlaceholder: string;
  modelPlaceholder: string;
  /** 该协议通常必须有 Key（自建服务可能不需要，前端只用于提示） */
  keyExpected: boolean;
}

export const SPEECH_ASR_PROTOCOLS: SpeechAsrProtocolMeta[] = [
  {
    id: 'openai-transcriptions',
    label: 'OpenAI 兼容 · 转写接口',
    hint: '按 /audio/transcriptions 上传 WAV；适合 OpenAI Whisper、SiliconFlow、Groq、自建 Whisper 服务。',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    modelPlaceholder: 'whisper-1',
    keyExpected: true,
  },
  {
    id: 'openai-chat-audio',
    label: 'OpenAI 兼容 · 对话接口',
    hint: '按 /chat/completions 发送音频块；适合声明支持音频输入的对话模型（如 Qwen3-ASR-Flash）。',
    baseUrlPlaceholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelPlaceholder: 'qwen3-asr-flash',
    keyExpected: true,
  },
  {
    id: 'dashscope-audio',
    label: '阿里云百炼 · Qwen-Audio-ASR',
    hint: '原生 multimodal-generation 接口，音频按 input_audio 传入；适合 Qwen-Audio-3.1-ASR-Flash。',
    baseUrlPlaceholder: 'https://dashscope.aliyuncs.com',
    modelPlaceholder: 'qwen-audio-3.1-asr-flash',
    keyExpected: true,
  },
  {
    id: 'dashscope-qwen3',
    label: '阿里云百炼 · Qwen3-ASR',
    hint: '原生 multimodal-generation 接口，音频按 audio 字段传入；适合 Qwen3-ASR-Flash。',
    baseUrlPlaceholder: 'https://dashscope.aliyuncs.com',
    modelPlaceholder: 'qwen3-asr-flash',
    keyExpected: true,
  },
];

const PROTOCOL_IDS = new Set<string>(SPEECH_ASR_PROTOCOLS.map((item) => item.id));

export function asrProtocolMeta(protocol: SpeechAsrProtocol): SpeechAsrProtocolMeta {
  return SPEECH_ASR_PROTOCOLS.find((item) => item.id === protocol) || SPEECH_ASR_PROTOCOLS[0];
}

function readText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return Boolean(url.host);
  } catch {
    return false;
  }
}

function normalizeProtocol(value: unknown): SpeechAsrProtocol | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return PROTOCOL_IDS.has(text) ? (text as SpeechAsrProtocol) : null;
}

/** 已存配置的容错解析：坏 JSON / 缺地址 / 缺模型一律按「没有配置」处理，不抛 */
function normalizeStored(value: unknown): SpeechAsrConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const protocol = normalizeProtocol(raw.protocol);
  const baseUrl = readText(raw.baseUrl, 500).replace(/\/+$/, '');
  const model = readText(raw.model, 200);
  if (!protocol || !baseUrl || !model || !isHttpUrl(baseUrl)) return null;
  return {
    version: 1,
    protocol,
    baseUrl,
    model,
    name: readText(raw.name, 60),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, 4096) : '',
  };
}

/**
 * 读已配置的专用 ASR（没有 / 不完整时返回 null）。
 * DB 还没迁移（单测直接调 lib）时按「没有配置」处理，不能让状态查询把面板打挂。
 */
export function getSpeechAsrConfig(): SpeechAsrConfig | null {
  let raw: string | undefined;
  try {
    raw = getSetting(SPEECH_ASR_CONFIG_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return normalizeStored(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 完整配置的展示字段（Key 只留 hasKey，绝不回显） */
export interface SpeechAsrPublic {
  configured: boolean;
  protocol: SpeechAsrProtocol;
  protocolLabel: string;
  baseUrl: string;
  endpoint: string;
  model: string;
  name: string;
  /** 引擎菜单 / 自动选择原因里的名字：`显示名 · 模型名` */
  label: string;
  hasKey: boolean;
}

export function speechAsrPublic(config = getSpeechAsrConfig()): SpeechAsrPublic {
  if (!config) {
    const protocol = SPEECH_ASR_PROTOCOLS[0];
    return {
      configured: false,
      protocol: protocol.id,
      protocolLabel: protocol.label,
      baseUrl: '',
      endpoint: '',
      model: '',
      name: '',
      label: '',
      hasKey: false,
    };
  }
  const meta = asrProtocolMeta(config.protocol);
  return {
    configured: true,
    protocol: config.protocol,
    protocolLabel: meta.label,
    baseUrl: config.baseUrl,
    endpoint: asrEndpoint(config.protocol, config.baseUrl),
    model: config.model,
    name: config.name,
    label: `${config.name || '专用语音识别'} · ${config.model}`,
    hasKey: Boolean(config.apiKey),
  };
}

/**
 * 由 Base URL（或完整接口地址）得到真正的请求地址。
 * 客户既可以只填域名，也可以粘贴完整接口：两种都认，不重复拼路径。
 */
export function asrEndpoint(protocol: SpeechAsrProtocol, baseUrl: string): string {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (protocol === 'openai-transcriptions') {
    return /\/audio\/transcriptions$/i.test(base) ? base : `${base}/audio/transcriptions`;
  }
  if (protocol === 'openai-chat-audio') {
    return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  }
  if (/\/multimodal-generation\/generation$/i.test(base)) return base;
  if (/\/api\/v1$/i.test(base)) return `${base}/services/aigc/multimodal-generation/generation`;
  return `${base}/api/v1/services/aigc/multimodal-generation/generation`;
}

export interface SpeechAsrSaveResult {
  ok: boolean;
  error?: string;
  config?: SpeechAsrConfig;
  changed?: boolean;
}

/**
 * 解析并保存配置（PUT /api/speech/asr-config）。
 *
 * - `apiKey` 省略 = 保留原 Key（面板不回显，未编辑时不能把 Key 顶掉）；
 * - `apiKey: ''` 或 `clearKey: true` = 清空 Key；
 * - baseUrl / model / protocol 必填；校验不过返回可读中文，不写入。
 */
export function saveSpeechAsrConfig(input: unknown): SpeechAsrSaveResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '配置格式不对：需要 JSON 对象' };
  }
  const raw = input as Record<string, unknown>;
  const previous = getSpeechAsrConfig();
  // protocol 显式传了就必须合法；没传才沿用旧配置（部分更新）
  const hasProtocol = typeof raw.protocol === 'string' && raw.protocol.trim().length > 0;
  const protocol = hasProtocol ? normalizeProtocol(raw.protocol) : previous?.protocol || null;
  if (!protocol) return { ok: false, error: '请选择接口类型' };
  const baseUrl = (typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : previous?.baseUrl || '').replace(/\/+$/, '');
  const model = typeof raw.model === 'string' ? raw.model.trim() : previous?.model || '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : previous?.name || '';
  if (!baseUrl) return { ok: false, error: '请填写接口地址（Base URL 或完整接口地址）' };
  if (!isHttpUrl(baseUrl)) return { ok: false, error: '接口地址要以 http:// 或 https:// 开头' };
  if (!model) return { ok: false, error: '请填写模型名' };
  if (baseUrl.length > 500) return { ok: false, error: '接口地址太长了（上限 500 字符）' };
  if (model.length > 200) return { ok: false, error: '模型名太长了（上限 200 字符）' };
  if (name.length > 60) return { ok: false, error: '显示名称太长了（上限 60 字符）' };
  if (/[\r\n]/.test(baseUrl) || /[\r\n]/.test(model) || /[\r\n]/.test(name)) {
    return { ok: false, error: '接口地址、模型名和显示名称都不能包含换行' };
  }
  let apiKey = previous?.apiKey || '';
  if (raw.clearKey === true) apiKey = '';
  else if (typeof raw.apiKey === 'string') apiKey = raw.apiKey.trim();
  if (apiKey.length > 4096) return { ok: false, error: 'API Key 太长了（上限 4096 字符）' };
  if (/[\r\n]/.test(apiKey)) return { ok: false, error: 'API Key 不能包含换行' };

  const next: SpeechAsrConfig = { version: 1, protocol, baseUrl, model, name, apiKey };
  const before = previous ? JSON.stringify(previous) : '';
  const after = JSON.stringify(next);
  if (after === before) return { ok: true, config: next, changed: false };
  setSetting(SPEECH_ASR_CONFIG_KEY, after);
  return { ok: true, config: next, changed: true };
}

/** 清空配置（含 Key）。返回是否真的改了。 */
export function clearSpeechAsrConfig(): boolean {
  const previous = getSpeechAsrConfig();
  if (!previous) return false;
  setSetting(SPEECH_ASR_CONFIG_KEY, '');
  return true;
}

/** 给设置页的下拉选项（不含任何敏感值） */
export function speechAsrProtocolOptions(): SpeechAsrProtocolMeta[] {
  return SPEECH_ASR_PROTOCOLS.map((item) => ({ ...item }));
}
