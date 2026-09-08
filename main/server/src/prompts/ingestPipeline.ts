import { PERSONA, PRINCIPLES, relationVocabHint } from './common.js';

const JSON_ONLY = '只输出合法 JSON 对象，不要 Markdown 围栏、解释或额外文字。';
const LATEST_BATCH_ONLY = '历史中的 user/assistant 轮次是已完成批次，仅用于保持缓存前缀。只处理最后一条 user 输入，不得重复、补写或修改更早批次。';

/** 所有管线阶段共用的稳定长前缀（人设+原则+关系词表+批次规则，约 4 个 64-token 块）。
 *  provider 前缀缓存按块复用：任一阶段先跑后，其余阶段的首个请求也能命中这段共享前缀，
 *  避免每个阶段的首请求都整段 miss。新增阶段 prompt 必须以本前缀开头。 */
export const SHARED_HEADER = `${PERSONA}\n${PRINCIPLES}\n${relationVocabHint()}\n${LATEST_BATCH_ONLY}\n`;

export const mapPrompt = `${SHARED_HEADER}执行 Map。从 input.content 分段抽取候选与原子事实。
【约束】fact.sources[].quote 必须逐字存在于分段原文；fact id 用 chunkId 前缀；最多 16 个候选；不决定建页或合并。
输出 {"candidates":[{"name":"","kind":"concept|person|customer|org|place|work|project|other","domain":"","summary":"","facts":[{"id":"","statement":"","sources":[{"chunkId":"","quote":""}]}],"relations":[]}]}`;

export const normalizePrompt = `${SHARED_HEADER}执行 Normalize：只判断哪些候选 ID 指向同一知识对象。代码会保留并合并原候选的全部事实和引文，因此不要复述 facts，也不要输出没有发生合并的候选。\n【别名/错别字合并规则】同一实体可能以不同称谓或错别字出现，必须合并为一组：\n- 职务称谓归并到姓名：如"刘经理"+"刘子谕"->"刘子谕"\n- 录音转写/OCR 常见错别字和同音字归并到正确名：如"信捷"可能被误录为"新建/新杰/迅捷"，"智核"可能被误录为"智和/志和"——当候选名与已有实体名高度相似（仅一字之差/同音/偏旁不同）且上下文指向同一对象时，合并到正确名\n- 仅在上下文有明确依据时合并；不确定是否同一实体时保留为独立候选（留给 Plan 阶段标 review）\n每个 candidateId 最多出现在一个 merge 中；canonicalId 必须同时包含在 memberIds 中。合并后 name 取正确/全名，kind/domain/summary 描述合并后的对象。输出 {"merges":[{"canonicalId":"","memberIds":[],"name":"","kind":"concept|person|customer|org|place|work|project|other","domain":"","summary":""}]}。没有需要合并的候选时输出 {"merges":[]}。${JSON_ONLY}`;
export const planPrompt = `${SHARED_HEADER}执行 Plan。对 input.candidates 决定 create/merge/skip/review。
【约束】每个 candidateId 恰好输出一次；泛概念 skip；与名录同对象 merge（target 填名录名）；事实冲突或身份不清 review；每项列 factIds。
输出 {"items":[{"candidateId":"","name":"","kind":"","action":"create|merge|skip|review","target":"","domain":"","confidence":"高|中|低","summary":"","factIds":[],"relations":[{"src":"","word":"","dst":"","factId":""}],"reason":""}]}`;
export const criticPrompt = `${SHARED_HEADER}执行 Critic。审查 input.plan：过度建页/错误合并/事实不足/冲突。
【约束】每个 candidateId 恰好输出一次；approved=true 且无 issues 时原样通过；需修订时输出修订后的 items。
输出 {"approved":bool,"issues":["..."],"items":[PlanItem]}`;

export const composePrompt = `${SHARED_HEADER}执行 Compose。为 input.items 各生成正文（改写不搬运、双链只指名录、时间线只记关键事件）。
【约束】每个 candidateId 恰好输出一次；正文 150-400 字。
输出 {"items":[{"candidateId":"","name":"","content":""}]}`;
export const questionFinderPrompt = `${SHARED_HEADER}执行 Question Finder。对 input 中身份不清/冲突/低置信的候选生成可操作的澄清问题。
【约束】只对需要人工确认的事实提问；factIds 引用相关事实。
输出 {"questions":[{"question":"","factIds":[],"acceptance":["可接受的答案类型"]}]}`;
export const verifierPrompt = `${SHARED_HEADER}执行 Verifier。校验 input.items 正文是否被 facts 支持、与 questions 冲突。
【约束】每个 candidateId 恰好输出一次；无依据内容删除或改写进 content；pass=false 需列 unsupported/conflicts。
输出 {"items":[{"candidateId":"","name":"","pass":bool,"unsupported":[],"conflicts":[],"content":""}]}`;
