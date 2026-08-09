import { z } from 'zod';

export const sourceSpanSchema = z.object({
  chunkId: z.string().min(1),
  quote: z.string().min(1).max(600),
});

export const factSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  sources: z.array(sourceSpanSchema).min(1),
});

export const ingestRelationSchema = z.object({
  src: z.string().default(''),
  word: z.string().default(''),
  dst: z.string().default(''),
  factId: z.string().optional().default(''),
});

export const candidateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['concept', 'person', 'project', 'org']),
  domain: z.string().optional().default(''),
  summary: z.string().optional().default(''),
  facts: z.array(factSchema).default([]),
  // relations 字段宽容化：LLM 偶尔返回字段不全的 relation，缺失字段填空串而非整体校验失败；
  // 整个 relations 异常时回退为空数组，不拖垮该 candidate
  relations: z.array(
    ingestRelationSchema.catch({ src: '', word: '', dst: '', factId: '' })
  ).catch([]).default([]),
});

/** 宽容化清洗 LLM 返回的 candidates（与 relations 的宽容策略一致）：
 *  - 超过上限的候选直接截断取前 N 个（LLM 通常按显著性排序）；
 *  - 丢弃字段不全的 fact（缺 id/statement）或其 source（缺 chunkId/quote），避免单个坏条目拖垮整次校验；
 *  - candidates 非数组时回退为空数组。
 *  背景：LLM 偶尔返回 >12 个候选且后半部分 facts 字段不全，严格校验会让整次 ingest-map 失败。 */
function sanitizeCandidates(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((candidate: any) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const facts = Array.isArray(candidate.facts)
        ? candidate.facts
            .filter((f: any) => f && typeof f === 'object'
              && typeof f.id === 'string' && f.id.trim().length > 0
              && typeof f.statement === 'string' && f.statement.trim().length > 0)
            .map((f: any) => {
              const sources = Array.isArray(f.sources)
                ? f.sources.filter((s: any) => s && typeof s === 'object'
                    && typeof s.chunkId === 'string' && s.chunkId.trim().length > 0
                    && typeof s.quote === 'string' && s.quote.trim().length > 0)
                : [];
              return sources.length > 0 ? { ...f, sources } : null;
            })
            .filter((f: any): f is object => f !== null)
        : [];
      return { ...candidate, facts };
    })
    .filter((candidate: any): candidate is object => candidate !== null)
    .slice(0, max);
}

export const mapOutputSchema = z.object({ candidates: z.preprocess((v) => sanitizeCandidates(v, 12), z.array(candidateSchema).max(12).default([])) });
export const normalizeOutputSchema = z.object({ candidates: z.preprocess((v) => sanitizeCandidates(v, 24), z.array(candidateSchema).max(24).default([])) });

/** kind 中文->英文映射（LLM 偶尔返回中文枚举值） */
const KIND_MAP: Record<string, string> = {
  concept: 'concept', '概念': 'concept',
  person: 'person', '人物': 'person', '人': 'person',
  project: 'project', '项目': 'project',
  org: 'org', '组织': 'org', '机构': 'org', '产品': 'concept', '框架': 'concept', '技术': 'concept',
};
/** action 中文->英文映射 */
const ACTION_MAP: Record<string, string> = {
  create: 'create', '新建': 'create', '创建': 'create', '新增': 'create',
  merge: 'merge', '合并': 'merge',
  skip: 'skip', '跳过': 'skip',
  review: 'review', '审核': 'review', '待审': 'review', '审查': 'review',
};

function mapEnum(value: unknown, map: Record<string, string>, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return map[value.trim().toLowerCase()] || map[value.trim()] || value.trim();
}

export const planItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.preprocess((v) => mapEnum(v, KIND_MAP, 'concept'), z.enum(['concept', 'person', 'project', 'org'])),
  action: z.preprocess((v) => mapEnum(v, ACTION_MAP, 'review'), z.enum(['create', 'merge', 'skip', 'review'])),
  target: z.string().optional().default(''),
  domain: z.string().optional().default(''),
  confidence: z.enum(['高', '中', '低']).default('中'),
  summary: z.string().optional().default(''),
  factIds: z.array(z.string()).default([]),
  relations: z.array(ingestRelationSchema).default([]),
  reason: z.string().optional().default(''),
  ambiguity: z.object({
    category: z.enum(['role_title', 'possible_typo']),
    label: z.string(),
    question: z.string(),
    suggestions: z.array(z.object({
      id: z.string().optional(),
      title: z.string(),
      type: z.string(),
      score: z.number(),
      reason: z.string(),
    })).default([]),
  }).optional(),
});
export const planOutputSchema = z.object({ items: z.array(planItemSchema).max(12).default([]) });

export const criticOutputSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()).default([]),
  items: z.array(planItemSchema).max(12).default([]),
});

export const composedItemSchema = planItemSchema.extend({ content: z.string().default('') });
export const composeOutputSchema = z.object({ items: z.array(composedItemSchema).max(12).default([]) });

/** Compose 阶段 LLM 实际输出的精简结构：只需 name + content（正文）。
 *  其余字段（kind/action/target/...）从 plan 继承，降低模型输出负担。 */
export const composeItemOutputSchema = z.object({
  name: z.string().trim().min(1),
  content: z.string().min(1).max(3000), // 非空，上限防失控
});
export const composeItemOutputListSchema = z.object({
  items: z.array(composeItemOutputSchema).max(12).default([]),
});

export const questionOutputSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    factIds: z.array(z.string()).default([]),
    acceptance: z.array(z.string()).default([]),
  })).max(12).default([]),
});

export const verifierOutputSchema = z.object({
  items: z.array(z.object({
    name: z.string(),
    pass: z.boolean(),
    unsupported: z.array(z.string()).default([]),
    conflicts: z.array(z.string()).default([]),
    content: z.string().default(''),
  })).default([]),
});

export type SourceSpan = z.infer<typeof sourceSpanSchema>;
export type Fact = z.infer<typeof factSchema>;
export type IngestRelation = z.infer<typeof ingestRelationSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type ComposedItem = z.infer<typeof composedItemSchema>;
export type QuestionOutput = z.infer<typeof questionOutputSchema>;
export type VerifierOutput = z.infer<typeof verifierOutputSchema>;

export interface DocumentChunk {
  id: string;
  index: number;
  heading: string;
  content: string;
  start: number;
  end: number;
}

export interface StructuredDocument {
  path: string;
  title: string;
  contentHash: string;
  text: string;
  chunks: DocumentChunk[];
}
