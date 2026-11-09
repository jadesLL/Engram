/** Shared customer workflow: local skills are only launchers, never copies of this contract. */

/**
 * 客户调研 v3 契约（服务端唯一来源）。
 *
 * v1 的教训：8 个 ACS 章节在「没有资料」时逼模型把每个栏目写满，产出大量
 * 「资料不足 + 行业泛论 + 方法说明」；公司名称在工商信息里查不到时也照样写完整分析。
 * v2 把顺序倒过来：
 *  1. 先核验主体（identity），查不到就只出「主体核验」短报告并质疑客户是否存在；
 *  2. 再按证据量选模式（完整 / 简报 / 主体核验），证据不够不许写完整版；
 *  3. 每章有硬长度上限，禁止方法说明、能力声明和空话，只写能指回来源的结论。
 * v3 增加记录管理与入库纪律：完整报告自动入库、资料不足简报只在页面反馈；
 * 知识库已有该客户报告时必须先问用户「生成新版本 / 覆盖旧报告」再提交。
 * v4 在完整报告里固定加入「主要机型」与「竞品情况」两章：客户主要生产的设备机型、
 * 正在使用的竞品品牌/份额/合作深度是判断切入点的核心事实，两章各有引用门槛，
 * 没有依据就按证据量降级为简报，不许用行业泛论填空。
 *
 * 章节 id 是提交契约的一部分，不要改；标题可由用户在「流程与模板」里改。
 */
export const CUSTOMER_RESEARCH_SECTIONS = [
  { id: 'summary', title: '结论' },
  { id: 'identity', title: '客户主体与核实' },
  { id: 'facts', title: '已核实事实' },
  { id: 'models', title: '主要机型' },
  { id: 'competitors', title: '竞品情况' },
  { id: 'needs', title: '需求与机会' },
  { id: 'relationships', title: '决策链与关系' },
  { id: 'risks', title: '风险与反证' },
  { id: 'actions', title: '下一步行动' },
  { id: 'gaps', title: '待核实' },
] as const;

export type CustomerResearchMode = 'full' | 'brief' | 'identity-check';

/** 简报与主体核验用固定章节（不随「流程与模板」变，保证短报告结构稳定） */
export const CUSTOMER_RESEARCH_FIXED_SECTIONS: Record<
  Exclude<CustomerResearchMode, 'full'>,
  Array<{ id: string; title: string }>
> = {
  brief: [
    { id: 'summary', title: '结论' },
    { id: 'facts', title: '已知事实' },
    { id: 'gaps', title: '待核实' },
  ],
  'identity-check': [
    { id: 'summary', title: '核验结论' },
    { id: 'gaps', title: '需要你确认' },
  ],
};

/** 各模式每个章节的硬长度上限（字符数）：页面上要一眼扫得完，超了服务端直接拒收 */
export const CUSTOMER_RESEARCH_LIMITS: Record<CustomerResearchMode, Record<string, number>> = {
  full: { summary: 400, identity: 900, facts: 1200, models: 1000, competitors: 1200, needs: 1200, relationships: 900, risks: 700, actions: 1000, gaps: 700 },
  brief: { summary: 350, facts: 800, gaps: 500 },
  'identity-check': { summary: 300, gaps: 300 },
};

/** 三种模式：由 identity.status、scope 和章节集合共同决定（服务端校验，不靠模型自觉） */
export const CUSTOMER_RESEARCH_MODES: Array<{
  id: CustomerResearchMode;
  title: string;
  when: string;
}> = [
  {
    id: 'full',
    title: '完整报告',
    when: '仅 knowledge-web 且 identity.status=verified：外部来源 ≥2、来源总数 ≥3，其中至少 1 条工商/官方来源；已核实事实、主要机型、竞品情况、需求与机会都有引用。证据不够就退简报，不许用行业泛论凑章节。',
  },
  {
    id: 'brief',
    title: '资料不足简报',
    when: 'knowledge-only、identity.status=kb-docs，或已核实主体但公开资料不够写完整版：结论 / 已知事实 / 待核实三章，只写读到的具体事实并引用来源；简报只在客户洞察页反馈，不自动入库。',
  },
  {
    id: 'identity-check',
    title: '主体核验',
    when: 'identity.status=not-found：公开工商与知识库都确认不了客户主体，必须质疑客户是否存在或名称写错，只出核验结论与需要用户确认的事项，不写任何客户分析、不保存文件。',
  },
];

