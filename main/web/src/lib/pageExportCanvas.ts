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

function fontOf(style: CSSStyleDeclaration): string {
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize || '16px'} ${style.fontFamily || 'sans-serif'}`;
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
  origin: DOMRect
): void {
  const x = rect.left - origin.left;
  const y = rect.top - origin.top;
  if (visibleColor(style.backgroundColor)) {
    ctx.fillStyle = style.backgroundColor;
    fillRoundRect(ctx, x, y, rect.width, rect.height, borderRadius(style));
  }
  paintBorderSide(ctx, px(style.borderTopWidth), style.borderTopStyle, style.borderTopColor, x, y, rect.width, rect.height, 'top');
  paintBorderSide(ctx, px(style.borderRightWidth), style.borderRightStyle, style.borderRightColor, x, y, rect.width, rect.height, 'right');
  paintBorderSide(ctx, px(style.borderBottomWidth), style.borderBottomStyle, style.borderBottomColor, x, y, rect.width, rect.height, 'bottom');
  paintBorderSide(ctx, px(style.borderLeftWidth), style.borderLeftStyle, style.borderLeftColor, x, y, rect.width, rect.height, 'left');
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
  origin: DOMRect
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

  ctx.font = fontOf(style);
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

function paintElement(ctx: CanvasRenderingContext2D, element: Element, origin: DOMRect): void {
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return;
  const rect = element.getBoundingClientRect();
  if (rect.width < 0.5 || rect.height < 0.5) return;
  const tag = element.tagName;
  if (tag === 'IMG' || tag === 'INPUT') return; // 由父级按类型单独处理
  paintBox(ctx, rect, style, origin);
  if (tag === 'UL' || tag === 'OL') paintListMarkers(ctx, element as HTMLElement, origin);

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      paintText(ctx, child as Text, style, origin);
    } else if (child.nodeType === ELEMENT_NODE) {
      const node = child as HTMLElement;
      if (node.tagName === 'IMG') paintImage(ctx, node as HTMLImageElement, origin);
      else if (node.tagName === 'INPUT') paintCheckbox(ctx, node as HTMLInputElement, origin);
      else paintElement(ctx, node, origin);
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
  background: string
): boolean {
  const origin = article.getBoundingClientRect();
  if (origin.width < 1 || origin.height < 1) return false;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, origin.width, origin.height);
  paintElement(ctx, article, origin);
  return true;
}
