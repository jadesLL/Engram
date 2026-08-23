import { PERSONA, PRINCIPLES, relationVocabHint } from './common.js';

const JSON_ONLY = '只输出合法 JSON 对象，不要 Markdown 围栏、解释或额外文字。';
const LATEST_BATCH_ONLY = '历史中的 user/assistant 轮次是已完成批次，仅用于保持缓存前缀。只处理最后一条 user 输入，不得重复、补写或修改更早批次。';

/** 所有管线阶段共用的稳定长前缀（人设+原则+六词表+批次规则，约 4 个 64-token 块）。
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
/** 常见角色模板库：AI 根据实体的事实内容判断角色，选择或参考生成章节结构 */
const ROLE_TEMPLATES = `【常见角色模板库】先根据事实内容判断实体属于哪个角色，再用对应章节。没有事实支撑的章节应省略。不限于以下列表——遇到不常见的角色，参考这些模板的大体结构（概述 → 按事实维度分章节 → 相关页面）自行生成合适章节。

客户（购买产品/服务的客户企业）：
- 开头 1-3 句概述（不加标题）
- ## 客户画像：行业、体量、现有设备/方案、合作状态
- ## 核心卡点：阻碍合作推进的关键问题（分点）
- ## 合作策略：正在执行或计划中的行动（分点）

供应商（提供产品/技术的供应方）：
- 开头 1-3 句概述
- ## 产品与服务：供应的产品线、技术能力、优势
- ## 合作关系：合作模式、商务条件、配合状态

渠道商/代理商（代理销售的中间方）：
- 开头 1-3 句概述
- ## 代理范围与区域：代理的产品线、覆盖区域
- ## 合作状态：激活/休眠、业绩、跟进情况
- ## 赋能支持：给予的培训、资源、支持计划

员工（内部团队成员）：
- 开头 1-3 句概述
- ## 角色与职责：承担的职责、在组织中的位置
- ## 负责业务：具体负责的客户、项目、区域
- ## 关联实体：与哪些项目/组织有明确关系（[[双链]]）

外部联系人（客户方/合作方的人员）：
- 开头 1-3 句概述
- ## 身份与背景：所在公司、职务、决策角色
- ## 交互记录：关键接触、沟通内容

产品（具体的产品/技术方案）：
- 开头 1-3 句概述
- ## 产品定位：核心价值、目标场景
- ## 核心特性：关键功能、技术指标（保留数据）
- ## 应用场景：实际使用案例

技术概念（方法论/标准/理念）：
- 开头 1-3 句概述
- ## 核心要点：关键定义、规则、标准（分点，保留具体数据和条件）
- ## 实践应用：在本业务中的落地方式`;

export const composePrompt = `${SHARED_HEADER}执行 Compose。为 input.items 各生成正文（改写不搬运、双链只指名录、时间线只记业务事件）。
【约束】每个 candidateId 恰好输出一次；正文 150-400 字。
输出 {"items":[{"candidateId":"","name":"","content":""}]}`;
export const questionFinderPrompt = `${SHARED_HEADER}执行 Question Finder。对 input 中身份不清/冲突/低置信的候选生成可操作的澄清问题。
【约束】只对需要人工确认的事实提问；factIds 引用相关事实。
输出 {"questions":[{"question":"","factIds":[],"acceptance":["可接受的答案类型"]}]}`;
export const verifierPrompt = `${SHARED_HEADER}执行 Verifier。校验 input.items 正文是否被 facts 支持、与 questions 冲突。
【约束】每个 candidateId 恰好输出一次；无依据内容删除或改写进 content；pass=false 需列 unsupported/conflicts。
输出 {"items":[{"candidateId":"","name":"","pass":bool,"unsupported":[],"conflicts":[],"content":""}]}`;
