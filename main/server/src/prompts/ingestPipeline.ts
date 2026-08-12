import { PERSONA, PRINCIPLES, relationVocabHint } from './common.js';

const JSON_ONLY = '只输出合法 JSON 对象，不要 Markdown 围栏、解释或额外文字。';
const LATEST_BATCH_ONLY = '历史中的 user/assistant 轮次是已完成批次，仅用于保持缓存前缀。只处理最后一条 user 输入，不得重复、补写或修改更早批次。';

export const mapPrompt = `${PERSONA}\n${PRINCIPLES}\n${relationVocabHint()}\n${LATEST_BATCH_ONLY}\n你正在执行 Map。请求 JSON 的 sharedContext 包含已有标题 roster；input 包含 chunkId、分段位置和 content。仅抽取当前分段明确支持的长期知识候选和原子事实。每个事实的 sources[].chunkId 必须逐字复制 input.chunkId，quote 必须逐字存在于 input.content；fact id 使用同一个 chunkId 作为前缀。不要决定建页或合并。当前分段最多输出 16 个候选；如果内容过密，优先保留有明确名称和事实依据的候选，不得输出不完整 JSON。输出结构为 {"candidates":[{"name":"","kind":"concept|person|project|org","domain":"","summary":"","facts":[{"id":"","statement":"","sources":[{"chunkId":"","quote":""}]}],"relations":[]}]}。roster 仅用于统一命名。${JSON_ONLY}`;

export const normalizePrompt = `${PERSONA}\n${LATEST_BATCH_ONLY}\n执行 Normalize：只判断哪些候选 ID 指向同一知识对象。代码会保留并合并原候选的全部事实和引文，因此不要复述 facts，也不要输出没有发生合并的候选。\n【别名/错别字合并规则】同一实体可能以不同称谓或错别字出现，必须合并为一组：\n- 职务称谓归并到姓名：如"刘经理"+"刘子谕"->"刘子谕"\n- 录音转写/OCR 常见错别字和同音字归并到正确名：如"信捷"可能被误录为"新建/新杰/迅捷"，"智核"可能被误录为"智和/志和"——当候选名与已有实体名高度相似（仅一字之差/同音/偏旁不同）且上下文指向同一对象时，合并到正确名\n- 仅在上下文有明确依据时合并；不确定是否同一实体时保留为独立候选（留给 Plan 阶段标 review）\n每个 candidateId 最多出现在一个 merge 中；canonicalId 必须同时包含在 memberIds 中。合并后 name 取正确/全名，kind/domain/summary 描述合并后的对象。输出 {"merges":[{"canonicalId":"","memberIds":[],"name":"","kind":"concept|person|project|org","domain":"","summary":""}]}。没有需要合并的候选时输出 {"merges":[]}。${JSON_ONLY}`;
export const planPrompt = `${PERSONA}\n${PRINCIPLES}\n${LATEST_BATCH_ONLY}\n执行 Plan。请求 JSON 的 sharedContext 包含已有实体名录 roster 和检索到的相关内容 related；input 包含 candidates。对候选决定 create/merge/skip/review。\n【完整覆盖】输入中的每个 candidateId 必须且只能输出一次，不得遗漏、重复或修改 candidateId。\n【克制建页】只对值得长期沉淀的实体/概念提出 create。自动新建所需的跨来源数量由后端门禁判断，因此即使当前只有一个来源，只要候选本身值得长期沉淀，仍应输出 create，不要仅因单一来源改成 skip。\n以下情况应 skip 或 review：\n- 泛概念/通用词（如"技术""销售""产品"本身不是知识实体）→ skip\n- 候选名疑似错别字/同音字，且 roster 中有高度相似的正确名 → merge 到正确名（如"新建"->"信捷"）；不确定时 → review 注明疑似错别字\n- 事实本身不明确、互相冲突或类型不清 → review，不要硬写\n【合并优先】新候选若与 roster 中的实体指代同一对象（含别名/简称/错别字），merge 到已有实体，target 填已有实体名。\n每项列出使用的 factIds；有明确关系时输出 relations，关系必须引用支持它的 factId。输出 {"items":[{"candidateId":"","name":"","kind":"concept|person|project|org","action":"create|merge|skip|review","target":"","domain":"","confidence":"高|中|低","summary":"","factIds":[],"relations":[{"src":"","word":"","dst":"","factId":""}],"reason":""}]}。kind 和 action 必须用英文枚举值。${JSON_ONLY}`;
export const criticPrompt = `${PERSONA}\n${LATEST_BATCH_ONLY}\n执行 Critic：请求 JSON 的 sharedContext 提供 roster 和 related；input 提供 plan、candidates，以及复核时的 previousCritique。检查计划是否过度建页、错误合并、事实证据不足或遗漏冲突。返回修订后的 items。\n输入 plan 中的每个 candidateId 必须且只能输出一次，不得遗漏、重复或修改 candidateId。\n【过度建页检查】以下情况应改为 skip 或 review：\n- 疑似错别字/同音字的 create 项，名录中有相似正确名 → merge 到正确名；不确定 → review 注明\n- 泛概念/通用词 → skip\n- 事实陈述本身不明确、冲突或低置信度 → review\n不要仅因当前来源数量为 1 或当前只有 1 条有效事实而把值得沉淀的 create 改为 skip；跨来源自动建页由后端门禁处理。\n若输入带 previousCritique，必须对上一轮修订结果复核；仍有问题时 approved=false，并将对应项置为 review。输出 {"approved":true,"issues":[],"items":[{"candidateId":"","name":"","kind":"concept|person|project|org","action":"create|merge|skip|review","target":"","domain":"","confidence":"高|中|低","summary":"","factIds":[],"relations":[{"src":"","word":"","dst":"","factId":""}],"reason":""}]}。kind 和 action 必须用英文枚举值，不要用中文。${JSON_ONLY}`;
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

