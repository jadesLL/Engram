import { videoModelConfig } from './videoConfig.js';
import { missingVideoModelFields, type ResolvedVideoModel } from './videoModel.js';

/**
 * 编辑器「语音输入」的转写服务（2026-11）。
 *
 * 设计口径：
 *  - **不新建一套模型配置**：语音转写复用内置 Agent 控制台里的通义千问 Omni 模型
 *    （默认 DashScope / qwen3.8-omni-flash，与视频理解共用同一份 dsh 模型配置与 Key）。
 *    用户只需要在控制台填一个 DashScope API Key，语音与视频都可用。
 *  - **不在服务端落文件**：录音只是一个请求体，转写完即丢；正文写入仍由前端走既有页面保存链路。
 *  - **流式收文本**：DashScope 的 Omni 模型音频输入按文档走流式输出（stream=true），
 *    这里累积 choices[].delta.content；网关忽略 stream 直接回 JSON 时也能兜住。
 *  - 只走 OpenAI 兼容协议：音频内容块（input_audio）是厂商扩展，官方 DeepSeek 路由没有承载位置。
 */

/** 单次录音的体积上限（WAV 16k 单声道 16bit ≈ 32KB/s；6MB ≈ 3 分钟，base64 后仍小于厂商 10MB 上限） */
export const SPEECH_MAX_AUDIO_BYTES = 6 * 1024 * 1024;
/** 服务端可接受的录音时长上限（前端单次录制上限 120 秒，这里留余量） */
export const SPEECH_MAX_DURATION_SEC = 180;
/** 前端展示与自动停止用：单次录音最长 120 秒 */
export const SPEECH_UI_MAX_DURATION_SEC = 120;
export const SPEECH_MAX_TOKENS = 2048;
export const SPEECH_TIMEOUT_MS = 180_000;

/** 没配好模型时给用户的可操作提示（面板与接口错误共用） */
export const SPEECH_MODEL_HINT =
  '语音输入复用内置 Agent 控制台里的通义千问 Omni 模型：去 设置 → Agent 与自动化 → 内置 Agent 控制台 → 模型，' +
  '给「阿里云百炼（DashScope）」填一个 API Key';

/** 转写提示词：只转写、不翻译、不解释；无人声时用固定哨兵值，服务端统一清成空串 */
const SPEECH_SYSTEM_PROMPT = [
  '你是语音转写器。把录音里的说话内容逐字转成文字：',
  '- 说话人说什么语言就写什么语言（中文写中文、英文写英文），不要翻译；',
  '- 保留语气词与自然的措辞，按语义补全标点；',
  '- 只输出转写文本本身，不要解释、总结、标题、引号、Markdown 标记或「转写：」之类的前缀；',
  '- 录音里没有可辨识的人声时，只输出 NO_SPEECH。',
].join('\n');

const NO_SPEECH_SENTINEL = 'NO_SPEECH';

export interface SpeechModelStatus {
  configured: boolean;
  provider: string;
  providerName: string;
  model: string;
  hasKey: boolean;
  keySource: 'local' | 'synced' | 'none';
  missing: string[];
}

/** 面板状态：永远不返回 API Key，只给 hasKey / keySource（与视频面板同一口径） */
export function speechModelStatus(): SpeechModelStatus {
  const resolution = videoModelConfig();
  const model = resolution.provider;
  return {
    configured: resolution.configured,
    provider: model.providerId,
    providerName: model.providerName,
    model: model.model,
    hasKey: Boolean(model.apiKey),
    keySource: resolution.keySource,
    missing: resolution.missing,
  };
}

/** 没配好时的可读原因（空串 = 可以直接用） */
export function speechUnavailableMessage(status: SpeechModelStatus = speechModelStatus()): string {
  if (status.configured) return '';
  if (!status.hasKey) {
    return '语音识别还没有模型凭据（缺 DashScope API Key）。' + SPEECH_MODEL_HINT;
  }
  const missing = status.missing.length ? status.missing.join('、') : '模型配置';
  return `语音识别还缺：${missing}。${SPEECH_MODEL_HINT}`;
}

/** 模型没配好（不是上游故障）：路由据此回 409，前端提示去配置 */
export class SpeechUnavailableError extends Error {}

export interface TranscribeOptions {
  signal?: AbortSignal;
  /** 仅供测试注入 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 测试/调用方显式指定模型；缺省读 dsh 配置 */
  model?: ResolvedVideoModel;
}

export interface TranscribeResult {
  text: string;
  model: string;
  provider: string;
  providerName: string;
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
    return '语音模型的 API Key 无效或没有权限：去 设置 → Agent 与自动化 → 内置 Agent 控制台 → 模型 检查 DashScope Key';
  }
  if (status === 429) {
    return '语音识别请求太频繁（或额度用尽），稍等一会儿再试';
  }
  if (status === 404 || lower.includes('model not found') || lower.includes('does not exist')) {
    return `语音模型找不到：请确认控制台里的模型名可用（${snippet || '未知响应'}）`;
  }
  if (lower.includes('input_audio') || lower.includes('audio') || lower.includes('modalities')) {
    return '当前模型不支持音频输入：请在内置 Agent 控制台把 DashScope 的模型换成 qwen3.8-omni-flash';
  }
  return `语音识别服务返回 ${status}：${snippet || '未知错误'}`;
}

/** 逐行累积 SSE（data: {...}），返回转写文本；同时兼容网关直接回 JSON 的情况 */
async function readTranscription(response: Response): Promise<{ text: string; usage: string }> {
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
    if (typeof content === 'string') return { text: content, usage: '' };
    if (Array.isArray(content)) {
      return {
        text: content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join(''),
        usage: '',
      };
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
  return { text, usage: '' };
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

/**
 * 转写一段 WAV 录音。模型没配好抛 SpeechUnavailableError（路由回 409），
 * 上游失败抛带可读中文的 Error（路由回 502）。
 */
export async function transcribeAudio(
  audio: Buffer,
  options: TranscribeOptions = {}
): Promise<TranscribeResult> {
  const resolution = videoModelConfig();
  const model = options.model ?? resolution.provider;
  const status: SpeechModelStatus = options.model
    ? {
        configured: missingVideoModelFields(model).length === 0,
        provider: model.providerId,
        providerName: model.providerName,
        model: model.model,
        hasKey: Boolean(model.apiKey),
        keySource: resolution.keySource,
        missing: missingVideoModelFields(model),
      }
    : speechModelStatus();
  if (!status.configured) throw new SpeechUnavailableError(speechUnavailableMessage(status));
  if (model.api !== 'openai-completions') {
    throw new SpeechUnavailableError('语音识别需要 OpenAI 兼容接口：请在内置 Agent 控制台把该提供商的协议改为 OpenAI 兼容');
  }

  const url = joinUrl(model.baseUrl, '/chat/completions');
  const body = {
    model: model.model,
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
        authorization: `Bearer ${model.apiKey}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error: any) {
    done();
    if (error?.name === 'AbortError') {
      throw new Error(
        options.signal?.aborted ? '转写已取消' : '语音识别超时了，请缩短录音后重试'
      );
    }
    throw new Error(`连不上语音识别服务：${error?.message || '网络错误'}（检查中枢网络或代理）`);
  }

  try {
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(speechUpstreamError(response.status, raw));
    }
    const { text } = await readTranscription(response);
    const cleaned = cleanTranscript(text);
    if (!cleaned) {
      throw new Error('没有识别到语音：请靠近麦克风、说清楚一点再试');
    }
    return {
      text: cleaned,
      model: model.model,
      provider: model.providerId,
      providerName: model.providerName,
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
