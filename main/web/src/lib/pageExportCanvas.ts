/**
 * 导出稿 → canvas 的绘制器（长图用）。
 *
 * 为什么不用「SVG foreignObject + drawImage」：2026-11 实测 Chromium 157 / Edge 157
 * 对任何含 foreignObject 的 SVG 都标记为 not origin-clean，`canvas.toBlob` 直接抛
 * 「Tainted canvases may not be exported」（空白页 + 纯文本 foreignObject 也复现）。
 * 因此改为直接读浏览器的排版结果、用 Canvas 2D 重绘：
 *  - 元素背景 / 边框：按 getBoundingClientRect + getComputedStyle 画矩形；
 *  - 文本：按 Range 的 client rect 逐行取子串，用同样的字体 / 颜色 fillText；
 *  - 图片：导出前已内联成 data URL，drawImage 不会污染画布；
 *  - 列表符号 / 复选框：DOM 的 ::marker 和原生控件拿不到位图，按语义补画。
 *
 * 这样在 Electron、Docker 浏览器与 Android WebView 上走的是同一条 Canvas 2D 路径，
 * 不依赖 SVG 的图像解码安全策略，也不需要 html2canvas 之类的新依赖。
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * 内联 SVG（Mermaid / 手写 SVG）的预渲染结果。
 * Mermaid 的标签是 foreignObject，整段 SVG 直接当图片画会污染画布；所以把 foreignObject
 * 从克隆里摘掉、只光栅化图形，标签文字再用 DOM 绘制器补回去。
 */
export interface ExportCanvasAssets {
  svgImages: WeakMap<SVGSVGElement, HTMLImageElement>;
  svgLabels: WeakMap<SVGSVGElement, Element[]>;
  objectUrls: string[];
}

export function emptyExportCanvasAssets(): ExportCanvasAssets {
  return { svgImages: new WeakMap(), svgLabels: new WeakMap(), objectUrls: [] };
}

export function disposeExportCanvasAssets(assets: ExportCanvasAssets | null): void {
  if (!assets) return;
  for (const url of assets.objectUrls) URL.revokeObjectURL(url);
  assets.objectUrls.length = 0;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'sync';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SVG 图片加载失败'));
    image.src = url;
  });
}

/**
 * 预渲染导出稿里的内联 SVG：图形与标签分开处理。
 * - 图形：克隆后移除 foreignObject，序列化成 SVG blob → Image（不含 foreignObject 的 SVG
 *   不会污染画布，实测 Chromium 157 可正常 toBlob）；
 * - 标签：保留 live DOM 里的 foreignObject 子元素，绘制时按版面位置补画文字。
 */
export async function prepareExportCanvasAssets(root: HTMLElement): Promise<ExportCanvasAssets> {
  const assets = emptyExportCanvasAssets();
  const svgs = Array.from(root.querySelectorAll('svg')) as SVGSVGElement[];
  await Promise.all(svgs.map(async (svg) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const labels = Array.from(svg.querySelectorAll('foreignObject'))
      .map((foreign) => foreign.firstElementChild)
      .filter((element): element is Element => Boolean(element));
    if (labels.length) assets.svgLabels.set(svg, labels);

    const clone = svg.cloneNode(true) as SVGSVGElement;
    for (const foreign of Array.from(clone.querySelectorAll('foreignObject'))) foreign.remove();
    clone.setAttribute('width', String(rect.width));
    clone.setAttribute('height', String(rect.height));
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' })
    );
    assets.objectUrls.push(url);
    try {
      const image = await loadImage(url);
      // 外链图片会把整张长图变成污染画布：先在小画布上试一次，失败就只画标签
      const probe = document.createElement('canvas');
      probe.width = 8;
      probe.height = 8;
      probe.getContext('2d')?.drawImage(image, 0, 0, 8, 8);
      probe.toDataURL();
      assets.svgImages.set(svg, image);
    } catch {
      // 图形画不出来时保留标签，至少不吞掉图里的文字
    }
  }));
  return assets;
}

