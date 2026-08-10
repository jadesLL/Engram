export type DiscoveredModelKind = 'chat' | 'embedding' | 'document';

export interface DiscoverModelsInput {
  baseUrl?: string;
  modelsUrl?: string;
  apiKey?: string;
  kind: DiscoveredModelKind;
}

const EMBEDDING_PATTERN = /(^|[\/_.-])(embed|embedding|bge|gte|e5)([\/_.-]|$)/i;
const NON_CHAT_PATTERN = /(^|[\/_.-])(rerank|reranker|tts|speech|whisper|asr|image-generation|video)([\/_.-]|$)/i;
const DOCUMENT_PATTERN = /(^|[\/_.-])(ocr|vision|vl|omni|multimodal)([\/_.-]|$)/i;

export function deriveModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return normalized ? `${normalized}/models` : '';
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

export function parseDiscoveredModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const body = payload as Record<string, unknown>;
  const nestedData = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? (body.data as Record<string, unknown>).data
    : undefined;
  const candidates = [body.data, body.models, body.items, nestedData].find(Array.isArray) as unknown[] | undefined;
  if (!candidates) return [];
  return [...new Set(candidates.map(modelId).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function filterDiscoveredModels(ids: string[], kind: DiscoveredModelKind): string[] {
  const filtered = kind === 'embedding'
    ? ids.filter((id) => EMBEDDING_PATTERN.test(id))
    : kind === 'document'
      ? ids.filter((id) => DOCUMENT_PATTERN.test(id) && !NON_CHAT_PATTERN.test(id))
      : ids.filter((id) => !EMBEDDING_PATTERN.test(id) && !NON_CHAT_PATTERN.test(id));
  return filtered.length ? filtered : ids;
}

export async function discoverModels(input: DiscoverModelsInput): Promise<{ models: string[]; url: string }> {
  const url = (input.modelsUrl || deriveModelsUrl(input.baseUrl || '')).trim();
  if (!url) throw new Error('请填写模型列表 API 地址');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('模型列表 API 地址无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('模型列表 API 只支持 HTTP 或 HTTPS');
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
    const models = filterDiscoveredModels(parseDiscoveredModelIds(await response.json()), input.kind);
    if (!models.length) throw new Error('厂商未返回可识别的模型列表');
    return { models, url: parsed.toString() };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('模型列表请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
