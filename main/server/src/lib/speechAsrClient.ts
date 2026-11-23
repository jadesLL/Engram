import {
  SPEECH_ASR_ENGINE,
  asrEndpoint,
  asrProtocolMeta,
  type SpeechAsrConfig,
  type SpeechAsrProtocol,
} from './speechAsr.js';
import { abortWith } from './speechHttp.js';
import { SPEECH_SYSTEM_PROMPT, cleanTranscript } from './speechText.js';

/**
 * 专用 ASR 的请求适配器：只管把一段 WAV 发给客户配置的接口，并取回转写文本。
 *
 * 四类接口的差异集中在「请求体长什么样」和「文本藏在哪个字段」：
 *  - OpenAI 兼容转写：multipart `/audio/transcriptions`，响应 `{ text }`；
 *  - OpenAI 兼容对话：`/chat/completions` + input_audio，响应 `choices[0].message.content`；
 *  - 百炼 Qwen-Audio-ASR：`input.messages[].content[].input_audio`，响应 `output.text / output.sentence`；
 *  - 百炼 Qwen3-ASR：`input.messages[].content[].audio`，响应 `output.choices[].message.content[]`。
 *
 * 这里不读 dsh 配置、不依赖本机模型；接口地址、模型、Key 全部来自 Engram 自己的 ASR 配置。
 * 错误统一压成可操作的中文，且只截留给上游报文的短片段，绝不回显 API Key。
 */

/** 转写请求超时：录音上限 3 分钟，专用 ASR 正常远快于此；45 秒既给慢网络留余量，又不让配错的地址把界面挂太久 */
export const SPEECH_ASR_TIMEOUT_MS = 45_000;
const SPEECH_ASR_MAX_TOKENS = 2048;

export interface SpeechAsrTranscribeOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SpeechAsrTranscribeResult {
  text: string;
  engine: string;
  engineLabel: string;
  model: string;
  provider: string;
}

function dataUri(audio: Buffer): string {
  return `data:audio/wav;base64,${audio.toString('base64')}`;
}

/** 从上游报文里找一句能给人看的错误（不带 Key；原始报文只截短片段） */
function upstreamDetail(rawBody: string): string {
  const raw = String(rawBody || '');
  try {
    const json: any = JSON.parse(raw);
    const candidates = [
      json?.error?.message,
      json?.error?.code,
      json?.message,
      json?.msg,
      json?.output?.message,
      json?.detail,
    ];
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim().slice(0, 240);
    }
  } catch {
    /* 不是 JSON：用原报文 */
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function redactSensitive(text: string, apiKey = ''): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('***');
  // 兜底：很多服务 Inspector 的 Key 形如 sk-…；避免上游报文把 Key 片段带进用户界面
  return out.replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, 'sk-***');
}

function asrUpstreamError(status: number, rawBody: string, protocol: SpeechAsrProtocol, apiKey = ''): string {
  const detail = redactSensitive(upstreamDetail(rawBody), apiKey);
  if (status === 401 || status === 403) {
    return '专用语音识别模型的 API Key 无效或没有权限：去 设置 → 外设接入 → 语音输入 检查 Key'
      + (detail ? `（${detail}）` : '');
  }
  if (status === 404 || status === 405) {
    return '专用语音识别的接口地址或模型名不对（HTTP ' + status + '）：'
      + '检查接口地址是否填错版本路径、模型名在该服务里是否可用'
      + (detail ? `（${detail}）` : '');
  }
  if (status === 429) {
    return '专用语音识别请求太频繁（或额度用尽），稍等一会儿再试'
      + (detail ? `（${detail}）` : '');
  }
  if (status === 413) {
    return '录音太大，专用语音识别服务拒收了：请缩短录音后重试';
  }
  if (status === 400 || status === 422) {
    const lower = detail.toLowerCase();
    const audioHint = lower.includes('audio') || lower.includes('content') || lower.includes('input_audio')
      ? '；「接口类型」要和模型匹配（Qwen-Audio 选 Qwen-Audio-ASR，Qwen3-ASR 选 Qwen3-ASR）'
      : '';
    return `专用语音识别服务不接受这次请求（HTTP ${status}）${audioHint}`
      + (detail ? `：${detail}` : '');
  }
  const meta = asrProtocolMeta(protocol);
  return `${meta.label} 返回 ${status}` + (detail ? `：${detail}` : '：未知错误');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).join('');
  }
  return '';
}

/** 百炼原生接口的文本字段：Qwen-Audio 在 output.text / output.sentence，Qwen3 在 output.choices */
function textFromDashscope(json: any): string {
  const output = json?.output;
  if (typeof output?.text === 'string') return output.text;
  if (typeof output?.sentence?.text === 'string') return output.sentence.text;
  if (Array.isArray(output?.sentences)) {
    return output.sentences.map((item: any) => (typeof item?.text === 'string' ? item.text : '')).join('');
  }
  const content = output?.choices?.[0]?.message?.content;
  return contentText(content);
}

