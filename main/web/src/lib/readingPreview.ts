import {
  clampContentWidthRatio,
  DEFAULT_CONTENT_WIDTH_RATIO,
  type ContentWidthRatio,
} from './contentWidth';

/** 正文字号：1px 连续可调（8–48px），不再限制为固定档位，仅保留防止排版崩坏的安全边界 */
export const READING_FONT_SIZE_MIN = 8;
export const READING_FONT_SIZE_MAX = 48;
export type ReadingFontSize = number;
export type ReadingLineHeight = 1.6 | 1.8 | 2;

export type ReadingPreferences = {
  fontSize: ReadingFontSize;
  /** 正文列宽：占「正文可用区」的百分比（默认 70%），阅读与编辑视图共用 */
  widthRatio: ContentWidthRatio;
  lineHeight: ReadingLineHeight;
  numberedHeadings: boolean;
  outline: boolean;
};

export type ReadingHeading = {
  level: number;
  text: string;
};

export const DEFAULT_READING_PREFERENCES: ReadingPreferences = {
  fontSize: 16,
  widthRatio: DEFAULT_CONTENT_WIDTH_RATIO,
  lineHeight: 1.8,
  numberedHeadings: false,
  outline: true,
};

const LINE_HEIGHTS = new Set<ReadingLineHeight>([1.6, 1.8, 2]);
/** 旧版按 px 存的三档页宽：迁移成等效百分比（按 1100px 可用区的观感折算） */
const LEGACY_PIXEL_WIDTH_RATIOS: Record<number, ContentWidthRatio> = {
  680: 0.62,
  780: 0.71,
  960: 0.87,
};
const EXPLICIT_NUMBER_RE =
  /^\s*(?:[（(][一二三四五六七八九十百零\d]+[）)]|[一二三四五六七八九十百零\d]+(?:\.\d+)*\s*[.、．)）])/;

/** 任意来源的字号都收敛到整数安全区间，缺失或非法值回落到默认字号 */
export function clampReadingFontSize(value: unknown): ReadingFontSize {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_READING_PREFERENCES.fontSize;
  }
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return DEFAULT_READING_PREFERENCES.fontSize;
  return Math.min(READING_FONT_SIZE_MAX, Math.max(READING_FONT_SIZE_MIN, size));
}

/**
 * 解析本地偏好：widthRatio 优先；旧版按 px 存的 width（680/780/960）迁移成等效百分比，
 * 两者都没有才回落默认 70%。
 */
export function parseReadingPreferences(raw: string | null): ReadingPreferences {
  if (!raw) return { ...DEFAULT_READING_PREFERENCES };
  try {
    const value = JSON.parse(raw) as Partial<ReadingPreferences> & { width?: number };
    const legacyRatio = LEGACY_PIXEL_WIDTH_RATIOS[Number(value.width)];
    return {
      fontSize: clampReadingFontSize(value.fontSize),
      widthRatio: value.widthRatio === undefined && legacyRatio !== undefined
        ? legacyRatio
        : clampContentWidthRatio(value.widthRatio),
      lineHeight: LINE_HEIGHTS.has(value.lineHeight as ReadingLineHeight)
        ? value.lineHeight as ReadingLineHeight
        : DEFAULT_READING_PREFERENCES.lineHeight,
      numberedHeadings: typeof value.numberedHeadings === 'boolean'
        ? value.numberedHeadings
        : DEFAULT_READING_PREFERENCES.numberedHeadings,
      outline: typeof value.outline === 'boolean'
        ? value.outline
        : DEFAULT_READING_PREFERENCES.outline,
    };
  } catch {
    return { ...DEFAULT_READING_PREFERENCES };
  }
}

export function normalizeReadingTitle(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

export function isDuplicateDocumentTitle(heading: string, pageTitle: string): boolean {
  return Boolean(pageTitle.trim()) &&
    normalizeReadingTitle(heading) === normalizeReadingTitle(pageTitle);
}

export function headingNumbers(headings: ReadingHeading[]): string[] {
  if (headings.some((heading) => EXPLICIT_NUMBER_RE.test(heading.text))) {
    return headings.map(() => '');
  }

  const counters = [0, 0, 0];
  return headings.map((heading) => {
    const index = Math.max(0, Math.min(2, heading.level - 2));
    counters[index] += 1;
    for (let next = index + 1; next < counters.length; next++) counters[next] = 0;
    return `${counters.slice(0, index + 1).filter(Boolean).join('.')}.`;
  });
}

export function uniqueHeadingId(text: string, used: Set<string>): string {
  const normalized = text
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  let candidate = normalized;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${normalized}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

export function readingMetrics(text: string): { units: number; minutes: number } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const cjk = normalized.match(/[\u3400-\u9fff]/g)?.length || 0;
  const latinWords = normalized
    .replace(/[\u3400-\u9fff]/g, ' ')
    .match(/[A-Za-z0-9_]+/g)?.length || 0;
  return {
    units: cjk + latinWords,
    minutes: Math.max(1, Math.ceil(cjk / 400 + latinWords / 200)),
  };
}

export function requiredReadingTailSpace(input: {
  lastHeadingY: number;
  anchorOffset: number;
  scrollHeightWithoutTail: number;
  viewportHeight: number;
  breathingRoom?: number;
}): number {
  const {
    lastHeadingY,
    anchorOffset,
    scrollHeightWithoutTail,
    viewportHeight,
    breathingRoom = 24,
  } = input;
  const maxScrollWithoutTail = Math.max(0, scrollHeightWithoutTail - viewportHeight);
  return Math.max(
    0,
    Math.ceil(lastHeadingY - anchorOffset - maxScrollWithoutTail + breathingRoom),
  );
}
