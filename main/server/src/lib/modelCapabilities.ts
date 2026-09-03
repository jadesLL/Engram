export type ImageInputStatus = 'supported' | 'unsupported' | 'unknown';
export type ImageInputSource = 'stored' | 'catalog' | 'metadata' | 'probe';

export interface ImageInputCapability {
  status: ImageInputStatus;
  source: ImageInputSource;
  detail?: string;
}

interface CapabilityEntry {
  model: string;
  imageInput?: ImageInputStatus;
}

const IMAGE_MODEL_PATTERNS = [
  /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/i,
  /^gpt-4\.1(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/i,
  /^gpt-5(?:\.\d+)?(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/i,
  /^o3(?:-\d{4}-\d{2}-\d{2})?$/i,
  /^o4-mini(?:-\d{4}-\d{2}-\d{2})?$/i,
  /^qwen3\.(?:5|7|8)-(?:plus|flash|max)(?:-\d{4}-\d{2}-\d{2})?$/i,
  /^qwen(?:\d+(?:\.\d+)?)?-(?:vl|omni|ocr)(?:[.-]|$)/i,
  /^kimi-k2\.5(?:-\d+)?$/i,
  /^doubao-seed-(?:1[.-]?6(?:-flash)?|2[.-]?0-(?:pro|lite|mini)|2[.-]?1-(?:pro|turbo))(?:-\d+)?$/i,
  /^glm-(?:4(?:\.\d+)?v|4v|5v)(?:[.-]|$)/i,
  // GLM-5 系列对话模型原生多模态（GLM-5.3 flash 实测具备视觉输入）
  /^glm-5(?:\.\d+)?(?:-(?:flash|plus|air|x))?(?:-\d{4}-\d{2}-\d{2})?$/i,
];

const TEXT_ONLY_MODEL_PATTERNS = [
  /(^|[\/_.-])(embed|embedding|rerank|reranker|tts|speech|whisper|asr)([\/_.-]|$)/i,
  /^deepseek-(?:chat|reasoner|r1|v3|v4)(?:[.-]|$)/i,
  /^qwen(?:3)?-(?:coder|long)(?:[.-]|$)/i,
  /^qwq(?:[.-]|$)/i,
];

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function booleanCapability(value: unknown): ImageInputStatus | undefined {
  if (value === true) return 'supported';
  if (value === false) return 'unsupported';
  return undefined;
}

export function inferImageInputStatus(model: string): ImageInputStatus {
  const normalized = model.trim();
  if (!normalized) return 'unknown';
  if (IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))) return 'supported';
  if (TEXT_ONLY_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))) return 'unsupported';
  return 'unknown';
}

export function imageInputStatusFromMetadata(value: unknown): ImageInputStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const architecture = item.architecture && typeof item.architecture === 'object'
    ? item.architecture as Record<string, unknown>
    : {};
  const capabilities = item.capabilities && typeof item.capabilities === 'object'
    ? item.capabilities as Record<string, unknown>
    : {};

  for (const candidate of [
    item.supports_image,
    item.supportsImage,
    item.image_input,
    item.imageInput,
    capabilities.image,
    capabilities.vision,
    capabilities.multimodal,
  ]) {
    const status = booleanCapability(candidate);
    if (status) return status;
  }

  const inputModalities = [
    ...stringList(item.input_modalities),
    ...stringList(item.inputModalities),
    ...stringList(architecture.input_modalities),
    ...stringList(architecture.inputModalities),
  ];
  if (inputModalities.length) {
    return inputModalities.some((modality) =>
      ['image', 'vision', 'visual', 'multimodal'].includes(modality)
    )
      ? 'supported'
      : 'unsupported';
  }

  return undefined;
}

export function resolveImageInputCapability(entry: CapabilityEntry): ImageInputCapability {
  if (entry.imageInput === 'supported' || entry.imageInput === 'unsupported') {
    return { status: entry.imageInput, source: 'stored' };
  }
  return {
    status: inferImageInputStatus(entry.model),
    source: 'catalog',
  };
}
