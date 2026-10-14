/** Shared customer workflow: local skills are only launchers, never copies of this contract. */
export const CUSTOMER_RESEARCH_SECTIONS = [
  { id: 'summary', title: '调研范围与执行摘要' },
  { id: 'profile', title: '客户概况' },
  { id: 'fiveViews', title: '五看洞察' },
  { id: 'innovation', title: '联合创新与方案竞争力' },
  { id: 'relationships', title: '决策链与客户关系' },
  { id: 'opportunities', title: '机会排序与主要风险' },
  { id: 'actions', title: '未来 90 天行动计划' },
  { id: 'gaps', title: '资料缺口与待验证事项' },
] as const;

export const CUSTOMER_RESEARCH_WORKFLOW = `1. 确认客户主体：核对全名、所在地、官网及业务，排除同名公司；不能确认时注明候选与范围，不编造工商全名。已有公司名称核验规则继续适用。
2. 先查 Engram：search 检索客户名称及别名，read_page 读取客户页，page_evidence / read_raw_file 回溯拜访纪要、合作、机型、关键人物与商机。收集箱不属于可引用来源。
3. 按本次 scope 补充资料：knowledge-only 只查库；knowledge-web 用你自己的联网工具，优先官网、年报、公告、产品资料、招投标与行业权威资料。没有联网能力必须明确写入调研范围，不得声称已经联网或获得最新信息。
4. 按 ACS 三域分析：五看（行业→客户→竞争→自己→机会）；联合创新（创新价值、TVO、方案竞争力、项目阶段与风险）；客户关系（技术/商务/综合决策链，审批/决策/支撑/影响角色，关键/组织/普遍三层关系）。我方能力、预算、份额无依据时列缺口，不补数字。
5. 区分已核实事实、来源观点和推断，冲突资料并列。关键结论用 [来源编号] 引用；推断写“推断”，尚未验证的商机不能写成已确认订单。
6. 给出值得验证的机会、主要风险、下一步验证动作与未来 90 天建议计划。动作写责任人（未知写建议角色）、开始/完成日期、产出及依赖；从本次 reportDate（用户 timeZone 的自然日）计算，避开周末，远期按月。缺乏排期依据时标注“建议”，不能假装客户已经承诺。
7. 按 reportContract.sections 的固定 id 提交 sections 对象；所有章节保留，无依据的写“资料不足”及影响。sources 中每条写 id、title、url 或 path、publishedAt（未知写“未标注”）、accessedAt（YYYY-MM-DD）。引用必须指向真实阅读的来源。
8. 调用 submit_customer_research 提交，按返回的校验问题修正。内置按钮已授权调研并保存；外部对话仅调研时 save=false，只有用户明确要求保存才 save=true。调研报告适用本客户模板，通用 research-raw-material 的栏目顺序不覆盖它。不要用 create_raw_material 绕过客户报告校验，也不要自动改写客户实体页。`;

export const CUSTOMER_RESEARCH_TRIGGER = '用户要求调研客户、分析目标公司、客户背景调查或生成客户洞察报告时，优先调用 begin_customer_research 获取 Engram 的最新流程与模板，再按任务提交报告。仅查一个客户事实、翻译/改写已有报告不触发完整调研；用户明确指定其他流程时遵循用户要求。';

export const CUSTOMER_RESEARCH_BRIDGE = `# Engram 客户调研

${CUSTOMER_RESEARCH_TRIGGER}

调用 Engram MCP 的 begin_customer_research（工具可能带 mcp__engram__ 前缀），传 customer 和 scope；只在用户要求保存时传 save=true。读取返回的 workflow、reportContract、taskId 和 version，按它们执行；完整流程保存在 Engram，不在本 skill 中复制或凭上次记忆复用。
完成后调用 submit_customer_research，带 taskId、sections、sources；校验失败按错误修正。来源不足如实标注，Engram 不可用时说明限制，不声称已使用其流程。显式用户要求优先，不自动保存或覆盖知识页面。
`;

export const CUSTOMER_RESEARCH_SKILL_FILE = `---
name: engram-customer-research
description: 调研客户、分析目标公司、客户背景调查和客户洞察报告时使用；从已连接的 Engram 获取统一流程与模板。不用于单个事实查询或报告改写。
---

<!-- engram-managed-customer-research:v1 -->
${CUSTOMER_RESEARCH_BRIDGE}`;