function px(value: string | null | undefined): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function visibleColor(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  return normalized !== 'transparent' && normalized !== 'rgba(0,0,0,0)' && normalized !== 'rgba(0,0,0,0.0)';
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(Math.max(radius, 0), width / 2, height / 2);
  if (r <= 0.5) {
    ctx.rect(x, y, width, height);
    return;
  }
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  if (width <= 0 || height <= 0) return;
  ctx.beginPath();
  roundRectPath(ctx, x, y, width, height, radius);
  ctx.fill();
}

function borderRadius(style: CSSStyleDeclaration): number {
  return Math.max(
    px(style.borderTopLeftRadius),
    px(style.borderTopRightRadius),
    px(style.borderBottomRightRadius),
    px(style.borderBottomLeftRadius)
  );
}

function fontOf(style: CSSStyleDeclaration, scale = 1): string {
  const size = px(style.fontSize) * scale || 16 * scale;
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${size}px ${style.fontFamily || 'sans-serif'}`;
}

function paintBorderSide(
  ctx: CanvasRenderingContext2D,
  width: number,
  style: string,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  side: 'top' | 'right' | 'bottom' | 'left'
): void {
  if (width <= 0 || style === 'none' || style === 'hidden' || !visibleColor(color)) return;
  ctx.fillStyle = color;
  if (side === 'top') ctx.fillRect(x, y, w, width);
  else if (side === 'bottom') ctx.fillRect(x, y + h - width, w, width);
  else if (side === 'left') ctx.fillRect(x, y, width, h);
  else ctx.fillRect(x + w - width, y, width, h);
}

function paintBox(
  ctx: CanvasRenderingContext2D,
  rect: DOMRect,
  style: CSSStyleDeclaration,
  origin: DOMRect,
  scale = 1
): void {
  const x = rect.left - origin.left;
  const y = rect.top - origin.top;
  if (visibleColor(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    fillRoundRect(ctx, x, y, rect.width, rect.height, borderRadius(style) * scale);
  }
  paintBorderSide(ctx, px(style.borderTopWidth) * scale, style.borderTopStyle, style.borderTopColor, x, y, rect.width, rect.height, 'top');
  paintBorderSide(ctx, px(style.borderRightWidth) * scale, style.borderRightStyle, style.borderRightColor, x, y, rect.width, rect.height, 'right');
  paintBorderSide(ctx, px(style.borderBottomWidth) * scale, style.borderBottomStyle, style.borderBottomColor, x, y, rect.width, rect.height, 'bottom');
  paintBorderSide(ctx, px(style.borderLeftWidth) * scale, style.borderLeftStyle, style.borderLeftColor, x, y, rect.width, rect.height, 'left');
}

function paintImage(ctx: CanvasRenderingContext2D, image: HTMLImageElement, origin: DOMRect): void {
  if (!image.complete || !image.naturalWidth) return;
  const rect = image.getBoundingClientRect();
  if (rect.width < 0.5 || rect.height < 0.5) return;
  const style = getComputedStyle(image);
  const x = rect.left - origin.left;
  const y = rect.top - origin.top;
  ctx.save();
  if (visibleColor(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    fillRoundRect(ctx, x, y, rect.width, rect.height, borderRadius(style));
  }
  const radius = borderRadius(style);
  if (radius > 0.5) {
    ctx.beginPath();
    roundRectPath(ctx, x, y, rect.width, rect.height, radius);
    ctx.clip();
  }
  ctx.drawImage(image, x, y, rect.width, rect.height);
  ctx.restore();
}

function paintCheckbox(ctx: CanvasRenderingContext2D, input: HTMLInputElement, origin: DOMRect): void {
  if (input.type !== 'checkbox') return;
  const rect = input.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const x = rect.left - origin.left;
  const y = rect.top - origin.top;
  ctx.fillStyle = '#ffffff';
  fillRoundRect(ctx, x, y, rect.width, rect.height, 3);
  ctx.strokeStyle = input.checked ? '#2b5ce6' : 'rgba(20, 26, 40, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  roundRectPath(ctx, x + 0.5, y + 0.5, rect.width - 1, rect.height - 1, 3);
  ctx.stroke();
  if (input.checked) {
    ctx.strokeStyle = '#2b5ce6';
    ctx.lineWidth = Math.max(1.5, rect.width * 0.12);
    ctx.beginPath();
    ctx.moveTo(x + rect.width * 0.24, y + rect.height * 0.52);
    ctx.lineTo(x + rect.width * 0.43, y + rect.height * 0.72);
    ctx.lineTo(x + rect.width * 0.78, y + rect.height * 0.28);
    ctx.stroke();
  }
}

function orderedStart(list: HTMLElement): number {
  const raw = Number.parseInt(list.getAttribute('start') || '', 10);
  return Number.isFinite(raw) ? raw : 1;
}

function paintListMarkers(ctx: CanvasRenderingContext2D, list: HTMLElement, origin: DOMRect): void {
  const ordered = list.tagName === 'OL';
  const start = orderedStart(list);
  let index = 0;
  for (const child of Array.from(list.children)) {
    if (child.tagName !== 'LI') continue;
    const item = child as HTMLElement;
    const style = getComputedStyle(item);
    const rect = item.getBoundingClientRect();
    index += 1;
    if (rect.height < 1) continue;
    if (style.listStyleType === 'none' || item.classList.contains('vditor-task')) continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const value = Number.parseInt(item.getAttribute('value') || '', 10);
    const number = Number.isFinite(value) ? value : start + index - 1;
    const marker = ordered
      ? `${number}.`
      : style.listStyleType === 'circle'
        ? '◦'
        : style.listStyleType === 'square'
          ? '▪'
          : '•';
    const lineHeight = px(style.lineHeight) || px(style.fontSize) * 1.6 || 24;
    ctx.fillStyle = style.color || '#26231f';
    ctx.font = fontOf(style);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(marker, rect.left - origin.left - 6, rect.top - origin.top + Math.min(lineHeight, rect.height) / 2);
    ctx.textAlign = 'left';
  }
}

/** 把文本节点切成「同行可一次画完」的小段：CJK 按字、英文按词、换行单独成段。 */
function textTokens(value: string): string[] {
  return value.match(/[^\S\n]+|\n|[\u3040-\u30ff\u3400-\u9fff]|[^\s\u3040-\u30ff\u3400-\u9fff]+/gu) || [];
}

function tokenTop(node: Text, range: Range, start: number, end: number): { top: number; height: number } {
  range.setStart(node, start);
  range.setEnd(node, Math.max(start + 1, end));
  const rect = range.getBoundingClientRect();
  return { top: Math.round(rect.top), height: rect.height };
}

function paintText(
  ctx: CanvasRenderingContext2D,
  node: Text,
  style: CSSStyleDeclaration,
  origin: DOMRect,
  scale = 1
): void {
  const value = node.nodeValue || '';
  if (!value || !value.trim()) return;
  if (style.visibility === 'hidden' || style.display === 'none') return;
  const tokens = textTokens(value);
  if (!tokens.length) return;
  const range = document.createRange();
  const runs: Array<{ start: number; end: number; top: number }> = [];
  let offset = 0;
  for (const token of tokens) {
    const start = offset;
    offset += token.length;
    let first = tokenTop(node, range, start, start + 1);
    let last = token.length > 1 ? tokenTop(node, range, start + token.length - 1, start + token.length) : first;
    if (token.length > 1 && first.top !== last.top) {
      // 长单词 / 长 URL 被折行：按字符重新切，避免一行画到行外
      for (let index = 0; index < token.length; index += 1) {
        const at = start + index;
        const top = tokenTop(node, range, at, at + 1).top;
        if (!runs.length || runs[runs.length - 1].top !== top) runs.push({ start: at, end: at + 1, top });
        else runs[runs.length - 1].end = at + 1;
      }
      continue;
    }
    if (!runs.length || runs[runs.length - 1].top !== first.top) runs.push({ start, end: offset, top: first.top });
    else runs[runs.length - 1].end = offset;
  }

  ctx.font = fontOf(style, scale);
  ctx.fillStyle = style.color || '#26231f';
  ctx.textBaseline = 'middle';
  for (const run of runs) {
    const text = value.slice(run.start, run.end);
    if (!text.trim()) continue;
    range.setStart(node, run.start);
    range.setEnd(node, run.end);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0.5 && rect.height > 0.5);
    if (!rects.length) continue;
    const rect = rects[0];
    ctx.fillText(
      text.replace(/\u00a0/g, ' '),
      rect.left - origin.left,
      rect.top - origin.top + rect.height / 2
    );
  }
}

function paintInlineSvg(
  ctx: CanvasRenderingContext2D,
  svg: SVGSVGElement,
  origin: DOMRect,
  assets: ExportCanvasAssets | null
): void {
  const rect = svg.getBoundingClientRect();
  if (rect.width < 0.5 || rect.height < 0.5) return;
  const image = assets?.svgImages.get(svg);
  if (image) {
    ctx.drawImage(image, rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
  }
  // Mermaid 的节点 / 连线文字在 foreignObject 里：图形已经画好，这里按版面位置补文字。
  // foreignObject 里的 fontSize 是 SVG 用户单位，浏览器会按 viewBox 缩放后再渲染；
  // 画布必须补乘同一个缩放比，否则标签文字会比节点框大一圈、互相压住。
  const viewBox = svg.viewBox?.baseVal;
  const labelScale = viewBox && viewBox.width > 0 && viewBox.height > 0
    ? Math.min(rect.width / viewBox.width, rect.height / viewBox.height)
    : 1;
  for (const label of assets?.svgLabels.get(svg) || []) {
    paintElement(ctx, label, origin, assets, labelScale);
  }
}

function paintElement(
  ctx: CanvasRenderingContext2D,
  element: Element,
  origin: DOMRect,
  assets: ExportCanvasAssets | null,
  scale = 1
): void {
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return;
  const tag = element.tagName;
  if (tag === 'IMG' || tag === 'INPUT') return; // 由父级按类型单独处理
  if (tag === 'svg') {
    paintInlineSvg(ctx, element as unknown as SVGSVGElement, origin, assets);
    return;
  }
  /* 行内元素（code / a / span）折行时 getBoundingClientRect 是整段并集，直接拿去画背景
     会把上一行前缀一起盖住；getClientRects 才是逐行片段。块级元素仍用整块。 */
  const rects = style.display === 'inline'
    ? Array.from(element.getClientRects())
    : [element.getBoundingClientRect()];
  const visible = rects.filter((rect) => rect.width >= 0.5 && rect.height >= 0.5);
  if (!visible.length) return;
  for (const rect of visible) paintBox(ctx, rect, style, origin, scale);
  if (tag === 'UL' || tag === 'OL') paintListMarkers(ctx, element as HTMLElement, origin);

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      paintText(ctx, child as Text, style, origin, scale);
    } else if (child.nodeType === ELEMENT_NODE) {
      const node = child as HTMLElement;
      if (node.tagName === 'IMG') paintImage(ctx, node as HTMLImageElement, origin);
      else if (node.tagName === 'INPUT') paintCheckbox(ctx, node as HTMLInputElement, origin);
      else paintElement(ctx, node, origin, assets, scale);
    }
  }
}

/**
 * 把导出稿画到 canvas（CSS 像素坐标，调用方负责 scale）。
 * 返回 false 表示没有可画的尺寸（调用方报错）。
 */
export function paintExportCanvas(
  ctx: CanvasRenderingContext2D,
  article: HTMLElement,
  background: string,
  assets: ExportCanvasAssets | null = null
): boolean {
  const origin = article.getBoundingClientRect();
  if (origin.width < 1 || origin.height < 1) return false;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, origin.width, origin.height);
  paintElement(ctx, article, origin, assets);
  return true;
}
