export type ReadingFontSize = 15 | 16 | 18;
export type ReadingWidth = 680 | 780 | 960;
export type ReadingLineHeight = 1.6 | 1.8 | 2;

export type ReadingPreferences = {
  fontSize: ReadingFontSize;
  width: ReadingWidth;
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
  width: 780,
  lineHeight: 1.8,
  numberedHeadings: false,
  outline: true,
};

const FONT_SIZES = new Set<ReadingFontSize>([15, 16, 18]);
const WIDTHS = new Set<ReadingWidth>([680, 780, 960]);
const LINE_HEIGHTS = new Set<ReadingLineHeight>([1.6, 1.8, 2]);
const EXPLICIT_NUMBER_RE =
  /^\s*(?:[（(][一二三四五六七八九十百零\d]+[）)]|[一二三四五六七八九十百零\d]+(?:\.\d+)*\s*[.、．)）])/;

export function parseReadingPreferences(raw: string | null): ReadingPreferences {
  if (!raw) return { ...DEFAULT_READING_PREFERENCES };
  try {
    const value = JSON.parse(raw) as Partial<ReadingPreferences>;
    return {
      fontSize: FONT_SIZES.has(value.fontSize as ReadingFontSize)
        ? value.fontSize as ReadingFontSize
        : DEFAULT_READING_PREFERENCES.fontSize,
      width: WIDTHS.has(value.width as ReadingWidth)
        ? value.width as ReadingWidth
        : DEFAULT_READING_PREFERENCES.width,
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
