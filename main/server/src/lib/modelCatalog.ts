/** 服务端厂商目录：内置服务商、API 线路与模型列表的唯一事实源。
 *  前端经 GET /api/settings/model-catalog 拉取展示；logo 资源由前端静态映射持有，
 *  服务端目录不携带二进制资源。新模型上线只改本文件，前端无需发版。
 *  目录范围只收录 hermes-agent（NousResearch/hermes-agent）支持的厂商，2026-09 按其
 *  plugins/model-providers 清单核对；不在清单内的厂商（如聚合中转、国内大厂自营线）不内置。
 *  线路参数参考 Cherry Studio provider-registry 与各厂商官方文档（2026-08 核对）。 */

export type ProviderProtocol = 'openai' | 'anthropic';

export interface CatalogModelOption {
  id: string;
  name: string;
  description?: string;
  dim?: number;
  dimensions?: number[];
  supportsDimensions?: boolean;
  imageInput?: 'supported' | 'unsupported' | 'unknown';
}

export interface CatalogApiLine {
  id: string;
  name: string;
  type: 'payg' | 'token-plan' | 'coding-plan' | 'agent-plan' | 'local';
  baseUrl: string;
  /** 请求协议：缺省按 OpenAI 兼容处理（/chat/completions + Bearer）。 */
  protocol?: ProviderProtocol;
  /** 获取该线路可用模型的 API（anthropic 线路通常复用厂商 OpenAI 兼容的 /models）。 */
  modelsUrl?: string;
  /** 模型列表拉取使用的协议（缺省同 line.protocol；跨协议复用时显式声明）。 */
  modelsProtocol?: ProviderProtocol;
  /** 线路模型白名单。省略时表示可使用厂商目录中的全部模型。 */
  models?: string[];
  /** 免鉴权线路（本地推理）：无 API Key 也可调用。 */
  authOptional?: boolean;
  /** 模型列表接口支持匿名访问（拉取不需要 Key，调用仍需要）。 */
  modelsAnonymous?: boolean;
  hint?: string;
  apiKeyPlaceholder?: string;
}

export interface CatalogProvider {
  id: string;
  name: string;
  lines: CatalogApiLine[];
  chatModels: CatalogModelOption[];
  embeddingModels: CatalogModelOption[];
  documentModels?: CatalogModelOption[];
  defaultChat?: string;
  defaultEmbedding?: string;
  defaultDocument?: string;
  hint?: string;
}

const options = (ids: string[]): CatalogModelOption[] => ids.map((id) => ({ id, name: id }));

