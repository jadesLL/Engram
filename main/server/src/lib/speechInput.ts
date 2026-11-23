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
import {
  localSpeechRuntime,
  transcribeLocalWav,
  wavAudioLevel,
  type LocalSpeechEngine,
  type LocalSpeechRuntime,
} from './localSpeech.js';
import type { SenseVoiceStatus } from './senseVoice.js';
import { SENSEVOICE_TOTAL_BYTES } from './senseVoiceAssets.js';
import { preferenceValue } from '../sync/preferences.js';
import {
  SPEECH_ASR_ENGINE,
  getSpeechAsrConfig,
  speechAsrPublic,
  type SpeechAsrConfig,
  type SpeechAsrPublic,
} from './speechAsr.js';
import { transcribeWithAsr } from './speechAsrClient.js';
import { abortWith } from './speechHttp.js';
import { SPEECH_SYSTEM_PROMPT, cleanTranscript } from './speechText.js';

// 兼容既有调用方：cleanTranscript 从 speechText 单独成模块后仍从 speechInput 导出
export { cleanTranscript } from './speechText.js';

/**
 * 编辑器「语音输入」的转写服务。
 *
 * 引擎选择（不写死任何厂商）：
 *  0. **客户配置的专用 ASR**（设置 → 外设接入 → 语音输入）→ 最快，优先使用；
 *  1. **内置 Agent 的默认模型**声明了音频输入（`input` / `inputModalities` 含 audio）→ 录音直接发给它；
 *  2. 否则用用户**配置过的音频模型**（声明了音频，或模型名明确是 omni / audio / voice 这类多模态模型）；
 *  3. 都没有才用**本机离线识别**：优先 SenseVoice（随包 sherpa-onnx，模型需用户点下载），
 *     模型没准备好时退回 Windows SAPI 兼容模式；不联网、不要 Key；
 *  4. 一个都没有 → 返回可操作提示（下载本机模型 / 配置一个音频模型）。
 *
 * 为什么专用 ASR 排最前：omni 这类多模态对话模型要把整段音频先「理解」一遍，速度明显慢；
 * 专用 ASR 的接口就是为转写设计的，出字更快。dsh 的模型页配不了这类接口（协议不是 chat/completions），
 * 所以 Engram 自己维护一份 ASR 配置（见 lib/speechAsr.ts）。
 *
 * 为什么本机不再默认 SAPI：SAPI 的 DictationGrammar 对真实麦克风的长句经常只回几个字
 * （用户实测 5 秒录音多次返回「没有识别到语音」）。SenseVoice 在同一段录音上整句带标点全对。
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

/**
 * 平均音量低于这个值（满幅 1）基本可以判定这段录音没采到人声：
 * 直接提示检查麦克风，别让用户对着静音反复重试。
 */
export const SPEECH_SILENT_RMS = 0.004;
/** 低于这个平均音量即使识别不出来，也把「音量偏低」写进提示 */
export const SPEECH_LOW_VOLUME_RMS = 0.02;

/** 官方 DeepSeek 提供商的缺省值（与 dsh 自带 bundle / SDK 兜底一致） */
const OFFICIAL_PROVIDER_ID = 'deepseek-official';
const OFFICIAL_PROVIDER_NAME = 'DeepSeek 官方';
const OFFICIAL_DEFAULT_MODEL = 'deepseek-flash';
const OFFICIAL_DEFAULT_MODALITIES = ['text', 'image'];
const OFFICIAL_BASE_URL = 'https://api.deepseek.com';

/** 音频能力来源：控制台声明 / 模型名推断 / 不支持 */
export type SpeechAudioSupport = 'declared' | 'inferred' | 'none';

/**
 * 模型名 / 显示名是否明确指向「能听音频」的模型（omni / audio / voice / speech / realtime…）。
 *
 * 为什么需要：控制台里的第三方模型常常只填 id / name，不填 input 能力；这类模型
 * （例如 qwen-omni）以前会被当成纯文本模型，语音输入被静默降级到本机 SAPI。
 * 只在**没有声明** input 时用名字兜底；显式声明永远优先。
 */