/** OpenAI 兼容转写接口的文本字段（Whisper 标准是 text；兼容少数网关的 results / segments） */
function textFromTranscriptions(json: any): string {
  if (typeof json?.text === 'string') return json.text;
  if (typeof json?.result?.text === 'string') return json.result.text;
  if (typeof json?.data?.text === 'string') return json.data.text;
  if (Array.isArray(json?.results)) {
    return json.results.map((item: any) => (typeof item?.text === 'string' ? item.text : '')).join('');
  }
  if (Array.isArray(json?.segments)) {
    return json.segments.map((item: any) => (typeof item?.text === 'string' ? item.text : '')).join('');
  }
  return '';
}

/** 对话接口：正常是 JSON；网关忽略 stream:false 直接回 SSE 时也逐段拼出来 */
async function textFromChatResponse(response: Response, apiKey = ''): Promise<string> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const raw = await response.text();
  if (!contentType.includes('text/event-stream') && !raw.trimStart().startsWith('data:')) {
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`语音识别服务没有返回可解析的内容（${redactSensitive(raw, apiKey).replace(/\s+/g, ' ').slice(0, 160)}）`);
    }
    if (json?.error) throw new Error(asrUpstreamError(502, JSON.stringify(json), 'openai-chat-audio', apiKey));
    return contentText(json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.delta?.content);
  }
  let text = '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const json: any = JSON.parse(payload);
      const choice = json?.choices?.[0];
      text += contentText(choice?.delta?.content ?? choice?.message?.content);
    } catch {
      /* 坏事件跳过 */
    }
  }
  return text;
}

function authHeaders(config: SpeechAsrConfig, json: boolean): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (json) headers['content-type'] = 'application/json';
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

async function requestAsr(
  audio: Buffer,
  config: SpeechAsrConfig,
  options: SpeechAsrTranscribeOptions
): Promise<string> {
  const endpoint = asrEndpoint(config.protocol, config.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const { signal, done } = abortWith(options.timeoutMs ?? SPEECH_ASR_TIMEOUT_MS, options.signal);

  let init: RequestInit;
  if (config.protocol === 'openai-transcriptions') {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'voice.wav');
    form.append('model', config.model);
    init = { method: 'POST', headers: authHeaders(config, false), body: form, signal };
  } else if (config.protocol === 'openai-chat-audio') {
    init = {
      method: 'POST',
      headers: authHeaders(config, true),
      signal,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: SPEECH_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'input_audio', input_audio: { data: dataUri(audio), format: 'wav' } },
              { type: 'text', text: '转写这段录音。' },
            ],
          },
        ],
        stream: false,
        temperature: 0,
        max_tokens: SPEECH_ASR_MAX_TOKENS,
      }),
    };
  } else if (config.protocol === 'dashscope-audio') {
    init = {
      method: 'POST',
      headers: authHeaders(config, true),
      signal,
      body: JSON.stringify({
        model: config.model,
        input: {
          messages: [
            {
              role: 'user',
              content: [{ type: 'input_audio', input_audio: { data: dataUri(audio) } }],
            },
          ],
        },
        parameters: { format: 'wav', sample_rate: '16000' },
      }),
    };
  } else {
    init = {
      method: 'POST',
      headers: authHeaders(config, true),
      signal,
      body: JSON.stringify({
        model: config.model,
        input: {
          messages: [{ role: 'user', content: [{ audio: dataUri(audio) }] }],
        },
      }),
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, init);
  } catch (error: any) {
    done();
    if (error?.name === 'AbortError') {
      throw new Error(options.signal?.aborted ? '转写已取消' : '语音识别超时了，请检查接口地址或缩短录音后重试');
    }
    throw new Error(`连不上专用语音识别服务：${error?.message || '网络错误'}（检查中枢网络或代理）`);
  }

  try {
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(asrUpstreamError(response.status, raw, config.protocol, config.apiKey));
    }
    if (config.protocol === 'openai-transcriptions') {
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const raw = (await response.text()).trim();
      // 少数网关不标 application/json，但正文仍是 JSON：两种都认，纯文本直接当结果
      if (!contentType.includes('application/json') && !raw.startsWith('{')) return raw;
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        return raw;
      }
      if (json?.error) throw new Error(asrUpstreamError(502, JSON.stringify(json), config.protocol, config.apiKey));
      return textFromTranscriptions(json);
    }
    if (config.protocol === 'openai-chat-audio') return textFromChatResponse(response, config.apiKey);
    const json: any = await response.json().catch(() => null);
    if (json?.error) throw new Error(asrUpstreamError(502, JSON.stringify(json), config.protocol, config.apiKey));
    return textFromDashscope(json);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('语音识别超时了，请检查接口地址或缩短录音后重试');
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    done();
  }
}

/**
 * 用专用 ASR 转写一段 WAV。没有配置 Key 时不在这里拦（自建 Whisper 可能不要 Key），
 * 上游 401 会给出「去设置页检查 Key」的可读提示。
 */
export async function transcribeWithAsr(
  audio: Buffer,
  config: SpeechAsrConfig,
  options: SpeechAsrTranscribeOptions = {}
): Promise<SpeechAsrTranscribeResult> {
  const meta = asrProtocolMeta(config.protocol);
  const raw = await requestAsr(audio, config, options);
  const text = cleanTranscript(raw);
  if (!text) throw new Error('没有识别到语音：请靠近麦克风、说清楚一点再试');
  return {
    text,
    engine: SPEECH_ASR_ENGINE,
    engineLabel: `${config.name || '专用语音识别'} · ${config.model}`,
    model: config.model,
    provider: meta.id,
  };
}