export const MODEL_CATALOG: CatalogProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.deepseek.com/v1',
        modelsUrl: 'https://api.deepseek.com/models',
        apiKeyPlaceholder: 'sk-...',
      },
      {
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
        modelsUrl: 'https://api.deepseek.com/models',
        modelsProtocol: 'openai',
        hint: '走 Anthropic Messages 协议（/v1/messages + x-api-key），适合 Claude 生态客户端复用。',
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
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://api.moonshot.cn/anthropic',
        modelsUrl: 'https://api.moonshot.cn/v1/models',
        modelsProtocol: 'openai',
        hint: '走 Anthropic Messages 协议（/v1/messages + x-api-key）。',
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
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
        modelsProtocol: 'openai',
        hint: '走 Anthropic Messages 协议（/v1/messages + x-api-key）。',
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
    documentModels: [
      { id: 'glm-4.6v', name: 'GLM-4.6V', description: '复杂图文理解与文档解析', imageInput: 'supported' },
      { id: 'glm-4.6v-flashx', name: 'GLM-4.6V-FlashX', description: '高速视觉理解', imageInput: 'supported' },
      { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', description: '轻量图片与文字识别', imageInput: 'supported' },
    ],
    defaultChat: 'glm-5.2',
    defaultEmbedding: 'embedding-3',
    defaultDocument: 'glm-4.6v-flash',
  },
  {
    id: 'zai',
    name: '智谱国际 Z.ai',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        apiKeyPlaceholder: 'API Key',
        hint: '智谱海外版，GLM 系列模型的国际线路。',
      },
      {
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://api.z.ai/api/anthropic',
        hint: '走 Anthropic Messages 协议（/v1/messages + x-api-key）。',
        apiKeyPlaceholder: 'API Key',
      },
    ],
    chatModels: options(['glm-5.2', 'glm-5', 'glm-4.7']),
    embeddingModels: [],
    defaultChat: 'glm-5.2',
  },
  {
    id: 'aliyun',
    name: '通义百炼',
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
    documentModels: [
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', description: '通用视觉理解与复杂图文分析', imageInput: 'supported' },
      { id: 'qwen-vl-max', name: 'Qwen VL Max', description: '图片、表格与文档视觉理解', imageInput: 'supported' },
      { id: 'qwen3.5-ocr', name: 'Qwen3.5 OCR', description: '扫描件、图片和复杂文档文字识别', imageInput: 'supported' },
    ],
    defaultChat: 'qwen3.7-plus',
    defaultEmbedding: 'qwen3.7-text-embedding',
    defaultDocument: 'qwen3.5-ocr',
  },
  {
    id: 'xiaomi',
    name: '小米 MiMo',
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
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://api.xiaomimimo.com/anthropic',
        modelsUrl: 'https://api.xiaomimimo.com/v1/models',
        modelsProtocol: 'openai',
        hint: '走 Anthropic Messages 协议（/v1/messages + x-api-key）。',
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
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        modelsUrl: 'https://api.minimaxi.com/v1/models',
        modelsProtocol: 'openai',
        hint: '走 Anthropic Messages 协议（/v1/messages + x-api-key）。',
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
    id: 'tokenhub',
    name: '腾讯 TokenHub',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://tokenhub.tencentmaas.com/v1',
        modelsUrl: 'https://tokenhub.tencentmaas.com/v1/models',
        hint: '腾讯云大模型知识引擎平台，聚合 DeepSeek/GLM/Kimi 等主流模型。',
        apiKeyPlaceholder: 'API Key',
      },
      {
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://tokenhub.tencentmaas.com',
        modelsUrl: 'https://tokenhub.tencentmaas.com/v1/models',
        modelsProtocol: 'openai',
        hint: '走 Anthropic Messages 协议（/v1/messages + x-api-key）。',
        apiKeyPlaceholder: 'API Key',
      },
    ],
    chatModels: options([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'glm-5.2',
      'kimi-k3',
      'hunyuan-turbos-latest',
    ]),
    embeddingModels: [],
    defaultChat: 'deepseek-v4-pro',
    hint: '腾讯云官方聚合平台，一个 Key 调用多家模型。',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.stepfun.com',
        modelsUrl: 'https://api.stepfun.com/v1/models',
        apiKeyPlaceholder: 'API Key',
      },
      {
        id: 'payg-anthropic',
        name: '按量付费（Anthropic 兼容）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://api.stepfun.com',
        modelsUrl: 'https://api.stepfun.com/v1/models',
        modelsProtocol: 'openai',
        hint: '阶跃官方提供 Anthropic Messages API。',
        apiKeyPlaceholder: 'API Key',
      },
    ],
    chatModels: options([
      'step-3.7-flash',
      'step-3.5-flash',
      'step-2-16k',
      'step-1v-8k',
    ]),
    embeddingModels: [
      { id: 'step-embedding', name: 'step-embedding', dim: 2560 },
    ],
    documentModels: [
      { id: 'step-1o-turbo-vision', name: 'Step 1o Turbo Vision', description: '高速视觉理解与 OCR', imageInput: 'supported' },
      { id: 'step-3.7-flash', name: 'Step 3.7 Flash', description: '原生多模态对话模型', imageInput: 'supported' },
    ],
    defaultChat: 'step-3.7-flash',
    hint: 'step-3.7-flash 原生支持视觉输入。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
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
    documentModels: [
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', description: '高性价比通用视觉理解', imageInput: 'supported' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', description: '图片理解、文档解析与文字提取', imageInput: 'supported' },
      { id: 'gpt-4o', name: 'GPT-4o', description: '通用多模态视觉理解', imageInput: 'supported' },
    ],
    defaultChat: 'gpt-5.4-mini',
    defaultEmbedding: 'text-embedding-3-small',
    defaultDocument: 'gpt-5.4-mini',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    lines: [
      {
        id: 'payg',
        name: '按量付费（Anthropic 协议）',
        type: 'payg',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        modelsUrl: 'https://api.anthropic.com/v1/models',
        modelsProtocol: 'anthropic',
        hint: 'Claude 官方 API（/v1/messages + x-api-key），模型列表走官方 /v1/models。',
        apiKeyPlaceholder: 'sk-ant-...',
      },
    ],
    chatModels: options([
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-7-sonnet-latest',
    ]),
    embeddingModels: [],
    documentModels: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: '图文理解与文档解析', imageInput: 'supported' },
    ],
    defaultChat: 'claude-sonnet-4-5',
    defaultDocument: 'claude-sonnet-4-5',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    lines: [
      {
        id: 'payg',
        name: '按量付费（OpenAI 兼容端点）',
        type: 'payg',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        hint: 'Gemini 官方 OpenAI 兼容端点，Google AI Studio 的 API Key 可直接使用。',
        apiKeyPlaceholder: 'AIza...',
      },
    ],
    chatModels: options([
      'gemini-3.5-pro',
      'gemini-3.5-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]),
    embeddingModels: [
      { id: 'text-embedding-004', name: 'text-embedding-004', dim: 768 },
      { id: 'gemini-embedding-001', name: 'gemini-embedding-001', dim: 3072 },
    ],
    documentModels: [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: '原生多模态图文理解', imageInput: 'supported' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: '多模态文档解析', imageInput: 'supported' },
    ],
    defaultChat: 'gemini-3.5-flash',
    defaultEmbedding: 'text-embedding-004',
    defaultDocument: 'gemini-3.5-flash',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.x.ai/v1',
        modelsUrl: 'https://api.x.ai/v1/models',
        apiKeyPlaceholder: 'xai-...',
      },
    ],
    chatModels: options([
      'grok-5',
      'grok-4',
      'grok-4-fast',
      'grok-3-mini',
    ]),
    embeddingModels: [],
    documentModels: [
      { id: 'grok-4', name: 'Grok 4', description: '多模态视觉理解', imageInput: 'supported' },
    ],
    defaultChat: 'grok-4-fast',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelsUrl: 'https://openrouter.ai/api/v1/models',
        modelsAnonymous: true,
        hint: '全球最大模型聚合，一个 Key 访问数百模型，模型列表可匿名浏览。',
        apiKeyPlaceholder: 'sk-or-...',
      },
    ],
    chatModels: options([
      'deepseek/deepseek-v4',
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-5.4',
      'google/gemini-3.5-flash',
      'qwen/qwen-3.8-max',
    ]),
    embeddingModels: [],
    documentModels: [
      { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', description: '多模态理解', imageInput: 'supported' },
    ],
    defaultChat: 'deepseek/deepseek-v4',
    hint: '模型名带 org 前缀，价格与限额以 openrouter.ai 为准。',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        modelsUrl: 'https://api.fireworks.ai/inference/v1/models',
        modelsAnonymous: true,
        apiKeyPlaceholder: 'fw_...',
      },
    ],
    chatModels: options([
      'accounts/fireworks/models/deepseek-v4',
      'accounts/fireworks/models/kimi-k3-instruct',
      'accounts/fireworks/models/qwen3-235b-a22b',
    ]),
    embeddingModels: [],
    defaultChat: 'accounts/fireworks/models/deepseek-v4',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    lines: [
      {
        id: 'payg',
        name: '按量付费',
        type: 'payg',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
        hint: 'NVIDIA 托管的开源模型推理，注册送额度。',
        apiKeyPlaceholder: 'nvapi-...',
      },
    ],
    chatModels: options([
      'deepseek-ai/deepseek-v4',
      'qwen/qwen3.8-max',
      'meta/llama-4-maverick-17b-128e-instruct',
    ]),
    embeddingModels: [
      { id: 'nvidia/nv-embedqa-e5-v5', name: 'nv-embedqa-e5-v5', dim: 1024 },
    ],
    defaultChat: 'deepseek-ai/deepseek-v4',
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    lines: [
      {
        id: 'local',
        name: '本地服务',
        type: 'local',
        baseUrl: 'http://localhost:11434/v1',
        modelsUrl: 'http://localhost:11434/v1/models',
        authOptional: true,
        modelsAnonymous: true,
        hint: '本地 Ollama 的 OpenAI 兼容端点，无需 API Key；先 ollama pull 模型。',
      },
    ],
    chatModels: options([
      'qwen3:8b',
      'deepseek-r1:14b',
      'llama3.1:8b',
    ]),
    embeddingModels: [
      { id: 'nomic-embed-text', name: 'nomic-embed-text', dim: 768 },
      { id: 'bge-m3', name: 'bge-m3', dim: 1024 },
    ],
    defaultChat: 'qwen3:8b',
    defaultEmbedding: 'nomic-embed-text',
    hint: '模型需先在本机 ollama pull；127.0.0.1 与 localhost 等价。',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    lines: [
      {
        id: 'local',
        name: '本地服务',
        type: 'local',
        baseUrl: 'http://localhost:1234/v1',
        modelsUrl: 'http://localhost:1234/v1/models',
        authOptional: true,
        modelsAnonymous: true,
        hint: 'LM Studio 本地服务器的 OpenAI 兼容端点，无需 API Key；在 LM Studio 中加载模型。',
      },
    ],
    chatModels: options([
      'qwen3-8b',
      'deepseek-r1-distill-qwen-14b',
    ]),
    embeddingModels: [
      { id: 'text-embedding-nomic-embed-text-v1.5', name: 'nomic-embed-text-v1.5', dim: 768 },
    ],
    defaultChat: 'qwen3-8b',
    defaultEmbedding: 'text-embedding-nomic-embed-text-v1.5',
    hint: '需在 LM Studio 里开启本地服务器（默认 1234 端口）。',
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
        hint: '填写 OpenAI 兼容或 Anthropic 兼容接口的 Base URL，并选择请求协议。',
        apiKeyPlaceholder: 'API Key',
      },
    ],
    chatModels: [],
    embeddingModels: [],
    hint: '可接入任何 OpenAI 兼容（/chat/completions）或 Anthropic 兼容（/v1/messages）服务。',
  },
];

export function catalogProviderById(id: string): CatalogProvider | undefined {
  return MODEL_CATALOG.find((provider) => provider.id === id);
}
