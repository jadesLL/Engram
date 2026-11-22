import fs from 'node:fs';
import path from 'node:path';
import { bundledDshHome } from '../assistant/config.js';
import {
  AGENT_MODEL_CONFIG_KEY,
  officialKeyRef,
  parseAgentModelConfig,
  readAgentModelConfig,
  type SyncedAgentModelConfig,
} from './agentModelConfig.js';
import { modelKeyRef } from './videoModel.js';
import { parseCredentialRefs } from './credentialsFile.js';
import { localSpeechAvailability, transcribeLocalWav } from './localSpeech.js';
import { preferenceValue } from '../sync/preferences.js';

/**
 * 编辑器「语音输入」的转写服务。
 *
 * 引擎选择（不写死任何厂商）：
 *  1. **内置 Agent 的默认模型**声明了音频输入（`input` / `inputModalities` 含 audio）→ 录音直接发给它；
 *  2. 否则用**本机离线识别**（Windows SAPI，见 lib/localSpeech.ts）——不联网、不要 Key；
 *  3. 本机没有离线识别器（Docker/Linux）→ 用客户自己配置过、且声明支持音频的模型；
 *  4. 一个都没有 → 返回可操作提示（去控制台给默认模型勾音频，或配置一个音频模型）。
 *
 * 录音只在本次请求里存在：不落盘（本机识别用的临时 WAV 也在 finally 删除）、不进同步、不进日志。
 */

/** 单次录音的体积上限（WAV 16k 单声道 16bit ≈ 32KB/s；6MB ≈ 3 分钟） */
export const SPEECH_MAX_AUDIO_BYTES = 6 * 1024 * 1024;
/** 服务端可接受的录音时长上限（前端单次录制上限 120 秒，这里留余量） */
export const SPEECH_MAX_DURATION_SEC = 180;
/** 前端展示与自动停止用：单次录音最长 120 秒 */
export const SPEECH_UI_MAX_DURATION_SEC = 120;
export const SPEECH_MAX_TOKENS = 2048;
export const SPEECH_TIMEOUT_MS = 180_000;

/** 本机离线识别的引擎 id（与模型引擎 `model:<provider>:<model>` 区分） */
export const SPEECH_LOCAL_ENGINE = 'local';

/** 官方 DeepSeek 提供商的缺省值（与 dsh 自带 bundle / SDK 兜底一致） */
const OFFICIAL_PROVIDER_ID = 'deepseek-official';
const OFFICIAL_PROVIDER_NAME = 'DeepSeek 官方';
const OFFICIAL_DEFAULT_MODEL = 'deepseek-flash';
const OFFICIAL_DEFAULT_MODALITIES = ['text', 'image'];
const OFFICIAL_BASE_URL = 'https://api.deepseek.com';

/** 转写提示词：只转写、不翻译、不解释；无人声时用固定哨兵值，服务端统一清成空串 */
const SPEECH_SYSTEM_PROMPT = [
  '你是语音转写器。把录音里的说话内容逐字转成文字：',
  '- 说话人说什么语言就写什么语言（中文写中文、英文写英文），不要翻译；',
  '- 保留语气词与自然的措辞，按语义补全标点；',
  '- 只输出转写文本本身，不要解释、总结、标题、引号、Markdown 标记或「转写：」之类的前缀；',
  '- 录音里没有可辨识的人声时，只输出 NO_SPEECH。',
].join('\n');

const NO_SPEECH_SENTINEL = 'NO_SPEECH';

export interface SpeechEngineOption {
  /** `local` 或 `model:<provider>:<model>` */
  id: string;
  kind: 'local' | 'model';
  label: string;
  detail: string;
  available: boolean;
}

export interface SpeechModelInfo {
  provider: string;
  providerName: string;
  model: string;
  modelName: string;
  /** 声明支持音频输入 */
  supportsAudio: boolean;
  /** 声明支持的输入能力（text / image / audio / video…） */
  inputs: string[];
}

export interface SpeechStatus {
  configured: boolean;
  engines: SpeechEngineOption[];
  defaultEngine: string;
  /** 为什么自动选了它（面板直接展示，用户能看懂用了谁的模型） */
  defaultEngineReason: string;
  /** 内置 Agent 当前的默认模型 */
  defaultModel: SpeechModelInfo | null;
  /** 本机离线识别是否可用 */
  localAvailable: boolean;
  localDetail: string;
  hint: string;
  maxDurationSec: number;
  maxBytes: number;
}

