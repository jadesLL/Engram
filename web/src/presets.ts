import deepseekLogo from './assets/providers/deepseek.svg';
import kimiLogo from './assets/providers/kimi.svg';
import zhipuLogo from './assets/providers/zhipu.svg';
import aliyunLogo from './assets/providers/aliyun.svg';
import doubaoLogo from './assets/providers/doubao.png';
import xiaomiLogo from './assets/providers/xiaomi.svg';
import minimaxLogo from './assets/providers/minimax.svg';
import hunyuanLogo from './assets/providers/hunyuan.svg';
import siliconflowLogo from './assets/providers/siliconflow.svg';
import openaiLogo from './assets/providers/openai.svg';

/** OpenAI 兼容的内置厂商、API 线路与模型目录。 */
export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  dim?: number;
  dimensions?: number[];
  supportsDimensions?: boolean;
}

export interface ApiLine {
  id: string;
  name: string;
  type: 'payg' | 'token-plan' | 'coding-plan' | 'agent-plan';
  baseUrl: string;
  /** 获取该线路可用模型的 API。国内厂商使用中国大陆官方域名。 */
  modelsUrl?: string;
  /** 线路模型白名单。省略时表示可使用厂商目录中的全部模型。 */
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
  defaultChat?: string;
  defaultEmbedding?: string;
  hint?: string;
}

