/**
 * 信捷模式（ACS 助力客户成功）客户梳理提示词。
 *
 * 来源：docs/acs/ 下的 ACS-01（洞察客户战略·五看）、ACS-02（管理联合创新）、
 * ACS-04（管理客户关系·三层关系/决策链）方法论文档与 output-template.md，蒸馏为紧凑、
 * 指令化的提示词。运行时不加载原文，仅用本文件。
 *
 * 仅在信捷模式（settings: acs_mode === 'acs'）下、对被标记为「客户」的 org 实体页生效
 * （见 lib/acs.ts pageIsCustomerOrg）。非客户页（供应商/渠道商/内部组织等）不受影响，
 * 因此无需在提示词内做客户判定——能进入本提示词的页面已是客户。
 */
import { PERSONA, PRINCIPLES } from './common.js';

/** 信捷五看、三层关系等判定口径的精简标尺，供综合与校验共用。 */
const ACS_LENS = `【ACS 框架维度（仅写证据能支撑的维度；证据不足的角度省略，绝不编造）】
- 客户画像：行业、规模、主要业务与机型分层（H1 主力/H2 开发/H3 未来）、现有设备/方案、合作状态与供应商地位（主/辅/备）、客户关系程度（3/2/1/0/-1）。
- 五看洞察：看行业（行业周期与下一代技术趋势）→ 看客户（战略诉求、经营状况、机型结构、痛点链）→ 看竞争（友商在客户的布局、份额、反包围点）→ 看自己（我方份额与供应商地位、与友商差距、SWOT）→ 看机会点（商机/战略商机清单，标注金额与阶段）。
- 决策链地图：A 审批人/D 决策者/S 支撑者/I 影响者四角色；技术/商务/综合三条决策链；不忽略隐性决策链（顾问、前高管、外部专家）；支持度按 3 教练/2 强烈支持/1 支持/0 中立/-1 不认可 标注。
- 三层关系：关键客户关系（点·订单决策）、组织客户关系（面·战略互信）、普遍客户关系（线·业务畅通与信息获取）；各层现状与层级（关键: 教练/强烈支持/支持/中立/不认可；组织: A/B/C；普遍: A/B/C/D）。
- 联合创新：创新点类型（人无我有=定制/创新，须见客户专项预算或投入承诺；人有我优=改善/优化）、TVO 价值（量化成钱：多赚/省多少）、可推广性（A 多客户复用/B 单客户高价值/C 一次性）、在途项目阶段与风险。
- 行动计划：近 90 天应推进的事项，每项含目的/产出/依赖/建议时限；频率型动作（如 A 级客户每周 1+ 有效拜访）写成周期事项并给首启时限。
- 缺失资料：ACS 框架预期但 evidence 未覆盖的关键缺口，按优先级（高/中/低）列出，并标注用途（支撑什么分析/动作）。`;

/**
 * 整页综合的信捷模式提示词。签名与 pageSynthesisPrompt 一致以便直接替换。
 * 输出 JSON 结构与标准版完全一致（summary/sections/related/timeline/unresolvedConflicts/
 * manualChangesPreserved），新增一个可选 gaps 数组承载「缺失资料」——gaps 条目无需 evidenceIds
 * （它们是证据缺口，不是证据支持的陈述），由 renderOutput 在校验通过后渲染为单独章节。
 */
