/**
 * 正文图片的显示宽度。
 *
 * 宽度写在图片 URL 的 fragment 里（`/media/<父项id>/<文件>#w=320`），不另造 Markdown 语法：
 *  - 仍然是标准图片语法，Vditor、阅读态、导出包和其它 Markdown 渲染器都认得；
 *  - fragment 不会发给服务端，图片仍按内容寻址缓存，`/media` 路由与同步链路不需要改动；
 *  - 导出 md / html 时 `files.ts` 只把 `/media/` 前缀换成相对路径，`#w=` 会原样保留。
 *
 * 只处理本库图片（`/media/...`）。外链图有自己的 query / fragment 语义（签名、SVG 片段），
 * 不能往里塞宽度；它们在被服务端本地化之后才会变成 `/media` 引用。
 */

export const MEDIA_PREFIX = '/media/';

/** 本库图片引用：`/media/<父项id>/<文件名>`（允许 query / fragment） */
export function isLocalMediaImageSrc(src: string): boolean {
  if (!src.startsWith(MEDIA_PREFIX)) return false;
  const rest = src.slice(MEDIA_PREFIX.length).split(/[?#]/)[0];
  const parts = rest.split('/');
  return parts.length === 2 && parts.every(Boolean);
}

/** 从 URL 里读出显式宽度；不是本库图片或没写宽度时返回 null */
export function imageWidthFromSrc(src: string): number | null {
  if (!isLocalMediaImageSrc(src)) return null;
  const hash = src.indexOf('#');
  if (hash < 0) return null;
  const fragment = src.slice(hash + 1);
  for (const part of fragment.split('&')) {
    const match = /^w=(\d+)$/.exec(part);
    if (!match) continue;
    const width = Number(match[1]);
    return Number.isFinite(width) && width >= 1 ? width : null;
  }
  return null;
}

/**
 * 写入 / 清除宽度。`width` 为 null 时只移除 `w` 参数，URL 上原有的其它 fragment 保留。
 * 非本库图片原样返回。
 */
export function withImageWidth(src: string, width: number | null): string {
  if (!isLocalMediaImageSrc(src)) return src;
  const hash = src.indexOf('#');
  const base = hash >= 0 ? src.slice(0, hash) : src;
  const fragment = hash >= 0 ? src.slice(hash + 1) : '';
  const parts = fragment
    .split('&')
    .filter(Boolean)
    .filter((part) => !/^w(?:=|$)/.test(part));
  if (width !== null && Number.isFinite(width) && width >= 1) {
    parts.push(`w=${Math.round(width)}`);
  }
  return parts.length ? `${base}#${parts.join('&')}` : base;
}

/**
 * 把宽度应用到已经渲染出来的图片 DOM（阅读态 / 文件预览 / 收集箱审阅 / 编辑器共用）。
 *
 * 用 inline style 而不是 width 属性：`max-width: 100%` 仍然生效，窄窗口与手机上不会撑破版面。
 * 标记 data-eg-image-width 只用于撤掉宽度时精确回收本函数写过的样式，不碰其它内联样式。
 */
export function applyImageWidths(root: ParentNode | null | undefined): void {
  if (!root) return;
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    // 拖动预览中的图片由编辑页自己管宽度，别在重渲染时把 inline width 又贴回旧值
    if (image.dataset.egImagePreview) continue;
    const src = image.getAttribute('src') || '';
    const width = imageWidthFromSrc(src);
    if (width) {
      image.style.width = `${width}px`;
      image.style.maxWidth = '100%';
      image.style.height = 'auto';
      image.dataset.egImageWidth = String(width);
      continue;
    }
    if (!image.dataset.egImageWidth) continue;
    image.style.removeProperty('width');
    image.style.removeProperty('max-width');
    image.style.removeProperty('height');
    delete image.dataset.egImageWidth;
  }
}