export const CUSTOMER_RESEARCH_WORKFLOW = `1. 先核验客户主体，不要先写分析。用工商登记/官方渠道核对输入名称：企查查、天眼查、国家企业信用信息公示系统、公司官网、年报/公告。记录实际查过的渠道与关键词（attempts）。结论写进提交的 identity：
   - verified：在工商登记或官方渠道找到该主体（尽量拿到工商全名 fullName，能拿到统一社会信用代码就填 registrationId），evidence 指向这些外部来源，method 填 registry 或 official-site。
   - kb-docs：外部查不到（或本次 scope=knowledge-only），但知识库里确有关于该客户的实质原始资料（拜访纪要、合同、报价、往来记录），evidence 指向 原始资料/文档/ 下的文件，method 填 kb-documents。
   - not-found：公开渠道与知识库都确认不了主体。此时必须质疑客户是否存在、名称是否写错或只是简称/品牌名，只提交「主体核验」短报告，不写客户分析。
   知识库里只有客户名称、名单条目、Wiki 页面提法，不算主体证据，不能据此补全客户分析；不要把同类客户的情况安到本客户头上。
2. 再按证据量选模式（服务端会按 identity.status、scope 与章节集合校验）：
   - 完整报告（10 章）：仅 knowledge-web + verified；外部来源 ≥2、来源总数 ≥3（至少 1 条 kind=registry|official 的来源）；「已核实事实」≥2 处、「主要机型」≥1 处、「竞品情况」≥1 处、「需求与机会」≥1 处 [来源编号] 引用。达不到就交简报，不要凑。
   - 资料不足简报（summary/facts/gaps 三章）：knowledge-only、kb-docs，或 verified 但公开资料不足。只写已读到的具体事实，每条带 [来源编号]；读到的机型与竞品情况一并写进「已知事实」，没读到就写没有。
   - 主体核验（summary/gaps 两章）：not-found。核验结论写「未能核实该客户主体存在」及可能原因；需要你确认写用户下一步该提供什么（工商全名、名片、官网、合同名等）。
3. 检索纪律：先 Engram（engram search / pages read / pages evidence / files read），再外部（登记、官网、公告、招投标、招聘 JD、专利、新闻）。**客户的主要机型与正在使用的竞品是必查项**：知识库原始资料优先（拜访/技术交流纪要、报价单、设备配置表、合同、招投标文件、售后记录），再查外部（客户官网产品页与产品目录、行业媒体、招投标与中标公告、专利、招聘 JD、展会资料）。写清机型系列/型号、产能或台套数、电气配置、竞品品牌与对应机型、份额或合作深度；只有推断时标「推断」，查不到就写查不到。外部结论只能来自实际读过的页面，逐条登记来源。不要用「行业趋势/市场空间/国产替代」这类通用叙述填充，不要复述检索过程。
4. 写作纪律（报告要一眼看完）：结论先行；只写与该客户直接相关、能指回来源的事实；推断标「推断」；不确定写「待核实」；禁止方法论、能力声明、检索过程、免责声明等元叙述（范围与来源统计由服务端页头生成）；禁止「综上所述/随着…发展/具有重要意义」这类空话；每章不超过 reportContract.limits 的长度上限，超了会被拒收。
5. 提交 engram research submit --task <taskId> --file report.json（报告 JSON 含 identity、sections、sources、save、saveMode、overwritePath）。sections 键随模式：完整版 10 章全部（含 models=主要机型、competitors=竞品情况）；简报 summary/facts/gaps；主体核验 summary/gaps。来源每条写 id、title、url 或 path、kind（registry/official/media/kb-doc/kb-page）、publishedAt（未知写「未标注」）、accessedAt（YYYY-MM-DD）。按返回的校验问题修正，不要绕过。
6. 保存与入库：内置「调研并保存」已授权，完整报告会自动存入知识库；资料不足简报只在客户洞察页反馈、不自动导入，不要声称已保存（用户可在页面手动入库）；主体核验不保存文件。外部对话只有用户明确要求保存才 save=true。
7. 重复客户：begin 会返回 existingReports（知识库里该客户已有的报告，删调研记录不会影响命中）。用户要求保存且 existingReports 非空时，必须先问用户「生成新版本还是覆盖旧报告」：生成新版本传 saveMode=new（重名自动追加 _2/_3）；覆盖传 saveMode=overwrite + overwritePath=已有报告 path（同一文件整篇替换、文件名日期保持原样）。不先问用户就提交会被服务端拒收。完整报告存 原始资料/文档/YYYY.MM.DD_公司全名调研报告.md；简报存 …_客户名调研简报.md。不要用 engram files add 绕过校验，也不要自动改写客户实体页。`;

export const CUSTOMER_RESEARCH_TRIGGER =
  '用户要求调研客户、分析目标公司、客户背景调查或生成客户洞察报告时，先用 engram research begin 取得 Engram 的最新流程与模板，再按任务用 engram research submit 提交报告。第一步永远是核验客户主体：公开工商与知识库都查不到时，必须质疑客户是否存在，只出主体核验结论，不写客户分析。仅查一个客户事实、翻译/改写已有报告不触发完整调研；用户明确指定其他流程时遵循用户要求。';

export const CUSTOMER_RESEARCH_BRIDGE = `# Engram 客户调研

${CUSTOMER_RESEARCH_TRIGGER}

调用 \`engram research begin --customer <客户名> [--scope knowledge-web|knowledge-only]\`（只在用户要求保存时加 --save；知识库已有该客户报告且用户要求保存时，先问用户「生成新版本还是覆盖旧报告」，再传 --save-mode new 或 --save-mode overwrite --overwrite-path <已有报告 path>）。读取返回的 workflow、identityContract、reportContract、modeRules、taskId 和 version，按它们执行；完整流程以返回为准，不在本 skill 中复制或凭上次记忆复用。完整报告固定 10 章，其中「主要机型」「竞品情况」两章必须各带至少 1 处 [来源编号] 引用；证据不足按契约降级为简报，不要用行业泛论凑章节。

提交前必须自己先核验客户主体：公开工商/官方渠道查不到、知识库里也没有实质原始资料时，identity.status 填 not-found，报告降为「主体核验」短报告，明确说未能核实该客户是否存在，不要用知识库里的名称提法编造客户分析。完成后用 \`engram research submit --task <taskId> --file report.json\`（报告 JSON 带 identity（status/method/attempts/evidence/fullName 等）、sections、sources）；校验失败按错误修正。来源不足如实降级为简报，不声称已联网或获得最新信息。
入库纪律：完整报告会自动存入知识库；资料不足简报只留在客户洞察页、不自动导入（不要声称已保存）；主体核验不保存。begin 返回的 existingReports 非空且用户要求保存时，必须先问用户「生成新版本还是覆盖旧报告」，再传 saveMode=new 或 saveMode=overwrite + overwritePath 重新发起或提交；不先问会被服务端拒收。显式用户要求优先。
`;