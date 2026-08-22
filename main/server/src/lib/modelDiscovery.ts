import {
  imageInputStatusFromMetadata,
  inferImageInputStatus,
  type ImageInputStatus,
} from './modelCapabilities.js';

export type DiscoveredModelKind = 'chat' | 'embedding' | 'document' | 'rerank';

export interface DiscoverModelsInput {
  baseUrl?: string;
  modelsUrl?: string;
  apiKey?: string;
  kind: DiscoveredModelKind;
}

const EMBEDDING_PATTERN = /(^|[\/_.-])(embed|embedding|bge|gte|e5)([\/_.-]|$)/i;
const NON_CHAT_PATTERN = /(^|[\/_.-])(rerank|reranker|tts|speech|whisper|asr|image-generation|video)([\/_.-]|$)/i;
const RERANK_PATTERN = /(^|[\/_.-])(rerank|reranker)([\/_.-]|$)/i;
const DOCUMENT_PATTERN = /(^|[\/_.-])(ocr|vision|vl|omni|multimodal)([\/_.-]|$)/i;
const KNOWN_MODELS_URLS = new Map([
  ['https://api.deepseek.com/v1', 'https://api.deepseek.com/models'],
]);

export interface DiscoveredModelInfo {
  id: string;
  imageInput?: ImageInputStatus;
}

export function deriveModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '';
  return KNOWN_MODELS_URLS.get(normalized) || `${normalized}/models`;
}

function modelId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  for (const key of ['id', 'model', 'model_id', 'modelId', 'model_name', 'name']) {
    if (typeof item[key] === 'string' && item[key]) return String(item[key]).trim();
  }
  return '';
}

export function parseDiscoveredModels(payload: unknown): DiscoveredModelInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const body = payload as Record<string, unknown>;
  const nestedData = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? (body.data as Record<string, unknown>).data
    : undefined;
  const candidates = [body.data, body.models, body.items, nestedData].find(Array.isArray) as unknown[] | undefined;
  if (!candidates) return [];
  const models = new Map<string, DiscoveredModelInfo>();
  for (const candidate of candidates) {
    const id = modelId(candidate);
    if (!id) continue;
    const metadataStatus = imageInputStatusFromMetadata(candidate);
    const inferredStatus = inferImageInputStatus(id);
    models.set(id, {
      id,
      ...(metadataStatus
        ? { imageInput: metadataStatus }
        : inferredStatus !== 'unknown'
          ? { imageInput: inferredStatus }
          : {}),
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function parseDiscoveredModelIds(payload: unknown): string[] {
  return parseDiscoveredModels(payload).map((model) => model.id);
}

export function filterDiscoveredModels(ids: string[], kind: DiscoveredModelKind): string[] {
  if (kind === 'embedding') {
    const filtered = ids.filter((id) => EMBEDDING_PATTERN.test(id));
    return filtered.length ? filtered : ids;
  }
  if (kind === 'rerank') {
    const filtered = ids.filter((id) => RERANK_PATTERN.test(id) && !EMBEDDING_PATTERN.test(id));
    return filtered.length ? filtered : ids;
  }
  if (kind === 'document') {
    const supported = ids.filter((id) =>
      (DOCUMENT_PATTERN.test(id) || inferImageInputStatus(id) === 'supported')
      && !NON_CHAT_PATTERN.test(id)
    );
    if (supported.length) return supported;
    return ids.filter((id) =>
      inferImageInputStatus(id) === 'unknown'
      && !NON_CHAT_PATTERN.test(id)
    );
  }
  return ids.filter((id) => !EMBEDDING_PATTERN.test(id) && !NON_CHAT_PATTERN.test(id));
}

export async function discoverModels(input: DiscoverModelsInput): Promise<{
  models: string[];
  capabilities: Record<string, ImageInputStatus>;
  url: string;
}> {
  const url = (input.modelsUrl || deriveModelsUrl(input.baseUrl || '')).trim();
  if (!url) throw new Error('无法根据 Base URL 推导模型目录地址');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('模型目录地址无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('模型目录只支持 HTTP 或 HTTPS');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
    const response = await fetch(parsed, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`模型列表请求失败 ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    const discovered = parseDiscoveredModels(await response.json());
    const models = filterDiscoveredModels(discovered.map((model) => model.id), input.kind);
    if (!models.length) throw new Error('厂商未返回可识别的模型列表');
    const selected = new Set(models);
    const capabilities = Object.fromEntries(
      discovered
        .filter((model) => selected.has(model.id) && model.imageInput)
        .map((model) => [model.id, model.imageInput!]),
    );
    return { models, capabilities, url: parsed.toString() };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('模型列表请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
