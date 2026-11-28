/**
 * 视频解读文章的成文后处理（纯函数，单测直接打）。
 *
 * 模型负责写文章，但有几件事不能只靠提示词：
 *  1. 正文里残留的 [mm:ss] 一律剥掉，时间点统一收到文末「视频时间点」；
 *  2. 「视频里 / 演示中 / 作者说」这类视频解说腔由提示词约束，这里不做语义改写；
 *  3. 封面、关键帧、图文原图由服务端确定性插入，模型只写 `frame:MM:SS` 占位；
 *  4. 来源信息统一由服务端追加，正文里不重复。
 */

export interface ArticleSourceMeta {
  title: string;
  author?: string;
  platformLabel: string;
  link?: string;
}

export interface Timepoint {
  timestamp: string;
  text: string;
}

const TIMESTAMP = '\\d{1,3}:\\d{2}(?::\\d{2})?';
const TIMESTAMP_MARK_RE = new RegExp(`\\[${TIMESTAMP}(?:\\s*[-–—]\\s*${TIMESTAMP})?\\]`, 'g');
const TIMEPOINT_SECTION_RE = /^##\s*(?:视频时间点|时间点|视频导航)[^\n]*$/m;

function stripOutsideFences(markdown: string, transform: (part: string) => string): string {
  return String(markdown || '')
    .split(/(```[\s\S]*?```)/)
    .map((part, index) => (index % 2 === 0 ? transform(part) : part))
    .join('');
}

/** 去掉正文里的 [mm:ss] / [mm:ss]-[mm:ss]（代码块内保留） */
export function stripBodyTimestamps(markdown: string): string {
  return stripOutsideFences(markdown, (part) =>
    part
      .replace(TIMESTAMP_MARK_RE, '')
      .replace(/[ \t]+([，。！？；：、,.!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^\s*[，。；：、]\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** 删掉模型自己写的「视频时间点 / 时间点」小节（服务端会按观看笔记重新生成） */
export function stripTimepointSection(markdown: string): string {
  let result = String(markdown || '');
  for (;;) {
    const match = TIMEPOINT_SECTION_RE.exec(result);
    if (!match) break;
    const start = match.index;
    const after = result.slice(start + match[0].length);
    const next = after.search(/^##\s/m);
    const end = next >= 0 ? start + match[0].length + next : result.length;
    result = (result.slice(0, start) + result.slice(end)).replace(/\n{3,}/g, '\n\n');
  }
  return result.trim();
}

function normalizeTimepointText(raw: string): string {
  return String(raw || '')
    .replace(/^[\s:：\-–—|]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** 从观看笔记里取「## 时间点」小节；没有就退化为扫描笔记里的时间戳 */
export function extractTimepoints(notes: string): Timepoint[] {
  const text = String(notes || '');
  const points: Timepoint[] = [];
  const seen = new Set<string>();
  const push = (timestamp: string, label: string) => {
    const clean = normalizeTimepointText(label);
    if (!timestamp || seen.has(timestamp)) return;
    seen.add(timestamp);
    points.push({ timestamp, text: clean || '时间点' });
  };

  const sectionMatch = TIMEPOINT_SECTION_RE.exec(text);
  if (sectionMatch) {
    const body = text.slice(sectionMatch.index + sectionMatch[0].length);
    const stop = body.search(/^##\s/m);
    const section = stop >= 0 ? body.slice(0, stop) : body;
    const lineRe = new RegExp(`^\\s*[-*]\\s*\\[?(${TIMESTAMP})\\]?\\s*(.*)$`, 'gm');
    for (const line of section.matchAll(lineRe)) push(line[1], line[2] || '');
  }

  if (!points.length) {
    const markerRe = new RegExp(`\\[(${TIMESTAMP})\\]\\s*([^\\n\\[]*)`, 'g');
    for (const match of text.matchAll(markerRe)) {
      push(match[1], match[2] || '');
      if (points.length >= 12) break;
    }
  }
  return points.slice(0, 12);
}

/** 文末「视频时间点」小节（没有时间点就不加） */
export function appendTimepoints(markdown: string, points: Timepoint[]): string {
  if (!points.length) return String(markdown || '').trim();
  const lines = points.map((point) => `- [${point.timestamp}] ${point.text}`);
  return [String(markdown || '').trim(), '', '## 视频时间点', '', ...lines].join('\n').trim();
}

/** 在首个一级标题后插入封面；没有一级标题就放最前面 */
export function insertCoverAfterTitle(markdown: string, url: string, alt = '视频封面'): string {
  const body = String(markdown || '').trim();
  if (!url || body.includes(url)) return body;
  const image = `![${alt}](${url})`;
  const title = /^#\s+.+$/m.exec(body);
  if (!title) return `${image}\n\n${body}`;
  const end = (title.index ?? 0) + title[0].length;
  return `${body.slice(0, end)}\n\n${image}\n\n${body.slice(end).replace(/^\n+/, '')}`.trim();
}

/** 图文笔记原图：文末附图（第一张已当封面时跳过） */
export function appendImageGallery(markdown: string, urls: string[], startIndex = 0): string {
  const items = urls.slice(startIndex).filter(Boolean);
  if (!items.length) return String(markdown || '').trim();
  const lines = items.map((url, index) => `![图${startIndex + index + 1}](${url})`);
  return [String(markdown || '').trim(), '', '## 附图', '', ...lines].join('\n').trim();
}

function cleanLabel(value: string): string {
  return String(value || '').replace(/[[\]()]/g, '').replace(/\s+/g, ' ').trim();
}

/** 文末来源行：只出现一次，正文里不再重复「视频里」 */
export function appendSourceLine(markdown: string, meta: ArticleSourceMeta): string {
  const title = cleanLabel(meta.title) || '未命名内容';
  const author = cleanLabel(meta.author || '');
  const platform = cleanLabel(meta.platformLabel || '视频');
  const link = (meta.link || '').trim();
  const label = link ? `[${title}](${link})` : `《${title}》`;
  const parts = ['来源：' + label, author, platform].filter(Boolean);
  return [String(markdown || '').trim(), '', '> ' + parts.join(' · ')].join('\n').trim();
}

export interface NormalizeArticleOptions {
  notes?: string;
  coverUrl?: string;
  coverAlt?: string;
  imageUrls?: string[];
  /** 图文笔记已经有封面时，附图从第几张开始（默认 0 = 全部附图） */
  galleryStart?: number;
  source: ArticleSourceMeta;
  /** subtitle 通道没有画面，不生成「视频时间点」 */
  timepoints?: boolean;
}

/**
 * 成文后的统一收口：
 *  去时间戳/去旧时间点小节 → 插封面 → 附图（图文）→ 文末时间点 → 来源行。
 * frame:MM:SS 占位在调用本函数**之前**已由 imageAssets 换成真实 URL。
 */
export function normalizeArticle(markdown: string, options: NormalizeArticleOptions): string {
  let result = stripTimepointSection(String(markdown || '').trim());
  result = stripBodyTimestamps(result);
  if (options.coverUrl) result = insertCoverAfterTitle(result, options.coverUrl, options.coverAlt || '视频封面');
  if (options.imageUrls?.length) {
    result = appendImageGallery(result, options.imageUrls, Math.max(0, options.galleryStart ?? 0));
  }
  if (options.timepoints !== false) {
    result = appendTimepoints(result, extractTimepoints(options.notes || ''));
  }
  return appendSourceLine(result, options.source);
}