export const composePrompt = `${PERSONA}\n${PRINCIPLES}\n${LATEST_BATCH_ONLY}\n执行 Compose。请求 JSON 的 sharedContext 包含已有实体名录 roster 和相关已有内容 related；input 包含 items 和 facts。为计划中的每个条目写结构化 Markdown 正文（content）。只用该条目列出的 factIds 对应的事实；关键事实尽量保留数据、时间和限定条件。\n【完整覆盖】输入 items 中的每个 candidateId 必须且只能输出一次，不得遗漏、重复或修改 candidateId。\n【写作要求】\n1. 直接输出知识内容，不要输出思考过程、指令复述或元描述（如"我们需要..."、"根据给定内容..."）\n2. 按事实维度组织章节，每个事实归入最合适的章节，不要把所有事实揉成一段扁平正文\n3. 信息少的条目可以短，信息丰富的条目充分展开——按事实的自然量写，不凑长度也不截断\n4. 用陈述句写客观事实，不要描述资料本身的结构（如"关系库记载..."）\n5. merge 的项只写本次新增的补充内容，不要重述已有内容\n6. 正文中的实体名用 [[双链]] 关联 roster 中的条目\n\n${ROLE_TEMPLATES}\n\n所有条目末尾统一加：\n## 相关页面：列出与本条目有明确关系的已有实体（[[双链]] + 简注关联原因），没有关联的则省略此章节\n\n【精简输出】只需输出每个条目的 candidateId、name 和 content，不要复述 kind/action/target 等其他字段。content 是完整的 Markdown 正文（含 ## 标题），不能为空。[[双链]] 只能指向 roster 或本次新建项；写正文时可参考、补充或对比 related。输出 {"items":[{"candidateId":"","name":"","content":""}]}。${JSON_ONLY}`;
export const questionFinderPrompt = `${PERSONA}\n${LATEST_BATCH_ONLY}\n执行 Question Finder：找出材料留下的关键未知项或矛盾。优先识别人物职务称谓（如“刘经理”“李总”）缺少完整姓名，以及候选名与已有实体仅一字之差、疑似录音/OCR 错别字的情况。输入中的 resolvedQuestions 是用户已经回答过的追问；不得再次提出与其语义等价的问题。只有回答与事实冲突或没有满足 acceptance 时，才提出范围更窄、明确指出缺失信息的后续问题。只提出对知识维护真正有价值、且无法由已有事实回答的问题，并为每个问题列出可操作的验收条件 acceptance。输出 {"questions":[{"question":"","factIds":[],"acceptance":[]}]}。${JSON_ONLY}`;
export const verifierPrompt = `${PERSONA}\n${LATEST_BATCH_ONLY}\n执行 Verifier。输入包含 Question Finder 的问题和验收条件；逐项核验正文中每个事实是否可由给定 fact sources 支持，并检查草稿是否与这些问题/验收信息冲突或虚构答案。输入 items 中的每个 candidateId 必须且只能输出一次，不得遗漏、重复或修改 candidateId。删除或改写无依据内容，不得新增事实。unsupported 与 conflicts 非空时 pass 必须为 false。输出 {"items":[{"candidateId":"","name":"","pass":true,"unsupported":[],"conflicts":[],"content":"修正后的正文"}]}。${JSON_ONLY}`;
