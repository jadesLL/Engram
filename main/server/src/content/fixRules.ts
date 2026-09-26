/**
 * 错别字四类判据（服务端唯一来源）。
 *
 * 同一份判据服务两处，避免口径漂移：
 *   - 内置 skill `docx-meeting-to-md` 的「三、错别字四类判据」（整理纪要时逐条列订正记录）；
 *   - 「记一条灵感」落盘前勘误（lib/textFix.ts 的提示词与校验）。
 * 四类之外不改、拿不准不改——改这里等于同时改两处口径。
 */

export const FIX_KINDS = ['形近误录', '同音误录', '称谓误录', '外部规范'] as const;

export type FixKind = (typeof FIX_KINDS)[number];

export interface FixKindRule {
  kind: FixKind;
  /** 判据一句话 */
  criterion: string;
  example: string;
}

export const FIX_KIND_RULES: readonly FixKindRule[] = [
  { kind: '形近误录', criterion: '专有名词的标准写法', example: `北子所 → 北自所` },
  { kind: '同音误录', criterion: '姓氏/名称同音', example: `郭总 → 过志强（郭/过同音）` },
  { kind: '称谓误录', criterion: '上下文自洽', example: `顶楼会客楼 → 顶楼会客厅（下文"仅有两个厅"）` },
  { kind: '外部规范', criterion: '官方名称', example: `硕放机场 → 苏南硕放机场` },
];

/** 判据表格（Markdown）：skill 正文用 */
export function fixKindTableMarkdown(): string {
  return [
    '| 类型 | 判据 | 例子 |',
    '| --- | --- | --- |',
    ...FIX_KIND_RULES.map((rule) => `| ${rule.kind} | ${rule.criterion} | ${rule.example} |`),
  ].join('\n');
}

/** 判据清单（一行式）：模型提示词用 */
export function fixKindPromptLines(): string {
  return FIX_KIND_RULES.map((rule) => `  · ${rule.kind}：${rule.criterion}（例：${rule.example}）`).join('\n');
}