export function acsPageSynthesisPrompt(
  title: string,
  type: string,
  roster: string,
  manualChanged: boolean,
  correctionFeedback?: string[],
): string {
  const manual = manualChanged
    ? `用户编辑过上一版综合正文。必须把 previousSynthesis 与 currentEditedSynthesis 的差异视为用户意图：
- 尽量保留用户新增的事实限定、结构和措辞；
- 用户文字与证据冲突时不要擅自覆盖，在 unresolvedConflicts 中说明；
- 只有确实保留了用户修改时 manualChangesPreserved 才能为 true。`
    : '当前综合区没有检测到人工修改，manualChangesPreserved 输出 true。';
  const correction = correctionFeedback?.length
    ? `\n\n上一版草稿未通过证据校验，以下内容被判定为无证据支持，本次重写必须删除或改写为证据能直接支持的说法，不要原样保留：\n${correctionFeedback.map((item) => `- ${item}`).join('\n')}`
    : '';
  return `${PERSONA}
${PRINCIPLES}

你正在以信捷模式（ACS 助力客户成功）执行客户实体页面「${title}」的跨来源整页综合，页面类型为 ${type}。该页面已被标记为客户，按 ACS 框架组织。

这不是按来源写摘要，也不是把新来源追加到旧正文。你必须读取全部 activeEvidence，把它们重组为一篇独立、连贯、可长期维护的客户档案：
1. 跨来源去重，相同事实只表达一次；互补事实合并到同一语义章节。
2. ${ACS_LENS}
3. 第一个 section 的 heading 留空，用 1-3 个 paragraph 概述客户；后续 section 使用 ACS 框架章节名（客户画像/五看洞察/决策链地图/三层关系/联合创新/行动计划），仅保留证据能支撑的章节，证据不足的章节整体省略，不编造。
4. 每个 ACS 维度内，把证据支持的具体事实写成 paragraph 或 bullet；保留数据、金额、时间、机型、角色等限定条件。
5. timeline 只记录证据明确支持、且带明确事件日期的角色变动、组织调整、合作里程碑或客户级别变化。不得把来源文件日期、入库日期当作事件日期。
6. related 只列已有页面名录中的实体；同一实体只列一次。
7. 每个 paragraph、bullet、related 和 timeline 条目都必须列出直接支持它的 evidenceIds，不得使用不存在的证据；不得做超出证据的推断或泛化。证据不足以确证的推断标注「（推测，待验证）」但必须仍锚定到能间接支撑它的 evidenceId；完全无证据的维度不要写成事实，放进 gaps。
8. 行动计划事项必须由能揭示该需求的 evidence 支撑（如证据显示某信息缺失、某角色未覆盖、某商机待跟进），不要凭空产出行动。
9. 可以依据时间限定解释表面冲突；无法可靠解释的冲突不要写成确定结论，放入 unresolvedConflicts。
10. 不要在正文中出现「来源提炼」「根据资料」「资料显示」等元描述。

${manual}

已有页面名录：
${roster || '（暂无）'}

evidenceIds 必须逐字使用 activeEvidence 中的 id。只输出以下结构的 JSON，不要输出 Markdown 围栏或额外文字：
{
  "summary": "整页摘要",
  "domain": "领域",
  "confidence": "高|中|低",
  "sections": [
    {
      "heading": "首段留空，后续为 ACS 章节名",
      "paragraphs": [{"text": "完整段落", "evidenceIds": ["runId:factId"]}],
      "bullets": [{"text": "列表事项", "evidenceIds": ["runId:factId"]}]
    }
  ],
  "related": [{"title": "已有页面名", "note": "关联原因", "evidenceIds": ["runId:factId"]}],
  "timeline": [{"date": "证据中的明确日期", "event": "状态变化", "evidenceIds": ["runId:factId"]}],
  "unresolvedConflicts": [],
  "gaps": [
    {"item": "缺失的关键资料/待验证信息", "priority": "高|中|低", "use": "支撑什么分析或动作"}
  ],
  "manualChangesPreserved": true
}${correction}`;
}

/** 整页综合校验的信捷模式变体。与 pageSynthesisVerifyPrompt 同构，额外告知校验器「缺失资料」章节为证据缺口清单。 */
export function acsPageSynthesisVerifyPrompt(manualChanged: boolean): string {
  return `${PERSONA}
你正在以信捷模式（ACS）验证客户实体页面的整页综合草稿。

逐项检查：
1. 每个 paragraph、bullet、related、timeline 条目是否被其 evidenceIds 对应的事实与原文引文直接支持。
2. 是否跨来源去重并形成连贯档案，而不是按来源拼接。
3. 是否遗漏或静默覆盖无法解释的矛盾。
4. timeline 是否只包含明确日期的真实状态变化。
5. related 是否只引用已有页面。
6. 「缺失资料」章节（gaps 渲染出的章节，其条目无 evidenceIds）是 ACS 框架的预期证据缺口清单，不是事实陈述——不要因其无证据而判为 unsupported；只校验它是否对应框架真正缺失的维度，而非凭空臆造。
${manualChanged ? '7. previousSynthesis 与 currentEditedSynthesis 的人工差异是否被保留；没有保留时 manualChangesPreserved=false。' : '7. manualChangesPreserved=true。'}

发现无依据内容时 pass=false，并在 unsupported 中列出；发现未解决矛盾时放入 conflicts。只输出以下 JSON：
{"pass":true,"unsupported":[],"conflicts":[],"manualChangesPreserved":true}`;
}
