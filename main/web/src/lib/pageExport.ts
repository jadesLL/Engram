// 带 .ts 扩展名：node --test 直接跑本模块的纯逻辑（Node 的 TS 解析不补扩展名），
// web 的 tsconfig 已开 allowImportingTsExtensions，Vite / vue-tsc 都认。
import { documentTitleParts } from './documentTitle.ts';

/**
 * 单页导出的纯逻辑（PDF / 长图共用）。
 *
 * 这里只放能在 Node 里直接跑的纯函数：文件名、日期、导出文档 HTML。
 * 真正的渲染 / 栅格化 / 三端保存通道在 `pageExportCapture.ts`（依赖 DOM、Vditor 和平台桥），
 * 拆开是为了让 `pageExport.test.ts` 不需要浏览器环境也能钉住导出内容与文件名规则。
 */

/** 导出画布的逻辑宽度（CSS 像素）：整篇长图与打印共用同一个版心。 */
export const EXPORT_SHEET_WIDTH = 860;

/**
 * 长图高度上限（设备像素，同时是 1x 下的 CSS 像素上限）。超过先降采样（最低 1x），
 * 仍然超过就拒绝并建议导出 PDF：再大的 canvas 在安卓 WebView / 低端机上会直接分配失败。
 * 桌面 / 浏览器的上限按 Chromium canvas 的 65535 单边上限留足余量；一篇一万多字的
 * 长文（约 1.9 万 CSS px）仍可按 1.6x 出图，超过 3.2 万 px 的极端长文请用 PDF。
 */
export const EXPORT_MAX_OUTPUT_HEIGHT = 32000;
export const EXPORT_MAX_OUTPUT_HEIGHT_ANDROID = 12000;

/** 导出图片的基线倍数：普通一屏多的笔记按 2x 出图，文字边缘才不糊。 */
export const EXPORT_PIXEL_RATIO = 2;

export interface PageExportMeta {
  /** 页面标题（原始资料可能带 `YYYY.MM.DD_` 前缀，formatDocumentTitle=true 时拆开显示）。 */
  title: string;
  /** Markdown 正文（导出前再由 capture 模块转成 HTML）。 */
  markdown: string;
  /** 类型标签（知识页面 / 概念 / 灵感碎片…）；缺省按「知识页面」。 */
  typeLabel?: string;
  tags?: string[];
  updatedAt?: string;
  /** 原始资料的标题带日期前缀：导出页头像阅读视图一样，把日期放到标题上方。 */
  formatDocumentTitle?: boolean;
}

export interface ExportArticleInput {
  title: string;
  contentHtml: string;
  typeLabel?: string;
  tags?: string[];
  updatedAt?: string;
  formatDocumentTitle?: boolean;
  /** 正文字数 / 阅读时长（由 capture 从渲染后的纯文本算，避免再解析一遍 Markdown）。 */
  metrics?: { units: number; minutes: number };
  exportedAt?: Date;
}

/** 文件名里不能出现的字符（Windows / Android SAF / 浏览器下载都按最严的一边收）。 */
const FILENAME_FORBIDDEN_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeExportFileName(value: string): string {
  const cleaned = String(value || '')
    .replace(FILENAME_FORBIDDEN_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  return (cleaned || '未命名页面').slice(0, 80);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时区的 YYYY-MM-DD（导出文件名与页脚都用它，不用 UTC 避免跨时区差一天）。 */
export function exportDateLabel(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 标题拆出的展示名：原始资料去掉日期前缀与扩展名，普通页面原样。 */
export function exportDisplayName(meta: Pick<PageExportMeta, 'title' | 'formatDocumentTitle'>): {
  name: string;
  dateLabel: string;
} {
  if (!meta.formatDocumentTitle) {
    return { name: String(meta.title || '').trim() || '无标题', dateLabel: '' };
  }
  const parts = documentTitleParts(meta.title || '');
  return { name: parts.name || '无标题', dateLabel: parts.dateLabel };
}

export function exportFileName(title: string, extension: 'pdf' | 'png', date = new Date()): string {
  return `${sanitizeExportFileName(title)}-${exportDateLabel(date)}.${extension}`;
}

export function escapeExportHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 更新时间格式化：与编辑页页头一致（本地时间，精确到分钟）。 */
export function exportUpdatedAtLabel(value?: string | number): string {
  if (!value) return '';
  let date: Date;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    date = new Date(String(numeric).length === 10 ? numeric * 1000 : numeric);
  } else {
    date = new Date(String(value).replace(' ', 'T'));
  }
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 导出文档的完整 HTML（纸面 + 白卡 + 页头 + 正文 + 页脚）。
 *
 * 只用固定类名与 `pageExport.css` 里的字面色值：
 *  - 长图是把这棵 DOM 塞进 SVG foreignObject 再过 canvas，SVG 文档里没有应用的 CSS 变量；
 *  - 打印（窗口 / Electron printToPDF / Android PrintManager）也只认这份自包含样式，
 *    所以导出文档永远按浅色纸面出，不跟随应用深色主题。
 */
export function buildExportArticle(input: ExportArticleInput): string {
  const { name, dateLabel } = exportDisplayName(input);
  const typeLabel = (input.typeLabel || '').trim() || '知识页面';
  const tags = (input.tags || []).map((tag) => String(tag || '').trim()).filter(Boolean);
  const updatedLabel = exportUpdatedAtLabel(input.updatedAt);
  const exportedLabel = exportDateLabel(input.exportedAt || new Date());
  const metrics = input.metrics && input.metrics.units > 0
    ? `${input.metrics.units.toLocaleString('zh-CN')} 字 · 约 ${input.metrics.minutes} 分钟`
    : '';

  const metaItems: string[] = [`<span class="xe-type">${escapeExportHtml(typeLabel)}</span>`];
  if (updatedLabel) {
    metaItems.push(`<span class="xe-updated">更新于 ${escapeExportHtml(updatedLabel)}</span>`);
  }
  if (tags.length) {
    metaItems.push(
      `<span class="xe-tags">${tags
        .map((tag) => `<span class="xe-tag">#${escapeExportHtml(tag)}</span>`)
        .join('')}</span>`
    );
  }

  const body = input.contentHtml && input.contentHtml.trim()
    ? input.contentHtml
    : '<p class="xe-empty">本页暂无正文。</p>';

  return [
    '<article class="engram-export-doc">',
    '  <div class="xe-card">',
    '    <header class="xe-head">',
    dateLabel ? `      <div class="xe-kicker">${escapeExportHtml(dateLabel)}</div>` : '',
    `      <h1 class="xe-title">${escapeExportHtml(name)}</h1>`,
    `      <div class="xe-meta">${metaItems.join('<span class="xe-dot">·</span>')}</div>`,
    '    </header>',
    `    <div class="xe-content">${body}</div>`,
    '    <footer class="xe-foot">',
    '      <span class="xe-brand">Engram</span>',
    `      <span>导出于 ${escapeExportHtml(exportedLabel)}${metrics ? ` · ${escapeExportHtml(metrics)}` : ''}</span>`,
    '    </footer>',
    '  </div>',
    '</article>',
  ].join('\n');
}