export function inferAudioSupport(id: string, name = ''): boolean {
  const text = `${id} ${name}`;
  return /(?:^|[^a-z0-9])(omni|audio|voice|speech|asr|whisper|transcri(?:be|ption)|realtime)(?:$|[^a-z0-9])/i.test(text)
    || /语音|音频|听写/.test(text);
}

export interface SpeechEngineOption {
  /** `asr`、`local` 或 `model:<provider>:<model>` */
  id: string;
  kind: 'asr' | 'local' | 'model';
  label: string;
  detail: string;
  available: boolean;
  /** 模型引擎的音频能力来源（本机引擎与专用 ASR 不填） */
  audioSupport?: SpeechAudioSupport;
}

export interface SpeechModelInfo {
  provider: string;
  providerName: string;
  model: string;
  modelName: string;
  /** 声明或模型名推断支持音频输入 */
  supportsAudio: boolean;
  /** 音频能力来源 */
  audioSupport: SpeechAudioSupport;
  /** 声明支持的输入能力（text / image / audio / video…） */
  inputs: string[];
}

export interface SpeechStatus {
  configured: boolean;
  engines: SpeechEngineOption[];
  defaultEngine: string;
  /** 为什么自动选了它（面板直接展示，用户能看懂用了谁的模型） */
  defaultEngineReason: string;
  /** 客户配置的专用 ASR（不含 Key，只给 hasKey） */
  asr: SpeechAsrPublic;
  /** 内置 Agent 当前的默认模型 */
  defaultModel: SpeechModelInfo | null;
  /** 本机离线识别是否可用 */
  localAvailable: boolean;
  localDetail: string;
  /** 本机识别引擎：SenseVoice / Windows SAPI 兼容 / 无 */
  localEngine: LocalSpeechEngine;
  /** 本机识别引擎名（菜单直接展示） */
  localLabel: string;
  /** SenseVoice 模型状态（是否支持 / 是否就绪 / 下载进度） */
  localModel: SenseVoiceStatus;
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
  /** 声明 / 模型名推断 / 不支持 */
  audioSupport: SpeechAudioSupport;
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

/** 声明优先；没有声明（空输入列表）时才按模型名推断 */
function audioSupportOf(id: string, name: string | undefined, modalities: string[]): SpeechAudioSupport {
  if (supportsAudio(modalities)) return 'declared';
  if (!modalities.length && inferAudioSupport(id, name || '')) return 'inferred';
  return 'none';
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
  /** 所有可用且能听音频的模型（声明优先、默认提供商优先） */
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
    const modalities = [...(model.inputModalities || [])];
    candidates.push({
      id: modelEngineId(OFFICIAL_PROVIDER_ID, model.id),
      providerId: OFFICIAL_PROVIDER_ID,
      providerName: OFFICIAL_PROVIDER_NAME,
      modelId: model.id,
      modelName: model.name || model.id,
      baseUrl: officialBaseUrl,
      api: 'openai-completions',
      apiKey: officialApiKey,
      modalities,
      audioSupport: audioSupportOf(model.id, model.name, modalities),
    });
  }
  for (const [providerId, provider] of Object.entries(config.providers || {})) {
    const keyRef = modelKeyRef(providerId, provider.apiKeyEnv);
    const apiKey = keyFor(keyRef, keys);
    for (const model of provider.models || []) {
      const modalities = [...(model.input || [])];
      candidates.push({
        id: modelEngineId(providerId, model.id),
        providerId,
        providerName: provider.displayName || providerId,
        modelId: model.id,
        modelName: model.name || model.id,
        baseUrl: (provider.baseURL || '').trim(),
        api: (provider.api || 'openai-completions').trim(),
        apiKey,
        modalities,
        audioSupport: audioSupportOf(model.id, model.name, modalities),
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
      audioSupport: audioSupportOf(OFFICIAL_DEFAULT_MODEL, OFFICIAL_DEFAULT_MODEL, OFFICIAL_DEFAULT_MODALITIES),
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
        supportsAudio: defaultCandidate.audioSupport !== 'none',
        audioSupport: defaultCandidate.audioSupport,
        inputs: defaultCandidate.modalities,
      }
    : {
        provider: defaultProvider,
        providerName: isOfficialProvider(defaultProvider) ? OFFICIAL_PROVIDER_NAME : defaultProvider,
        model: defaultModelId,
        modelName: defaultModelId,
        supportsAudio: false,
        audioSupport: 'none',
        inputs: [],
      };

  const audioCandidates = candidates
    .filter(
      (item) =>
        item.audioSupport !== 'none' &&
        Boolean(item.apiKey) &&
        Boolean(item.baseUrl) &&
        item.api === 'openai-completions'
    )
    .sort((a, b) => {
      // 明确声明音频的排在「按模型名推断」前面；同类里默认提供商优先
      if (a.audioSupport !== b.audioSupport) return a.audioSupport === 'declared' ? -1 : 1;
      const sameProvider = Number(b.providerId === defaultProvider) - Number(a.providerId === defaultProvider);
      if (sameProvider) return sameProvider;
      return a.providerName.localeCompare(b.providerName, 'zh-Hans-CN');
    });

  return { defaultModel, defaultCandidate, audioCandidates };
}

export interface SpeechStatusOptions {
  config?: SyncedAgentModelConfig;
  keys?: Record<string, string>;
  /** 专用 ASR 配置（测试注入；缺省读设置 speech_asr_config） */
  asr?: SpeechAsrConfig | null;
  /** 本机识别的探测结果（测试注入；缺省现探） */
  local?: {
    available: boolean;
    detail: string;
    engine?: LocalSpeechEngine;
    label?: string;
    model?: SenseVoiceStatus;
  };
}

/** 测试/旧调用只传 available + detail 时，补一个最小可用的模型状态 */
function normalizeLocal(
  local: NonNullable<SpeechStatusOptions['local']>
): LocalSpeechRuntime {
  const engine: LocalSpeechEngine = local.engine ?? (local.available ? 'sapi' : 'none');
  const ready = engine === 'sensevoice';
  return {
    available: local.available,
    engine,
    label:
      local.label
      ?? (engine === 'sensevoice'
        ? '本机离线识别（SenseVoice）'
        : engine === 'sapi'
          ? 'Windows 语音识别（兼容模式）'
          : '本机离线识别'),
    detail: local.detail,
    model: local.model ?? {
      supported: ready,
      platform: `${process.platform}-${process.arch}`,
      ready,
      phase: ready ? 'ready' : 'missing',
      downloadedBytes: ready ? SENSEVOICE_TOTAL_BYTES : 0,
      totalBytes: SENSEVOICE_TOTAL_BYTES,
      currentFile: '',
      error: '',
      modelRoot: '',
      sources: [],
      nodeAvailable: true,
    },
  };
}

function candidateEngine(candidate: SpeechModelCandidate): SpeechEngineOption {
  return {
    id: candidate.id,
    kind: 'model',
    label: `${candidate.providerName} · ${candidate.modelName}`,
    detail:
      candidate.audioSupport === 'declared'
        ? '内置 Agent 控制台里声明了音频输入'
        : '模型名表明支持音频（未声明；不支持时会自动回退本机识别）',
    available: true,
    audioSupport: candidate.audioSupport,
  };
}

/** 当前可用引擎 + 自动选择结果（面板与错误文案共用） */
export async function speechStatus(options: SpeechStatusOptions = {}): Promise<SpeechStatus> {
  const home = bundledDshHome();
  const config = options.config ?? currentModelConfig();
  const keys = options.keys ?? currentKeys(home, config);
  const local = options.local ? normalizeLocal(options.local) : await localSpeechRuntime();
  const catalog = buildSpeechCatalog(config, keys);
  const defaultModel = catalog.defaultModel;
  const asrConfig = options.asr !== undefined ? options.asr : getSpeechAsrConfig();
  const asr = speechAsrPublic(asrConfig);

  const engines: SpeechEngineOption[] = [];
  if (asrConfig && asr.configured) {
    let host = '';
    try {
      host = new URL(asrConfig.baseUrl).host;
    } catch {
      host = asrConfig.baseUrl;
    }
    engines.push({
      id: SPEECH_ASR_ENGINE,
      kind: 'asr',
      label: asr.label,
      detail: `${asr.protocolLabel} · ${host}`,
      available: true,
    });
  }
  engines.push(...catalog.audioCandidates.map(candidateEngine));
  if (local.available) {
    engines.push({
      id: SPEECH_LOCAL_ENGINE,
      kind: 'local',
      label: local.label,
      detail: local.detail,
      available: true,
    });
  }

  const defaultLabel = defaultModel
    ? `${defaultModel.providerName} · ${defaultModel.modelName}`
    : '内置 Agent 默认模型';
  const candidateLabel = (candidate: SpeechModelCandidate) =>
    `你配置的「${candidate.providerName} · ${candidate.modelName}」`;

  let defaultEngine = '';
  let defaultEngineReason = '';
  const defaultId = catalog.defaultCandidate?.id || '';
  // 只有同时满足「能听音频 + 地址/Key/协议可用」的默认模型才能真正发音频；
  // 只声明了音频但协议不是 OpenAI 兼容 / 没 Key 时，不能算 configured。
  const usableDefault = defaultId
    ? catalog.audioCandidates.find((item) => item.id === defaultId) ?? null
    : null;
  /** 默认模型为什么不能直接发音频（写进面板，用户能看懂） */
  const whyDefaultUnusable = (() => {
    if (!defaultModel) return '没有声明音频输入';
    if (defaultModel.audioSupport === 'none') {
      return defaultModel.inputs.length ? `只声明了 ${defaultModel.inputs.join(' / ')} 输入` : '没有声明音频输入';
    }
    if (!catalog.defaultCandidate) return '接口地址或 Key 还没配好';
    if (catalog.defaultCandidate.api !== 'openai-completions') return '协议不是 OpenAI 兼容，发不了音频';
    if (!catalog.defaultCandidate.apiKey) return '还没配置 API Key';
    if (!catalog.defaultCandidate.baseUrl) return '还没配置接口地址';
    return '当前配置不完整';
  })();
  const declared = catalog.audioCandidates.filter((item) => item.audioSupport === 'declared');
  const inferred = catalog.audioCandidates.filter((item) => item.audioSupport === 'inferred');

  if (asrConfig && asr.configured) {
    // 专用 ASR 是客户为「语音输入」显式配置的引擎：优先于多模态对话模型（出字更快）
    defaultEngine = SPEECH_ASR_ENGINE;
    defaultEngineReason = `已配置专用语音识别模型「${asr.label}」，优先使用（专用转写接口比多模态模型更快）`;
  } else if (usableDefault) {
    defaultEngine = usableDefault.id;
    defaultEngineReason =
      usableDefault.audioSupport === 'declared'
        ? `默认 Agent 模型「${defaultLabel}」声明支持音频输入，录音直接发给它`
        : `默认 Agent 模型「${defaultLabel}」的模型名表明支持音频输入，录音直接发给它（未在控制台声明，不支持时会自动回退本机识别）`;
  } else if (declared.length) {
    // 用户配置过明确的音频模型：优先用它，不要静默落到识别质量受限的本机 SAPI
    const candidate = declared[0];
    defaultEngine = candidate.id;
    defaultEngineReason = `默认 Agent 模型「${defaultLabel}」${whyDefaultUnusable}，改用${candidateLabel(candidate)}（已声明支持音频输入）`;
  } else if (inferred.length) {
    const candidate = inferred[0];
    defaultEngine = candidate.id;
    defaultEngineReason = `默认 Agent 模型「${defaultLabel}」${whyDefaultUnusable}，改用${candidateLabel(candidate)}（模型名表明支持音频）`;
  } else if (local.available) {
    defaultEngine = SPEECH_LOCAL_ENGINE;
    const compat = local.engine === 'sapi'
      ? '；当前是 Windows 兼容模式，准确率有限，建议下载 SenseVoice 模型'
      : '';
    defaultEngineReason = `默认 Agent 模型「${defaultLabel}」${whyDefaultUnusable}，没有可用的音频模型，改用「${local.label}」（不联网、不要 Key${compat}）`;
  }

  const hint = defaultEngine
    ? ''
    : local.model.supported
      ? '本机识别模型还没下载（约 240MB）：在语音输入菜单点「下载模型」，或到 设置 → 外设接入 → 语音输入；也可以在内置 Agent 控制台配置一个支持音频输入的模型'
      : '没有可用的识别引擎：到 设置 → 外设接入 → 语音输入 配置专用 ASR / 下载本机模型，或在内置 Agent 控制台配置一个声明支持音频的模型';

  return {
    configured: Boolean(defaultEngine),
    engines,
    defaultEngine,
    defaultEngineReason,
    asr,
    defaultModel,
    localAvailable: local.available,
    localDetail: local.detail,
    localEngine: local.engine,
    localLabel: local.label,
    localModel: local.model,
    hint,
    maxDurationSec: SPEECH_UI_MAX_DURATION_SEC,
    maxBytes: SPEECH_MAX_AUDIO_BYTES,
  };
}

/** 模型没配好（不是上游故障）：路由据此回 409，前端提示去配置 */
export class SpeechUnavailableError extends Error {}

/** 上游明确拒绝音频输入：只有「按模型名推断」的引擎会自动回退本机识别 */
export class SpeechAudioUnsupportedError extends Error {}

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
  /** 测试注入的模型配置（缺省读本机 dsh 配置） */
  config?: SyncedAgentModelConfig;
  /** 测试注入的凭据（缺省读 dsh 凭据文件） */
  keys?: Record<string, string>;
  /** 专用 ASR 配置（测试注入；缺省读设置 speech_asr_config） */
  asr?: SpeechAsrConfig | null;
  /** 测试注入的本机识别实现 */
  localTranscribe?: (wav: Buffer) => Promise<{ text: string; culture: string }>;
}

export interface TranscribeResult {
  text: string;
  /** `asr`、`local` 或 `model:<provider>:<model>` */
  engine: string;
  engineLabel: string;
  model: string;
  provider: string;
  /** 需要让用户知道的情况（自动回退、本机识别结果过短），界面在插入后提示 */
  warning?: string;
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

/** 上游是不是在说「我不收音频」（400/422 且报文提到 audio / input_audio / modalities） */
function audioUnsupported(status: number, rawBody: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const lower = String(rawBody || '').toLowerCase();
  return lower.includes('input_audio') || lower.includes('audio') || lower.includes('modalities');
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
      const message = speechUpstreamError(response.status, raw);
      if (audioUnsupported(response.status, raw)) throw new SpeechAudioUnsupportedError(message);
      throw new Error(message);
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

function volumePercent(rms: number): string {
  const percent = Math.round(rms * 100);
  return percent < 1 ? '不到 1%' : `${percent}%`;
}

/** 录音几乎是静音：问题在麦克风/采集，不在识别引擎，别让用户反复重试 */
export function silentRecordingMessage(rms: number): string {
  return (
    `录音几乎没有声音（平均音量 ${volumePercent(rms)}）：麦克风可能选错了、被静音，`
    + '或者远程串流用的虚拟麦克风没在采集。'
    + '点语音输入的「选项」换一个麦克风，或检查系统声音设置后重试。'
  );
}

/** 有声音但识别不出来；音量明显偏低时把这一点一并说出来 */
export function noSpeechMessage(rms?: number): string {
  const low = rms !== undefined && rms < SPEECH_LOW_VOLUME_RMS
    ? `（这段录音平均音量只有 ${volumePercent(rms)}，麦克风可能离得太远或被静音）`
    : '';
  return `没有识别到语音${low}：请靠近麦克风、说清楚一点再试`;
}

/**
 * 本机 SAPI 对长录音只回几个字：明确提示结果可能不准，别让用户以为「就是这两个字」。
 * 阈值取 5 秒 / 4 个字：短录音说「好」「可以」是正常的，不打扰。
 */
export function localShortTranscriptWarning(durationSec: number, text: string): string | undefined {
  const chars = Array.from(String(text || '').replace(/\s+/g, '')).length;
  if (durationSec < 5 || chars > 4) return undefined;
  return `本机离线识别只认出 ${chars} 个字，可能不准确：在语音菜单里换用你配置的音频模型，或靠近麦克风再说一次`;
}

/** 本机离线识别：静音先拦、结果清洗、过短给提示 */
async function transcribeWithLocal(
  audio: Buffer,
  options: TranscribeOptions = {},
  engineLabel = '本机离线识别'
): Promise<TranscribeResult> {
  const level = wavAudioLevel(audio);
  if (level && level.rms < SPEECH_SILENT_RMS) throw new Error(silentRecordingMessage(level.rms));
  const run = options.localTranscribe ?? transcribeLocalWav;
  const { text } = await run(audio);
  const cleaned = cleanTranscript(text);
  if (!cleaned) throw new Error(noSpeechMessage(level?.rms));
  return {
    text: cleaned,
    engine: SPEECH_LOCAL_ENGINE,
    engineLabel,
    model: '',
    provider: '',
    warning: localShortTranscriptWarning(wavDurationSec(audio), cleaned),
  };
}

/**
 * 转写一段 WAV 录音：按用户选择的引擎（或自动选择结果）走专用 ASR / 模型 / 本机离线识别。
 * 没配好抛 SpeechUnavailableError（路由回 409），上游失败抛带可读中文的 Error（路由回 502）。
 */
export async function transcribeAudio(
  audio: Buffer,
  options: TranscribeOptions = {}
): Promise<TranscribeResult> {
  if (options.candidate) return transcribeWithModel(audio, options.candidate, options);
  const status = options.status ?? (await speechStatus());
  if (!status.configured) throw new SpeechUnavailableError(status.hint);
  const auto = !options.engine || !status.engines.some((engine) => engine.id === options.engine);
  const wanted = auto ? status.defaultEngine : options.engine!;
  if (wanted === SPEECH_LOCAL_ENGINE) return transcribeWithLocal(audio, options, status.localLabel);

  if (wanted === SPEECH_ASR_ENGINE) {
    const asrConfig = options.asr !== undefined ? options.asr : getSpeechAsrConfig();
    if (!asrConfig) {
      throw new SpeechUnavailableError(
        '专用语音识别模型配置不完整：去 设置 → 外设接入 → 语音输入 填写接口地址与模型名'
      );
    }
    const level = wavAudioLevel(audio);
    if (level && level.rms < SPEECH_SILENT_RMS) throw new Error(silentRecordingMessage(level.rms));
    try {
      return await transcribeWithAsr(audio, asrConfig, options);
    } catch (error: any) {
      // 自动模式下专用 ASR 失败（断网 / 额度 / Key 过期）时回退本机识别，别让语音输入直接不可用；
      // 手动选定的引擎不回退，尊重用户选择并把上游原因原样给他。
      if (auto && status.localAvailable) {
        const fallback = await transcribeWithLocal(audio, options, status.localLabel);
        const label = `${asrConfig.name || '专用语音识别'} · ${asrConfig.model}`;
        const message = String(error?.message || '转写失败');
        const reason = message.length > 160 ? `${message.slice(0, 157)}…` : message;
        return {
          ...fallback,
          warning: `专用语音识别模型「${label}」转写失败：${reason}；已改用本机离线识别${fallback.warning ? `；${fallback.warning}` : ''}`,
        };
      }
      throw error;
    }
  }

  const config = options.config ?? currentModelConfig();
  const keys = options.keys ?? currentKeys(bundledDshHome(), config);
  const candidate = buildSpeechCatalog(config, keys).audioCandidates.find((item) => item.id === wanted);
  if (!candidate) {
    throw new SpeechUnavailableError('选中的语音模型已经不可用了：请回语音输入菜单重新选择，或改用本机离线识别');
  }
  try {
    return await transcribeWithModel(audio, candidate, options);
  } catch (error) {
    // 按模型名推断的引擎可能其实不收音频：自动模式下回退本机，避免语音输入直接失败。
    // 用户手动指定的引擎不回退，尊重选择并把上游原因原样给他。
    if (
      auto
      && candidate.audioSupport === 'inferred'
      && error instanceof SpeechAudioUnsupportedError
      && status.localAvailable
    ) {
      const fallback = await transcribeWithLocal(audio, options, status.localLabel);
      const label = `${candidate.providerName} · ${candidate.modelName}`;
      return {
        ...fallback,
        warning: `「${label}」不支持音频输入，已自动改用本机离线识别${fallback.warning ? `；${fallback.warning}` : ''}`,
      };
    }
    throw error;
  }
}
