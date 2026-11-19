/**
 * 「出处」引用块的识别与摘要（阅读页折叠、导出稿共用）。
 *
 * 纪要类原始资料的文首固定用引用块交代来源：
 *   来源：飞书妙记《…》及同场「智能纪要」文档
 *   会议时间：2026-11-19 08:59，时长 1 小时 26 分 29 秒；参与人：…
 *   妙记链接：https://…
 *   整理说明：…
 *
 * 阅读页把它折成一行「出处 + 标题 + 日期/时长」，导出稿则展开成静态字段表。
 * 这里只做纯文本解析（Node 测试可直接跑）；DOM 拆分与替换在 sourceCitationDom.ts。
 */

export interface SourceCitationRow {
  label: string;
  /** 纯文本值（DOM 版本会保留链接节点，不直接用这里的值） */
  value: string;
}

export interface SourceCitation {
  /** 折叠行标题：优先「媒介 + 《书名》」，没有书名号时取来源值前 48 字 */
  title: string;
  /** 折叠行右侧：日期 · 时长（拿不到就留空） */
  meta: string;
  rows: SourceCitationRow[];
}

export interface SourceCitationLine {
  label: string;
  value: string;
  /** 标签 + 冒号 + 后续空白的长度（DOM 版本按这个长度从行首剥掉） */
  prefixLength: number;
}

/**
 * 可识别的字段名。加字段时前后端都不需要改：只要第一行仍是「来源/出处」，
 * 且至少有两行能对上标签，就按出处块处理。
 */
const LABELS = [
  '来源',
  '出处',
  '会议时间',
  '时间',
  '参与人',
  '时长',
  '妙记链接',
  '文档链接',
  '链接',
  '会议地点',
  '地点',
  '整理说明',
] as const;

const SOURCE_LABEL_RE = /^(来源|出处)$/;
const LABEL_RE = new RegExp(`^\\s*(${LABELS.join('|')})\\s*[：:]\\s*`);

/** 解析一行「标签：值」；不是字段行返回 null。 */
export function sourceCitationLine(line: string): SourceCitationLine | null {
  const match = String(line || '').match(LABEL_RE);
  if (!match) return null;
  return {
    label: match[1],
    value: line.slice(match[0].length).trim(),
    prefixLength: match[0].length,
  };
}

/** 把引用块的纯文本解析成出处；不像出处块时返回 null。 */
export function parseSourceCitation(text: string): SourceCitation | null {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const rows: SourceCitationRow[] = [];
  for (const line of lines) {
    const parsed = sourceCitationLine(line);
    if (parsed) {
      rows.push({ label: parsed.label, value: parsed.value });
      continue;
    }
    /* 字段值被换行拆开时并回上一行；第一行就不是字段的，肯定不是出处块 */
    if (!rows.length) return null;
    rows[rows.length - 1].value = `${rows[rows.length - 1].value} ${line}`.trim();
  }

  if (rows.length < 2 || !SOURCE_LABEL_RE.test(rows[0].label) || !rows[0].value) return null;
  const time = rows.find((row) => row.label === '会议时间' || row.label === '时间')?.value || '';
  return {
    title: sourceTitle(rows[0].value),
    meta: sourceMeta(time),
    rows,
  };
}

function sourceTitle(value: string): string {
  const open = value.indexOf('《');
  const close = open >= 0 ? value.indexOf('》', open + 1) : -1;
  if (open >= 0 && close > open) {
    /* 「飞书妙记《…》及同场…」只把媒介和书名带进折叠行，后面的说明留在展开内容里 */
    const before = value.slice(0, open).trim();
    const medium = before.split(/[\s，,；;：:]/).filter(Boolean).pop() || '';
    return `${medium}${value.slice(open, close + 1)}`.trim();
  }
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

function sourceMeta(value: string): string {
  const date = value.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const day = date
    ? `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`
    : '';
  const duration = value.match(
    /时长\s*([0-9]+\s*(?:小时|时|分钟|分|秒)(?:\s*[0-9]+\s*(?:分钟|分|秒))?(?:\s*[0-9]+\s*秒)?)/
  );
  return [day, duration ? duration[1].trim() : ''].filter(Boolean).join(' · ');
}
