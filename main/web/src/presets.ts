import { ref } from 'vue';
import deepseekLogo from './assets/providers/deepseek.svg';
import kimiLogo from './assets/providers/kimi.svg';
import zhipuLogo from './assets/providers/bigmodel.svg';
import aliyunLogo from './assets/providers/qianwen.png';
import doubaoLogo from './assets/providers/doubao.png';
import xiaomiLogo from './assets/providers/xiaomi.svg';
import minimaxLogo from './assets/providers/minimax.svg';
import hunyuanLogo from './assets/providers/hunyuan.svg';
import siliconflowLogo from './assets/providers/siliconflow.svg';
import openaiLogo from './assets/providers/openai.svg';

/** 前端厂商目录展示层：数据本体在服务端 modelCatalog.ts（GET /api/settings/model-catalog），
 *  本文件只保留类型、Logo 资源映射与目录的响应式容器；新模型上线只改服务端。 */

export type ImageInputStatus = 'supported' | 'unsupported' | 'unknown';
export type ProviderProtocol = 'openai' | 'anthropic';

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  dim?: number;
  dimensions?: number[];
  supportsDimensions?: boolean;
  imageInput?: ImageInputStatus;
}

export interface ApiLine {
  id: string;
  name: string;
  type: 'payg' | 'token-plan' | 'coding-plan' | 'agent-plan';
  baseUrl: string;
  /** 请求协议：缺省按 OpenAI 兼容处理。 */
  protocol?: ProviderProtocol;
  modelsUrl?: string;
  models?: string[];
  hint?: string;
  apiKeyPlaceholder?: string;
}

export interface ProviderPreset {
  id: string;
  name: string;
  logo?: string;
  lines: ApiLine[];
  chatModels: ModelOption[];
  embeddingModels: ModelOption[];
  documentModels?: ModelOption[];
  defaultChat?: string;
  defaultEmbedding?: string;
  defaultDocument?: string;
  hint?: string;
}

const PROVIDER_LOGOS: Record<string, string> = {
  deepseek: deepseekLogo,
  moonshot: kimiLogo,
  zhipu: zhipuLogo,
  aliyun: aliyunLogo,
  doubao: doubaoLogo,
  xiaomi: xiaomiLogo,
  minimax: minimaxLogo,
  hunyuan: hunyuanLogo,
  siliconflow: siliconflowLogo,
  openai: openaiLogo,
};

/** 自定义服务商的结构兜底（目录未加载完成时的表单回退用） */
export const customPreset: ProviderPreset = {
  id: 'custom',
  name: '自定义',
  lines: [
    {
      id: 'custom',
      name: '自定义线路',
      type: 'payg',
      baseUrl: '',
      hint: '填写 OpenAI 兼容或 Anthropic 兼容接口的 Base URL，并选择请求协议。',
      apiKeyPlaceholder: 'API Key',
    },
  ],
  chatModels: [],
  embeddingModels: [],
};

const catalogRef = ref<ProviderPreset[]>([]);

/** 注入服务端目录（onMounted 拉取后调用）；Logo 由前端静态映射补齐 */
export function setModelCatalog(providers: ProviderPreset[]) {
  catalogRef.value = providers.map((provider) => ({
    ...provider,
    logo: provider.logo || PROVIDER_LOGOS[provider.id] || '',
  }));
}

export function catalogProviders(): ProviderPreset[] {
  return catalogRef.value;
}

export function catalogLoaded(): boolean {
  return catalogRef.value.length > 0;
}

export function providerById(id: string): ProviderPreset | undefined {
  return catalogRef.value.find((provider) => provider.id === id);
}

export function modelById(
  providerId: string,
  modelId?: string,
  kind?: 'chat' | 'embedding' | 'document'
): ModelOption | undefined {
  const id = modelId ?? providerId;
  const providers = modelId ? [providerById(providerId)].filter(Boolean) as ProviderPreset[] : catalogRef.value;
  for (const provider of providers) {
    const pools = kind === 'chat'
      ? [provider.chatModels]
      : kind === 'embedding'
        ? [provider.embeddingModels]
        : kind === 'document'
          ? [provider.documentModels || []]
          : [provider.chatModels, provider.embeddingModels, provider.documentModels || []];
    for (const pool of pools) {
      const match = pool.find((model) => model.id === id);
      if (match) return match;
    }
  }
  return undefined;
}
