import { getAgentConfig, bundledDshHome, type AgentConfig } from '../assistant/config.js';
import { officialKeyRef, readAgentModelConfig } from './agentModelConfig.js';
import { modelKeyRef } from './videoModel.js';
import {
  completeText,
  ModelOutputTruncatedError,
  type ChatMessage,
} from './modelClient.js';

/**
 * 编辑页的「就地 AI」：右击插入 / 改选中文字 / 接着写 / 全文格式美化。
 *
 * 与聊天抽屉里的内置 Agent 刻意分开：这些动作的结果要**立刻落回光标位置**，走一次性的
 * 补全请求（`lib/modelClient.ts`）比起一轮 dsh 会话稳得多——不需要工具调用、不会写文件、
 * 不会和编辑器里未保存的正文打架。模型路由复用内置 Agent 已配置的那一条（旧版 Engram
 * 配置优先，其次读 dsh 控制台写下的 profile patch / 凭据文件），没配 Key 明确失败。
 */

export const EDITOR_AI_TASKS = ['insert', 'rewrite', 'continue', 'beautify'] as const;
export type EditorAiTask = (typeof EDITOR_AI_TASKS)[number];

/** 指令上限：再长就不是「一句话让 AI 写」了 */
export const EDITOR_AI_MAX_INSTRUCTION = 2000;
/** 选中文字上限：改写的输出预算装不下更长的段落 */
export const EDITOR_AI_MAX_SELECTION = 12000;
/** 插入/改写时带上的前后文上限（字符）：给模型足够语境，又不至于把整篇长文塞进去 */
export const EDITOR_AI_MAX_BEFORE = 6000;
export const EDITOR_AI_MAX_AFTER = 3000;
/** 全文美化的输入上限：超过这个量级请用户分段处理，避免一次请求跑太久 */
export const BEAUTIFY_MAX_DOCUMENT = 40000;
/** 美化单次输出的 token 预算；中文约 1 字 1 token，8192 能装下多数单页文档 */
export const BEAUTIFY_MAX_TOKENS = 8192;

export interface EditorAiInput {
  task: EditorAiTask;
  instruction?: string;
  title?: string;
  /** 全文美化：整篇正文（不含 frontmatter） */
  document?: string;
  /** 改写：选中的原文 */
  selection?: string;
  /** 插入点之前的正文（截断到 EDITOR_AI_MAX_BEFORE） */
  before?: string;
  /** 插入点之后的正文（截断到 EDITOR_AI_MAX_AFTER） */
  after?: string;
}

const SYSTEM_WRITER = [
  '你是 Engram 知识库里的 Markdown 写作助手。',
  '你的输出会直接写进用户的正文，所以只输出结果本身：不要解释、不要客套、不要用代码块把整段结果包起来。',
  '使用标准 Markdown（标题、列表、引用、表格、围栏代码块、[[双链]]）。',
  '不要编造事实；不确定的内容不要写。',
].join('\n');

const SYSTEM_BEAUTIFY = [
  '你是严格保留事实的 Markdown 排版整理器。',
  '你的输出会直接覆盖一篇知识库文档，所以只输出整理后的完整 Markdown：不要解释、不要客套、不要用代码块把全文包起来。',
].join('\n');