/** 可直接调用的音频模型（已配齐地址 / 协议 / Key） */
export interface SpeechModelCandidate {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  modalities: string[];
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function supportsAudio(modalities: string[] | undefined): boolean {
  return (modalities || []).some((value) => /audio/i.test(String(value)));
}

function keyFor(ref: string, keys: Record<string, string>): string {
  return String(keys[ref] || process.env[ref] || '').trim();
}

function modelEngineId(providerId: string, modelId: string): string {
  return `model:${providerId}:${modelId}`;
}

function isOfficialProvider(providerId: string): boolean {
  return !providerId || providerId === OFFICIAL_PROVIDER_ID || providerId === 'deepseek' || providerId === 'official';
}

/** 本机 dsh 配置优先；本机没有模型配置时用多端同步下来的那份兜底 */
function currentModelConfig(): SyncedAgentModelConfig {
  const home = bundledDshHome();
  const local = readAgentModelConfig(home);
  if (Object.keys(local.providers).length || Object.keys(local.official).length || local.default.provider) {
    return local;
  }
  try {
    const preference = preferenceValue(AGENT_MODEL_CONFIG_KEY);
    const synced = parseAgentModelConfig(preference?.value);
    if (synced && (Object.keys(synced.providers).length || Object.keys(synced.official).length || synced.default.provider)) {
      return synced;
    }
  } catch {
    /* 同步偏好不可用时按空配置处理 */
  }
  return local;
}

/** 凭据：dsh 凭据文件 → 同步配置里的 Key（环境变量在 keyFor 里兜底），绝不回显 */
function currentKeys(home: string, config: SyncedAgentModelConfig): Record<string, string> {
  const refs = parseCredentialRefs(readText(path.join(home, '.credentials.yaml')));
  const keys: Record<string, string> = {};
  for (const [ref, value] of Object.entries(refs)) {
    if (value) keys[ref] = value;
  }
  for (const [ref, value] of Object.entries(config.keys || {})) {
    if (value && !keys[ref]) keys[ref] = value;
  }
  return keys;
}

interface ModelCatalog {
  /** 内置 Agent 当前默认模型（用于展示与优先级判断） */
  defaultModel: SpeechModelInfo | null;
  /** 默认模型的完整候选（含 Key / 地址；对不上时为 null） */
  defaultCandidate: SpeechModelCandidate | null;
  /** 所有可用且声明支持音频的模型（默认提供商优先） */
  audioCandidates: SpeechModelCandidate[];
}

/** 从 dsh 模型配置里整理出「默认模型」与「音频模型候选」（纯函数，便于单测） */
export function buildSpeechCatalog(config: SyncedAgentModelConfig, keys: Record<string, string>): ModelCatalog {
  const candidates: SpeechModelCandidate[] = [];
  const official = config.official || {};
  const officialRef = officialKeyRef(official);
  const officialApiKey = keyFor(officialRef, keys);
  const officialBaseUrl = (official.baseURL || '').trim() || OFFICIAL_BASE_URL;

  for (const model of official.models || []) {
    candidates.push({
      id: modelEngineId(OFFICIAL_PROVIDER_ID, model.id),
      providerId: OFFICIAL_PROVIDER_ID,
      providerName: OFFICIAL_PROVIDER_NAME,
      modelId: model.id,
      modelName: model.name || model.id,
      baseUrl: officialBaseUrl,
      api: 'openai-completions',
      apiKey: officialApiKey,
      modalities: [...(model.inputModalities || [])],
    });
  }
  for (const [providerId, provider] of Object.entries(config.providers || {})) {
    const keyRef = modelKeyRef(providerId, provider.apiKeyEnv);
    const apiKey = keyFor(keyRef, keys);
    for (const model of provider.models || []) {
      candidates.push({
        id: modelEngineId(providerId, model.id),
        providerId,
        providerName: provider.displayName || providerId,
        modelId: model.id,
        modelName: model.name || model.id,
        baseUrl: (provider.baseURL || '').trim(),
        api: (provider.api || 'openai-completions').trim(),
        apiKey,
        modalities: [...(model.input || [])],
      });
    }
  }

  // 没保存过官方模型配置时，dsh bundle 的默认模型是 deepseek-flash（文本 + 图片）
  if (!candidates.some((item) => item.modelId === OFFICIAL_DEFAULT_MODEL) && !config.default.model) {
    candidates.push({
      id: modelEngineId(OFFICIAL_PROVIDER_ID, OFFICIAL_DEFAULT_MODEL),
      providerId: OFFICIAL_PROVIDER_ID,
      providerName: OFFICIAL_PROVIDER_NAME,
      modelId: OFFICIAL_DEFAULT_MODEL,
      modelName: OFFICIAL_DEFAULT_MODEL,
      baseUrl: officialBaseUrl,
      api: 'openai-completions',
      apiKey: officialApiKey,
      modalities: [...OFFICIAL_DEFAULT_MODALITIES],
    });
  }

  const defaultProvider = config.default.provider || OFFICIAL_PROVIDER_ID;
  const defaultModelId = config.default.model || OFFICIAL_DEFAULT_MODEL;
  const defaultCandidate =
    candidates.find(
      (item) =>
        item.modelId === defaultModelId &&
        (item.providerId === defaultProvider ||
          (isOfficialProvider(defaultProvider) && item.providerId === OFFICIAL_PROVIDER_ID))
    ) || null;
  const defaultModel: SpeechModelInfo | null = defaultCandidate
    ? {
        provider: defaultCandidate.providerId,
        providerName: defaultCandidate.providerName,
        model: defaultCandidate.modelId,
        modelName: defaultCandidate.modelName,
        supportsAudio: supportsAudio(defaultCandidate.modalities),
        inputs: defaultCandidate.modalities,
      }
    : {
        provider: defaultProvider,
        providerName: isOfficialProvider(defaultProvider) ? OFFICIAL_PROVIDER_NAME : defaultProvider,
        model: defaultModelId,
        modelName: defaultModelId,
        supportsAudio: false,
        inputs: [],
      };

  const audioCandidates = candidates
    .filter(
      (item) =>
        supportsAudio(item.modalities) &&
        Boolean(item.apiKey) &&
        Boolean(item.baseUrl) &&
        item.api === 'openai-completions'
    )
    .sort((a, b) => {
      const sameProvider = Number(b.providerId === defaultProvider) - Number(a.providerId === defaultProvider);
      if (sameProvider) return sameProvider;
      return a.providerName.localeCompare(b.providerName, 'zh-Hans-CN');
    });

  return { defaultModel, defaultCandidate, audioCandidates };
}

export interface SpeechStatusOptions {
  config?: SyncedAgentModelConfig;
  keys?: Record<string, string>;
  /** 本机离线识别的探测结果（测试注入；缺省现探） */
  local?: { available: boolean; detail: string };
}

function candidateEngine(candidate: SpeechModelCandidate): SpeechEngineOption {
  return {
    id: candidate.id,
    kind: 'model',
    label: `${candidate.providerName} · ${candidate.modelName}`,
    detail: '内置 Agent 控制台里声明的音频模型',
    available: true,
  };
}

/** 当前可用引擎 + 自动选择结果（面板与错误文案共用） */
export async function speechStatus(options: SpeechStatusOptions = {}): Promise<SpeechStatus> {
  const home = bundledDshHome();
  const config = options.config ?? currentModelConfig();
  const keys = options.keys ?? currentKeys(home, config);
  const local = options.local ?? (await localSpeechAvailability());
  const catalog = buildSpeechCatalog(config, keys);
  const defaultModel = catalog.defaultModel;

  const engines: SpeechEngineOption[] = [];
  if (local.available) {
    engines.push({
      id: SPEECH_LOCAL_ENGINE,
      kind: 'local',
      label: '本机离线识别',
      detail: local.detail,
      available: true,
    });
  }
  for (const candidate of catalog.audioCandidates) engines.push(candidateEngine(candidate));

  const defaultLabel = defaultModel
    ? `${defaultModel.providerName} · ${defaultModel.modelName}`
    : '内置 Agent 默认模型';

  let defaultEngine = '';
  let defaultEngineReason = '';
  if (
    catalog.defaultCandidate &&
    defaultModel?.supportsAudio &&
    catalog.defaultCandidate.apiKey &&
    catalog.defaultCandidate.baseUrl
  ) {
    defaultEngine = catalog.defaultCandidate.id;
    defaultEngineReason = `默认 Agent 模型「${defaultLabel}」声明支持音频输入，录音直接发给它`;
  } else if (local.available) {
    defaultEngine = SPEECH_LOCAL_ENGINE;
    const why =
      defaultModel && defaultModel.inputs.length
        ? `只声明了 ${defaultModel.inputs.join(' / ')} 输入`
        : '没有声明音频输入';
    defaultEngineReason = `默认 Agent 模型「${defaultLabel}」${why}，改用本机离线识别`;
  } else if (catalog.audioCandidates.length) {
    const candidate = catalog.audioCandidates[0];
    defaultEngine = candidate.id;
    defaultEngineReason = `本机离线识别不可用，改用你配置的「${candidate.providerName} · ${candidate.modelName}」`;
  }

  const hint = defaultEngine
    ? ''
    : '默认 Agent 模型不支持音频输入，本机也没有离线识别器：请在内置 Agent 控制台给默认模型勾上音频输入，或配置一个声明支持音频的模型';

  return {
    configured: Boolean(defaultEngine),
    engines,
    defaultEngine,
    defaultEngineReason,
    defaultModel,
    localAvailable: local.available,
    localDetail: local.detail,
    hint,
    maxDurationSec: SPEECH_UI_MAX_DURATION_SEC,
    maxBytes: SPEECH_MAX_AUDIO_BYTES,
  };
}

/** 模型没配好（不是上游故障）：路由据此回 409，前端提示去配置 */
export class SpeechUnavailableError extends Error {}

export interface TranscribeOptions {
  /** 用户在菜单里选的引擎 id；缺省用自动选择结果 */
  engine?: string;
  signal?: AbortSignal;
  /** 仅供测试注入 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 测试/调用方显式指定模型（跳过引擎解析） */
  candidate?: SpeechModelCandidate;
  /** 测试注入的引擎解析结果 */
  status?: SpeechStatus;
}

export interface TranscribeResult {
  text: string;
  /** `local` 或 `model:<provider>:<model>` */
  engine: string;
  engineLabel: string;
  model: string;
  provider: string;
}

/** 取 WAV 的时长（解析 fmt 的 byteRate 与 data 块大小；坏文件返回 0） */
export function wavDurationSec(buffer: Buffer): number {
  if (buffer.length < 44) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16);
    } else if (id === 'data') {
      const dataSize = Math.min(size, buffer.length - offset - 8);
      return byteRate > 0 ? dataSize / byteRate : 0;
    }
    offset += 8 + size + (size % 2);
  }
  return 0;
}