const options = (ids: string[]): ModelOption[] => ids.map((id) => ({ id, name: id }));

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    logo: deepseekLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.deepseek.com/v1',
        modelsUrl: 'https://api.deepseek.com/models',
        apiKeyPlaceholder: 'sk-...',
      },
    ],
    chatModels: options(['deepseek-v4-pro', 'deepseek-v4-flash']),
    embeddingModels: [],
    defaultChat: 'deepseek-v4-flash',
    hint: 'DeepSeek 当前目录只包含对话模型。',
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    logo: kimiLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.moonshot.cn/v1',
        modelsUrl: 'https://api.moonshot.cn/v1/models',
        apiKeyPlaceholder: 'sk-...',
      },
      {
        id: 'kimi-code',
        name: 'Kimi Code',
        type: 'coding-plan',
        baseUrl: 'https://api.kimi.com/coding/v1',
        modelsUrl: 'https://api.kimi.com/coding/v1/models',
        models: ['kimi-for-coding'],
        hint: 'Kimi Code 线路只支持 kimi-for-coding。',
        apiKeyPlaceholder: 'sk-...',
      },
    ],
    chatModels: options([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-for-coding',
    ]),
    embeddingModels: [],
    defaultChat: 'kimi-k3',
    hint: 'Kimi Code 使用独立线路和专用模型。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    logo: zhipuLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
        apiKeyPlaceholder: 'API Key',
      },
      {
        id: 'coding-plan',
        name: 'Coding Plan',
        type: 'coding-plan',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        modelsUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/models',
        models: ['glm-5.2', 'glm-5-turbo', 'glm-4.7'],
        hint: 'Coding Plan 只支持 glm-5.2、glm-5-turbo 和 glm-4.7。',
        apiKeyPlaceholder: 'Coding Plan API Key',
      },
    ],
    chatModels: options([
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'glm-5-turbo',
      'glm-4.7',
      'glm-4.7-flash',
      'glm-4.6',
    ]),
    embeddingModels: [
      {
        id: 'embedding-3',
        name: 'embedding-3',
        dim: 2048,
        dimensions: [256, 512, 1024, 2048],
        supportsDimensions: true,
      },
      { id: 'embedding-2', name: 'embedding-2', dim: 1024 },
    ],
    defaultChat: 'glm-5.2',
    defaultEmbedding: 'embedding-3',
  },
  {
    id: 'aliyun',
    name: '通义百炼',
    logo: aliyunLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelsUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
        apiKeyPlaceholder: 'sk-...',
      },
      {
        id: 'coding-plan',
        name: 'Coding Plan',
        type: 'coding-plan',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
        modelsUrl: 'https://coding.dashscope.aliyuncs.com/v1/models',
        models: [
          'qwen3.7-plus',
          'qwen3.6-plus',
          'kimi-k2.5',
          'glm-5',
          'MiniMax-M2.5',
          'qwen3.5-plus',
          'qwen3-max-2026-01-23',
          'qwen3-coder-next',
          'qwen3-coder-plus',
          'glm-4.7',
        ],
        hint: 'Coding Plan 使用 sk-sp- 开头的专用 Key。',
        apiKeyPlaceholder: 'sk-sp-...',
      },
    ],
    chatModels: options([
      'qwen3.8-max',
      'qwen3.7-plus',
      'qwen3.7-flash',
      'qwen3.6-plus',
      'qwen3.5-plus',
      'qwen3.5-omni-plus',
      'qwen-max',
      'qwen-plus',
      'qwen-flash',
      'qwen-long',
      'qwq',
      'qwen3-coder',
      'qwen3-coder-next',
      'qwen3-coder-plus',
      'qwen-vl-max',
      'kimi-k2.5',
      'glm-5',
      'MiniMax-M2.5',
      'qwen3-max-2026-01-23',
      'glm-4.7',
    ]),
    embeddingModels: [
      {
        id: 'qwen3.7-text-embedding',
        name: 'qwen3.7-text-embedding',
        dim: 1024,
        dimensions: [256, 512, 768, 1024, 1536, 2048, 2560],
        supportsDimensions: true,
      },
      {
        id: 'text-embedding-v4',
        name: 'text-embedding-v4',
        dim: 1024,
        dimensions: [64, 128, 256, 512, 768, 1024, 1536, 2048],
        supportsDimensions: true,
      },
      {
        id: 'text-embedding-v3',
        name: 'text-embedding-v3',
        dim: 1024,
        dimensions: [64, 128, 256, 512, 768, 1024],
        supportsDimensions: true,
      },
      { id: 'text-embedding-v2', name: 'text-embedding-v2', dim: 1536 },
    ],
    defaultChat: 'qwen3.7-plus',
    defaultEmbedding: 'qwen3.7-text-embedding',
  },
  {
    id: 'doubao',
    name: '火山方舟',
    logo: doubaoLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        modelsUrl: 'https://ark.cn-beijing.volces.com/api/v3/models',
        hint: '模型名称也可填写控制台中 ep- 开头的推理接入点。',
        apiKeyPlaceholder: 'API Key',
      },
      {
        id: 'agent-plan',
        name: 'Agent Plan',
        type: 'agent-plan',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
        modelsUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3/models',
        models: ['ark-code-latest', 'minimax-m2.7', 'kimi-k2.6', 'kimi-k2.7-code'],
        hint: 'Agent Plan 使用套餐专用 API Key，支持 Responses API。',
        apiKeyPlaceholder: 'Agent Plan API Key',
      },
      {
        id: 'coding-plan',
        name: 'Coding Plan',
        type: 'coding-plan',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        modelsUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3/models',
        models: [
          'ark-code-latest',
          'doubao-seed-2.0-code',
          'doubao-seed-code-preview-251028',
          'minimax-m2.5',
          'glm-4.7',
          'deepseek-v3.2',
          'kimi-k2.5',
        ],
        hint: 'Coding Plan 使用套餐专用 API Key。',
        apiKeyPlaceholder: 'Coding Plan API Key',
      },
    ],
    chatModels: options([
      'doubao-seed-evolving',
      'doubao-seed-2-1-pro',
      'doubao-seed-2-1-turbo',
      'doubao-seed-2-0-pro',
      'doubao-seed-2-0-lite',
      'doubao-seed-2-0-mini',
      'doubao-seed-1.6',
      'doubao-seed-1.6-flash',
      'doubao-seed-code-preview',
    ]),
    embeddingModels: [
      { id: 'doubao-embedding-large-text-240915', name: 'doubao-embedding-large-text-240915', dim: 4096 },
      { id: 'doubao-embedding-text-240715', name: 'doubao-embedding-text-240715', dim: 2560 },
      {
        id: 'doubao-embedding-text-240515',
        name: 'doubao-embedding-text-240515',
        dim: 2048,
        dimensions: [512, 1024, 2048],
        supportsDimensions: true,
      },
    ],
    defaultChat: 'doubao-seed-2-1-pro',
    defaultEmbedding: 'doubao-embedding-large-text-240915',
    hint: '支持按量付费、Agent Plan 和 Coding Plan，可直接填写 ep- 开头的接入点。',
  },
  {
    id: 'xiaomi',
    name: '小米 MiMo',
    logo: xiaomiLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        modelsUrl: 'https://api.xiaomimimo.com/v1/models',
        apiKeyPlaceholder: 'sk-...',
      },
      {
        id: 'token-plan',
        name: 'Token Plan',
        type: 'token-plan',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        modelsUrl: 'https://token-plan-cn.xiaomimimo.com/v1/models',
        apiKeyPlaceholder: 'tp-...',
      },
    ],
    chatModels: options(['mimo-v2.5-pro', 'mimo-v2.5']),
    embeddingModels: [],
    defaultChat: 'mimo-v2.5-pro',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    logo: minimaxLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.minimaxi.com/v1',
        modelsUrl: 'https://api.minimaxi.com/v1/models',
        apiKeyPlaceholder: 'sk-...',
      },
      {
        id: 'token-plan',
        name: 'Token Plan',
        type: 'token-plan',
        baseUrl: 'https://api.minimaxi.com/v1',
        modelsUrl: 'https://api.minimaxi.com/v1/models',
        hint: 'Token Plan 使用 sk-cp- 开头的专用 Key。',
        apiKeyPlaceholder: 'sk-cp-...',
      },
    ],
    chatModels: options([
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
    ]),
    embeddingModels: [],
    defaultChat: 'MiniMax-M3',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    logo: hunyuanLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
        modelsUrl: 'https://api.hunyuan.cloud.tencent.com/v1/models',
        apiKeyPlaceholder: 'API Key',
      },
    ],
    chatModels: options([
      'hunyuan-turbos-latest',
      'hunyuan-turbos',
      'hunyuan-functioncall',
      'hunyuan-lite',
      'hunyuan-a13b',
      'hunyuan-role-latest',
      'hunyuan-translation',
    ]),
    embeddingModels: [{ id: 'hunyuan-embedding', name: 'hunyuan-embedding', dim: 1024 }],
    defaultChat: 'hunyuan-turbos-latest',
    defaultEmbedding: 'hunyuan-embedding',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    logo: siliconflowLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelsUrl: 'https://api.siliconflow.cn/v1/models',
        apiKeyPlaceholder: 'sk-...',
      },
    ],
    chatModels: [
      { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1' },
      { id: 'zai-org/GLM-5.2', name: 'GLM 5.2' },
      { id: 'Pro/zai-org/GLM-5.1', name: 'GLM 5.1' },
      { id: 'zai-org/GLM-4.5-Air', name: 'GLM 4.5 Air' },
      { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6 35B A3B' },
      { id: 'Qwen/Qwen3.6-27B', name: 'Qwen3.6 27B' },
      { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5 397B A17B' },
      { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', name: 'Qwen3 Coder 30B A3B' },
      { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi K2.7 Code' },
      { id: 'Pro/moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
      { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5' },
      { id: 'tencent/Hunyuan-A13B-Instruct', name: 'Hunyuan A13B Instruct' },
    ],
    embeddingModels: [
      { id: 'BAAI/bge-m3', name: 'BAAI bge-m3', dim: 1024 },
      { id: 'BAAI/bge-large-zh-v1.5', name: 'BAAI bge-large-zh-v1.5', dim: 1024 },
      { id: 'BAAI/bge-large-en-v1.5', name: 'BAAI bge-large-en-v1.5', dim: 1024 },
      {
        id: 'Qwen/Qwen3-Embedding-8B',
        name: 'Qwen3 Embedding 8B',
        dim: 4096,
        dimensions: [64, 128, 256, 512, 768, 1024, 1536, 2048, 2560, 4096],
        supportsDimensions: true,
      },
      {
        id: 'Qwen/Qwen3-Embedding-4B',
        name: 'Qwen3 Embedding 4B',
        dim: 2560,
        dimensions: [64, 128, 256, 512, 768, 1024, 1536, 2048, 2560],
        supportsDimensions: true,
      },
      {
        id: 'Qwen/Qwen3-Embedding-0.6B',
        name: 'Qwen3 Embedding 0.6B',
        dim: 1024,
        dimensions: [64, 128, 256, 512, 768, 1024],
        supportsDimensions: true,
      },
    ],
    defaultChat: 'deepseek-ai/DeepSeek-V4-Flash',
    defaultEmbedding: 'BAAI/bge-m3',
    hint: '模型名称使用硅基流动模型广场中的完整 org/model ID。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    logo: openaiLogo,
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.openai.com/v1',
        modelsUrl: 'https://api.openai.com/v1/models',
        apiKeyPlaceholder: 'sk-...',
      },
    ],
    chatModels: options([
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'o4-mini',
      'o3',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
    ]),
    embeddingModels: [
      {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        dim: 1536,
        dimensions: [256, 512, 768, 1024, 1536],
        supportsDimensions: true,
      },
      {
        id: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        dim: 3072,
        dimensions: [256, 512, 1024, 1536, 2048, 3072],
        supportsDimensions: true,
      },
      { id: 'text-embedding-ada-002', name: 'text-embedding-ada-002', dim: 1536 },
    ],
    defaultChat: 'gpt-5.4-mini',
    defaultEmbedding: 'text-embedding-3-small',
  },
  {
    id: 'custom',
    name: '自定义',
    lines: [
      {
        id: 'custom',
        name: '自定义线路',
        type: 'payg',
        baseUrl: '',
        hint: '填写 OpenAI 兼容接口的 Base URL。',
        apiKeyPlaceholder: 'API Key',
      },
    ],
    chatModels: [],
    embeddingModels: [],
    hint: '可接入任何提供 /chat/completions 或 /embeddings 的 OpenAI 兼容服务。',
  },
];

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function modelById(
  providerId: string,
  modelId?: string,
  kind?: 'chat' | 'embedding'
): ModelOption | undefined {
  const id = modelId ?? providerId;
  const providers = modelId ? [providerById(providerId)].filter(Boolean) as ProviderPreset[] : PROVIDERS;
  for (const provider of providers) {
    const pools = kind === 'chat'
      ? [provider.chatModels]
      : kind === 'embedding'
        ? [provider.embeddingModels]
        : [provider.chatModels, provider.embeddingModels];
    for (const pool of pools) {
      const match = pool.find((model) => model.id === id);
      if (match) return match;
    }
  }
  return undefined;
}