function clip(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

/**
 * 拼一次就地 AI 的消息。纯函数，便于单测钉住四类任务的提示词边界。
 * 调用方负责长度校验；这里仍做一次裁剪，避免脏请求把整篇长文塞进模型。
 */
export function buildEditorAiMessages(input: EditorAiInput): ChatMessage[] {
  const title = String(input.title ?? '').trim();
  const instruction = clip(input.instruction, EDITOR_AI_MAX_INSTRUCTION).trim();
  const before = clip(input.before, EDITOR_AI_MAX_BEFORE).trim();
  const after = clip(input.after, EDITOR_AI_MAX_AFTER).trim();
  const selection = clip(input.selection, EDITOR_AI_MAX_SELECTION).trim();

  if (input.task === 'beautify') {
    const document = String(input.document ?? '');
    return [
      { role: 'system', content: SYSTEM_BEAUTIFY },
      {
        role: 'user',
        content: [
          '把下面这篇 Markdown 文档整理成结构清晰、格式完整的 Markdown。要求：',
          '- 补全标题层级（##、###…），正文不要新增一级标题（页面标题由编辑器单独维护）；保持原文已有标题的级别，不要整体升级或降级；',
          '- 把并列的条目整理成无序 / 有序 / 任务列表；多列数据整理成 Markdown 表格，补齐分隔行；',
          '- 补全围栏代码块的语言标记并确保围栏闭合；行内代码、链接、图片保持原样；',
          '- 段落之间留一个空行，引用块用 >，分割线用 ---；',
          '- 不增删事实，不改写措辞，不翻译，不总结，不添加原文没有的内容；',
          '- [[双链]]、图片/链接地址、形如 [managed](#ingest-preserved-...) 的占位链接必须原样保留；',
          '- 只输出整理后的完整 Markdown，不要解释，不要用代码块包裹全文。',
          title ? `\n文档标题：${title}` : '',
          '\n【文档正文开始】',
          document,
          '【文档正文结束】',
        ].filter(Boolean).join('\n'),
      },
    ];
  }

  if (input.task === 'rewrite') {
    return [
      { role: 'system', content: SYSTEM_WRITER },
      {
        role: 'user',
        content: [
          title ? `页面标题：${title}\n` : '',
          '【需要改写的原文】',
          selection || '（空）',
          before ? `\n【上文】\n${before}` : '',
          after ? `\n【下文】\n${after}` : '',
          `\n【用户要求】\n${instruction || '把这段文字改写得通顺、清楚，保持原意。'}`,
          '',
          '只输出改写后的这段文字，不要解释、不要加引号、不要用代码块包裹整段。',
          '保留原文里的数字、专名、[[双链]]、链接与代码，除非用户明确要求改动。',
        ].filter(Boolean).join('\n'),
      },
    ];
  }

  if (input.task === 'continue') {
    return [
      { role: 'system', content: SYSTEM_WRITER },
      {
        role: 'user',
        content: [
          title ? `页面标题：${title}\n` : '',
          '【已经写好的上文（用户选中了它，要求从这里接着写）】',
          selection || '（空）',
          after ? `\n【已有的下文】\n${after}` : '',
          `\n【用户要求】\n${instruction || '顺着上文自然地接着写一段。'}`,
          '',
          '只输出新增的内容，不要重复已经写过的文字，不要解释，不要用代码块包裹整段。',
        ].filter(Boolean).join('\n'),
      },
    ];
  }

  return [
    { role: 'system', content: SYSTEM_WRITER },
    {
      role: 'user',
      content: [
        title ? `页面标题：${title}\n` : '',
        '【插入位置之前的正文】',
        before || '（文档开头）',
        '\n【插入位置】',
        after ? `\n【插入位置之后的正文】\n${after}` : '（文档结尾）',
        `\n【用户要求】\n${instruction || '在这里补一段合适的内容。'}`,
        '',
        '请只输出要插入到【插入位置】的 Markdown 内容。',
        '如果插入的是块级内容（标题、列表、表格、代码块），前后各留一个空行；如果是接续句子，就只输出句子本身。',
        '不要重复插入位置前后的已有内容。',
      ].filter(Boolean).join('\n'),
    },
  ];
}

/**
 * 清掉模型常见的「包装」：整段代码围栏、开头一句「以下是…」。
 * 只处理明确的整体包裹，不改动正文内部的围栏代码块。
 */
export function cleanEditorAiOutput(raw: string): string {
  let text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return '';
  const wholeFence = /^```(?:markdown|md|mdx)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (wholeFence) text = wholeFence[1].trim();
  text = text.replace(
    /^(?:好的[，,]\s*)?(?:以下|下面)(?:是|为)[^\n]{0,40}[：:]\s*\r?\n\r?\n/,
    '',
  );
  return text.trim();
}

/** 围栏数量：美化结果必须闭合（门禁之一） */
function fenceCount(text: string): number {
  return (text.match(/^\s*(?:```|~~~)/gm) || []).length;
}

/** 受保护片段：双链、图片、占位链接——美化不得丢 */
export function protectedEditorSnippets(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\[\[[^\]\n]+\]\]/g,
    /!\[[^\]\n]*\]\([^)\n]+\)/g,
    /\[[^\]\n]*\]\(#ingest-preserved-[^)\n]+\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}

/**
 * 美化结果的验收门禁：宁可报错让用户重试，也不要把「被摘要掉的半篇文档」覆盖进正文。
 * 返回 null 表示通过，否则是给人看的拒绝原因。
 */
export function validateBeautified(original: string, result: string): string | null {
  const source = String(original ?? '');
  const text = String(result ?? '').trim();
  if (!text) return '模型没有返回整理结果';
  if (fenceCount(text) % 2 !== 0) return '整理结果里有未闭合的代码围栏，已放弃替换';
  const ratio = text.length / Math.max(1, source.length);
  if (source.length > 200 && ratio < 0.5) return '整理结果明显短于原文，可能丢失内容，已放弃替换';
  if (ratio > 2.5) return '整理结果明显长于原文，可能加入了原文没有的内容，已放弃替换';
  for (const snippet of protectedEditorSnippets(source)) {
    if (!text.includes(snippet)) {
      const label = snippet.length > 32 ? `${snippet.slice(0, 32)}…` : snippet;
      return `整理结果丢失了原文里的 ${label}，已放弃替换`;
    }
  }
  return null;
}

/**
 * 输出被 token 上限截断时，把文档在「围栏代码块之外的空行」处对半拆开重试。
 * 优先选后面紧跟标题的空行，让每段尽量以完整小节开头；找不到可拆点返回空数组。
 */
export function splitMarkdownForRetry(text: string): string[] {
  const source = String(text ?? '');
  if (source.length < 200) return [];
  const lines = source.split(/\r?\n/);
  const candidates: Array<{ line: number; heading: boolean }> = [];
  let fenced = false;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[index])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!lines[index].trim() && lines[index + 1].trim()) {
      const next = lines[index + 1].trim();
      candidates.push({ line: index, heading: /^#{1,6}\s/.test(next) });
    }
  }
  if (!candidates.length) return [];
  const middle = lines.length / 2;
  const headingCandidates = candidates.filter((candidate) => candidate.heading);
  const pool = headingCandidates.length ? headingCandidates : candidates;
  const picked = pool.reduce((best, candidate) => (
    Math.abs(candidate.line - middle) < Math.abs(best.line - middle) ? candidate : best
  ));
  const head = lines.slice(0, picked.line + 1).join('\n').trim();
  const tail = lines.slice(picked.line + 1).join('\n').trim();
  if (head.length < 80 || tail.length < 80) return [];
  return [head, tail];
}

