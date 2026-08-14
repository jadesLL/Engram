import { PERSONA, PRINCIPLES } from './common.js';

export function pageSynthesisPrompt(title: string, type: string, roster: string, manualChanged: boolean, correctionFeedback?: string[]): string {
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

你正在执行实体页面「${title}」的跨来源整页综合，页面类型为 ${type}。

这不是按来源写摘要，也不是把新来源追加到旧正文。你必须读取全部 activeEvidence，把它们重组为一篇独立、连贯、可长期维护的文档：
1. 跨来源去重，相同事实只表达一次；互补事实合并到同一语义章节。
2. 正文按角色、职责、业务、客户与项目、渠道与团队、经营表现等事实维度组织，不按来源顺序或入库顺序组织。
3. 第一个 section 的 heading 留空，用 1-3 个 paragraph 概述实体；后续 section 使用简短章节名。
4. 月度数字、阶段性业绩等放入合适的业务章节并保留时间限定，不因为资料带日期就放入时间线。
5. timeline 只记录证据明确支持、且带明确事件日期的角色、目标、客户级别、组织调整或里程碑变化。不得把来源文件日期、入库日期当作事件日期。
6. related 只列已有页面名录中的实体；同一实体只列一次。
7. 每个 paragraph、bullet、related 和 timeline 条目都必须列出直接支持它的 evidenceIds，不得使用不存在的证据。
8. 可以依据时间限定解释表面冲突；无法可靠解释的冲突不要写成确定结论，放入 unresolvedConflicts。
9. 不要在正文中出现“来源提炼”“根据资料”“资料显示”等元描述。
10. 正文每个事实性陈述都必须能被其 evidenceIds 对应的事实陈述与原文引文直接支持；不得做超出证据的推断、泛化或补充证据未提及的限定（例如把“有业绩数据”写成“销售团队”，或给“代理商”补充证据未指明的地区）。证据不足时宁可不写。

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
      "heading": "首段留空，后续为章节名",
      "paragraphs": [{"text": "完整段落", "evidenceIds": ["runId:factId"]}],
      "bullets": [{"text": "列表事项", "evidenceIds": ["runId:factId"]}]
    }
  ],
  "related": [{"title": "已有页面名", "note": "关联原因", "evidenceIds": ["runId:factId"]}],
  "timeline": [{"date": "证据中的明确日期", "event": "状态变化", "evidenceIds": ["runId:factId"]}],
  "unresolvedConflicts": [],
  "manualChangesPreserved": true
}${correction}`;
}

export function pageSynthesisVerifyPrompt(manualChanged: boolean): string {
  return `${PERSONA}
你正在验证实体页面的整页综合草稿。

逐项检查：
1. 每段和每个列表项是否被其 evidenceIds 对应的事实与原文引文直接支持。
2. 是否跨来源去重并形成连贯文档，而不是按来源拼接。
3. 是否遗漏或静默覆盖无法解释的矛盾。
4. timeline 是否只包含明确日期的真实状态变化。
5. related 是否只引用已有页面。
${manualChanged ? '6. previousSynthesis 与 currentEditedSynthesis 的人工差异是否被保留；没有保留时 manualChangesPreserved=false。' : '6. manualChangesPreserved=true。'}

发现无依据内容时 pass=false，并在 unsupported 中列出；发现未解决矛盾时放入 conflicts。只输出以下 JSON：
{"pass":true,"unsupported":[],"conflicts":[],"manualChangesPreserved":true}`;
}
