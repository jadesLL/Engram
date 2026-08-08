/** 内置 LLM 服务商预设：用户只需填 API Key，其余自动填充。
 *  模型清单 2026-08 经官方文档核对（DeepSeek/百炼/智谱/Kimi/硅基流动）。 */
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  chatModels: string[];
  defaultChat: string;
  /** 无 embedding 服务时为 null，需搭配其他厂商 */
  embedding: { model: string; dim: number } | null;
  hint?: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek（深度求索）',
    baseUrl: 'https://api.deepseek.com/v1',
    chatModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-0731'],
    defaultChat: 'deepseek-v4-flash',
    embedding: null,
    hint: 'DeepSeek 暂无 Embedding 服务，Embedding 需搭配其他厂商（推荐硅基流动 bge-m3，有免费额度）',
  },
  {
    id: 'aliyun',
    name: '通义千问（阿里百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModels: ['qwen3.7-plus', 'qwen3.8-max', 'qwen3.7-flash'],
    defaultChat: 'qwen3.7-plus',
    embedding: { model: 'text-embedding-v4', dim: 1024 },
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatModels: ['glm-5.2', 'glm-5.1'],
    defaultChat: 'glm-5.2',
    embedding: { model: 'embedding-3', dim: 2048 },
  },
  {
    id: 'moonshot',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    chatModels: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code'],
    defaultChat: 'kimi-k3',
    embedding: null,
    hint: 'Kimi 暂无 Embedding 服务，Embedding 需搭配其他厂商（推荐硅基流动 bge-m3）',
  },
  {
    id: 'doubao',
    name: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    chatModels: ['doubao-seed-1.6', 'doubao-seed-1.6-flash'],
    defaultChat: 'doubao-seed-1.6',
    embedding: { model: 'doubao-embedding-large', dim: 2048 },
    hint: '火山方舟模型名以控制台「在线推理」页面的接入点/模型 ID 为准（ep- 开头接入点也可直接填）',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    chatModels: ['deepseek-ai/DeepSeek-V3.2', 'moonshotai/Kimi-K2.6', 'Qwen/Qwen2.5-7B-Instruct'],
    defaultChat: 'deepseek-ai/DeepSeek-V3.2',
    embedding: { model: 'BAAI/bge-m3', dim: 1024 },
    hint: 'bge-m3 中文 embedding 效果好且有免费额度；模型广场可查到更多可填的模型 ID',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    chatModels: ['gpt-5.5', 'gpt-5.4-mini'],
    defaultChat: 'gpt-5.4-mini',
    embedding: { model: 'text-embedding-3-small', dim: 1536 },
  },
  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    chatModels: [],
    defaultChat: '',
    embedding: null,
    hint: '填写任何 OpenAI 兼容接口的 Base URL 与模型名',
  },
];

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