/** 录音是不是合法的 WAV（浏览器侧固定编码成 RIFF/WAVE，别的一律拒） */
export function isWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 44 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

/** 把上游错误压缩成一句可操作的中文（原始报文只留短片段，绝不带凭据） */
export function speechUpstreamError(status: number, rawBody: string): string {
  const body = String(rawBody || '');
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 300);
  const lower = snippet.toLowerCase();
  if (status === 401 || status === 403) {
    return '语音模型的 API Key 无效或没有权限：去 设置 → Agent 与自动化 → 内置 Agent 控制台 → 模型 检查对应提供商的 Key';
  }
  if (status === 429) {
    return '语音识别请求太频繁（或额度用尽），稍等一会儿再试';
  }
  if (status === 404 || lower.includes('model not found') || lower.includes('does not exist')) {
    return `语音模型找不到：请确认控制台里的模型名可用（${snippet || '未知响应'}）`;
  }
  if (lower.includes('input_audio') || lower.includes('audio') || lower.includes('modalities')) {
    return '当前模型不支持音频输入：请在内置 Agent 控制台给默认模型勾上音频输入，或改用本机离线识别';
  }
  return `语音识别服务返回 ${status}：${snippet || '未知错误'}`;
}

/** 逐行累积 SSE（data: {...}），返回转写文本；同时兼容网关直接回 JSON 的情况 */
async function readTranscription(response: Response): Promise<string> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!response.body || contentType.includes('application/json')) {
    const raw = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error('语音识别服务没有返回可解析的内容');
    }
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('');
    }
    throw new Error(`语音识别服务没有返回文本（${raw.replace(/\s+/g, ' ').slice(0, 200)}）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let done = false;
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json?.error) {
      throw new Error(speechUpstreamError(Number(json?.status || 502), JSON.stringify(json.error)));
    }
    const choice = json?.choices?.[0];
    const delta = choice?.delta ?? choice?.message;
    const content = delta?.content;
    if (typeof content === 'string') text += content;
    else if (Array.isArray(content)) {
      for (const block of content) if (typeof block?.text === 'string') text += block.text;
    }
  };

  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    let index = buffer.indexOf('\n\n');
    while (index >= 0 && !done) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of event.split('\n')) consume(line);
      index = buffer.indexOf('\n\n');
    }
  }
  if (!done && buffer.trim()) {
    for (const line of buffer.split('\n')) consume(line);
  }
  try {
    await reader.cancel();
  } catch {
    /* 已读完 */
  }
  return text;
}

/** 成对引号（中英文）与反引号：只在整段被包住时剥一层，正文里的引号不动 */
const WRAPPING_QUOTES: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
];

/**
 * 清掉模型常见的包装：代码围栏、整段引号、「转写：」前缀；无人声哨兵值归空串。
 * 只在首尾动手，不改正文里的标点与措辞。
 */
export function cleanTranscript(raw: string): string {
  let text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  if (text === NO_SPEECH_SENTINEL || text.toLowerCase() === NO_SPEECH_SENTINEL.toLowerCase()) return '';
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  for (const [open, close] of WRAPPING_QUOTES) {
    if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length).trim();
      if (inner) text = inner;
      break;
    }
  }
  text = text.replace(/^\s*(?:转写|识别|听写)(?:结果|文本|内容)?\s*[:：]\s*/, '');
  text = text.replace(/^[（(](?:无|没有|未检测到)[^）)]*(?:语音|人声|音频)[^）)]*[）)]$/, '');
  return text.trim();
}

function abortWith(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  // 统一用无 reason 的 abort：fetch 才会以 AbortError 拒绝（自定义 reason 会原样抛出，难区分超时与网络错误）
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forward = () => controller.abort();
  if (outer) {
    if (outer.aborted) forward();
    else outer.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', forward);
    },
  };
}

export interface ModelTranscribeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 把录音发给一个声明支持音频的模型（OpenAI 兼容 chat/completions + input_audio） */
export async function transcribeWithModel(
  audio: Buffer,
  candidate: SpeechModelCandidate,
  options: ModelTranscribeOptions = {}
): Promise<TranscribeResult> {
  if (!candidate.apiKey) {
    throw new SpeechUnavailableError(`「${candidate.providerName} · ${candidate.modelName}」还没有配置 API Key`);
  }
  if (candidate.api !== 'openai-completions') {
    throw new SpeechUnavailableError('语音识别需要 OpenAI 兼容接口：请在内置 Agent 控制台把该提供商的协议改为 OpenAI 兼容');
  }
  const url = joinUrl(candidate.baseUrl, '/chat/completions');
  const body = {
    model: candidate.modelId,
    messages: [
      { role: 'system', content: SPEECH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: `data:audio/wav;base64,${audio.toString('base64')}`,
              format: 'wav',
            },
          },
          { type: 'text', text: '转写这段录音。' },
        ],
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0,
    max_tokens: SPEECH_MAX_TOKENS,
  };

  const fetchImpl = options.fetchImpl ?? fetch;
  const { signal, done } = abortWith(options.timeoutMs ?? SPEECH_TIMEOUT_MS, options.signal);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${candidate.apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error: any) {
    done();
    if (error?.name === 'AbortError') {
      throw new Error(options.signal?.aborted ? '转写已取消' : '语音识别超时了，请缩短录音后重试');
    }
    throw new Error(`连不上语音识别服务：${error?.message || '网络错误'}（检查中枢网络或代理）`);
  }

  try {
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(speechUpstreamError(response.status, raw));
    }
    const raw = await readTranscription(response);
    const cleaned = cleanTranscript(raw);
    if (!cleaned) throw new Error('没有识别到语音：请靠近麦克风、说清楚一点再试');
    return {
      text: cleaned,
      engine: candidate.id,
      engineLabel: `${candidate.providerName} · ${candidate.modelName}`,
      model: candidate.modelId,
      provider: candidate.providerId,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('语音识别超时了，请缩短录音后重试');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    done();
  }
}

/**
 * 转写一段 WAV 录音：按用户选择的引擎（或自动选择结果）走本机离线识别 / 模型。
 * 没配好抛 SpeechUnavailableError（路由回 409），上游失败抛带可读中文的 Error（路由回 502）。
 */
export async function transcribeAudio(
  audio: Buffer,
  options: TranscribeOptions = {}
): Promise<TranscribeResult> {
  if (options.candidate) return transcribeWithModel(audio, options.candidate, options);
  const status = options.status ?? (await speechStatus());
  if (!status.configured) throw new SpeechUnavailableError(status.hint);
  const wanted =
    options.engine && status.engines.some((engine) => engine.id === options.engine)
      ? options.engine
      : status.defaultEngine;
  if (wanted === SPEECH_LOCAL_ENGINE) {
    const { text } = await transcribeLocalWav(audio);
    const cleaned = cleanTranscript(text);
    if (!cleaned) throw new Error('没有识别到语音：请靠近麦克风、说清楚一点再试');
    return {
      text: cleaned,
      engine: SPEECH_LOCAL_ENGINE,
      engineLabel: '本机离线识别',
      model: '',
      provider: '',
    };
  }
  const config = currentModelConfig();
  const keys = currentKeys(bundledDshHome(), config);
  const candidate = buildSpeechCatalog(config, keys).audioCandidates.find((item) => item.id === wanted);
  if (!candidate) {
    throw new SpeechUnavailableError('选中的语音模型已经不可用了：请回语音输入菜单重新选择，或改用本机离线识别');
  }
  return transcribeWithModel(audio, candidate, options);
}
