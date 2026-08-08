/**
 * ingest 提炼提示词：把原始资料提炼为概念/实体页面。
 * 检索增强：携带已有实体名录 + 相关命中片段，让 LLM 能关联、能 merge、能避免死链。
 */
import { PERSONA, PRINCIPLES, relationVocabHint, entityRosterContext } from './common.js';

export interface IngestItem {
  name: string;
  kind: 'concept' | 'person' | 'project' | 'org';
  action: 'create' | `merge:${string}` | 'skip';
  domain?: string;
  confidence?: '高' | '中' | '低';
  summary?: string;
  content: string;
}

export interface IngestRelation {
  src: string;
  word: string;
  dst: string;
}

export interface IngestOutput {
  items: IngestItem[];
  relations: IngestRelation[];
}

const FEW_SHOT = `【示例】
资料：《2026Q3 华北大区运营会议纪要》，主要内容是华北大区 Q3 目标、张三负责冲刺、李四带教新人。
输出：
{"items":[{"name":"华北大区","kind":"org","action":"merge:华北大区","domain":"销售","confidence":"高","summary":"若名录已有华北大区则合并补充本季目标","content":"本季华北大区目标……（改写，链接 [[张三]] [[李四]]）"}],"relations":[{"src":"张三","word":"主责","dst":"华北大区"}]}
说明：若"华北大区"已在名录中 -> merge:华北大区（合并补充）；若资料是某人物的完整系统性档案且名录无对应页 -> action=create。

资料：一段闲聊或单条零散数据，无系统性内容。
输出：{"items":[],"relations":[]}`;

export function ingestSystem(roster: string, relatedSnippet: string): string {
  return `${PERSONA}

${PRINCIPLES}

${relationVocabHint()}

【任务】阅读下面给出的原始资料，提炼出值得长期沉淀的概念/实体页面。

【输出格式】只输出一个 JSON 对象，结构如下：
{"items":[{"name":"页面标题","kind":"concept|person|project|org","action":"create|merge:已有实体名|skip","domain":"所属领域","confidence":"高|中|低","summary":"一句话摘要","content":"页面正文 markdown，150-400字"}],"relations":[{"src":"实体A","word":"关系词","dst":"实体B"}]}

字段说明：
- kind：concept=抽象概念/方法/理论；person=人物；project=项目/产品；org=组织/公司
- action：
  - create：值得独立建页（满足"2+来源"或"单一来源核心内容，系统性方法论/完整档案，相当于40+行"）
  - merge:已有实体名：单次讲话/会议纪要/月度速报等，应合并到名录中已有的相关实体（如讲话人、涉及公司）
  - skip：不值得沉淀
- content：独立的知识页面正文（重新组织语言，禁止照抄原文，**控制在 150-300 字**），相关概念/实体用 [[双链]] 标注（只能链名录或本批新建项）
- relations：从资料中识别出的六词表关系（无则空数组）；src/dst 必须是名录或本批新建项中的实体名
- 提炼 1-6 个最重要的条目；无内容输出 {"items":[],"relations":[]}
- 只输出 JSON，不要任何解释、Markdown 围栏或多余文字

${FEW_SHOT}
${entityRosterContext(roster)}
${relatedSnippet ? `\n【库内已有相关内容（供参考，可据此判断 create/merge/skip）】\n${relatedSnippet}\n` : ''}`;
}

export function ingestUser(text: string): string {
  return `原始资料：\n\n${text}`;
}