/**
 * 从内置 Agent 的配置解析「工具类补全」该用哪条路由。
 *
 * 优先级：
 *  1. 旧版 Engram 保存的 Key（升级用户继续可用）；
 *  2. 环境变量（部署时注入）；
 *  3. dsh 控制台写下的 profile patch + `.credentials.yaml`（新用户只在这里配过）。
 *
 * 官方 provider 留空 baseUrl，让 modelClient 走官方默认地址（DEEPSEEK_BASE_URL 仍可用）；
 * 自定义 provider 带上它的 baseURL / 线协议。解析不到就是空对象，由 modelClient 明确报「未配置」。
 */
export function resolveEditorModelConfig(options: {
  legacy?: AgentConfig;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): AgentConfig {
  const env = options.env ?? process.env;
  const legacy = options.legacy ?? getAgentConfig();
  if ((legacy.apiKey || '').trim()) return legacy;

  const home = options.home ?? bundledDshHome();
  let synced: ReturnType<typeof readAgentModelConfig>;
  try {
    synced = readAgentModelConfig(home);
  } catch {
    synced = { version: 1, official: {}, providers: {}, default: { provider: '', model: '' }, keys: {} };
  }
  // dsh 没显式写过 agent-default-model 时按它自己的兜底走：官方 provider + 目录里的第一个模型。
  // 只认 patch 里的显式默认会让「只在控制台填了 Key、没手动选模型」的用户直接报未配置。
  let providerId = String(synced.default?.provider || '').trim();
  if (!providerId) {
    providerId = (synced.official.models?.length ? 'deepseek-official' : Object.keys(synced.providers)[0]) || '';
  }
  let model = String(synced.default?.model || '').trim();
  if (!model && providerId === 'deepseek-official') {
    model = String(synced.official.models?.[0]?.id || '').trim();
  }
  if (!model && providerId && providerId !== 'deepseek-official') {
    model = String(synced.providers[providerId]?.models?.[0]?.id || '').trim();
  }

  if (!providerId) {
    const envKey = String(env.DEEPSEEK_API_KEY || '').trim();
    return envKey ? { apiKey: envKey } : {};
  }

  if (providerId === 'deepseek-official') {
    const keyRef = officialKeyRef(synced.official);
    const apiKey = String(synced.keys[keyRef] || env[keyRef] || '').trim();
    const baseUrl = String(synced.official.baseURL || '').trim();
    return {
      apiKey,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl, api: 'openai-completions' } : {}),
    };
  }

  const provider = synced.providers[providerId];
  if (!provider) return {};
  const keyRef = modelKeyRef(providerId, provider.apiKeyEnv);
  const apiKey = String(synced.keys[keyRef] || env[keyRef] || '').trim();
  return {
    apiKey,
    ...(model ? { model } : {}),
    ...(provider.baseURL ? { baseUrl: provider.baseURL } : {}),
    api: provider.api || 'openai-completions',
  };
}

export interface BeautifyOptions {
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  config?: AgentConfig;
  /** 仅供测试注入 */
  complete?: typeof completeText;
}

/**
 * 全文格式美化：一次请求；输出被截断时按小节拆开重试（最多两层）。
 * 最终结果由调用方过 `validateBeautified`。
 */
export async function beautifyDocument(
  document: string,
  options: BeautifyOptions = {},
): Promise<{ text: string; chunks: number }> {
  const complete = options.complete ?? completeText;
  const config = options.config ?? resolveEditorModelConfig();

  const run = async (text: string, depth: number): Promise<{ text: string; chunks: number }> => {
    try {
      const result = await complete(buildEditorAiMessages({ task: 'beautify', document: text }), {
        maxTokens: options.maxTokens ?? BEAUTIFY_MAX_TOKENS,
        temperature: 0.1,
        timeoutMs: options.timeoutMs ?? 240_000,
        signal: options.signal,
        config,
      });
      return { text: cleanEditorAiOutput(result.text), chunks: 1 };
    } catch (error) {
      if (!(error instanceof ModelOutputTruncatedError) || depth >= 2) throw error;
      const parts = splitMarkdownForRetry(text);
      if (parts.length < 2) throw error;
      let chunks = 0;
      const outputs: string[] = [];
      for (const part of parts) {
        const result = await run(part, depth + 1);
        outputs.push(result.text);
        chunks += result.chunks;
      }
      return { text: outputs.filter(Boolean).join('\n\n'), chunks };
    }
  };

  return run(String(document ?? ''), 0);
}
