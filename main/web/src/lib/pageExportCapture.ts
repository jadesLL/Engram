import { vditorPreviewOptions } from './vditorPreview';
import { applyImageWidths } from './imageWidth';
import { wikiLinksToMarkdown } from './wikiLinks';
import { stripTrailingEmptyTableRows } from './markdownTableCleanup';
import { readingMetrics } from './readingPreview';
import { notify, dismissToast } from './notify';
import { paintExportCanvas } from './pageExportCanvas';
import {
  buildExportArticle,
  EXPORT_MAX_OUTPUT_HEIGHT,
  EXPORT_MAX_OUTPUT_HEIGHT_ANDROID,
  EXPORT_PIXEL_RATIO,
  EXPORT_SHEET_WIDTH,
  exportDisplayName,
  exportFileName,
  type PageExportMeta,
} from './pageExport';

/**
 * 单页导出：PDF（打印通道）与整篇长图（浏览器排版 + Canvas 2D 重绘）。
 *
 * 为什么不用 jsPDF / html2canvas：
 *  - 依赖需要联网安装，项目默认离线 verify；而 Chromium（Electron / Docker 浏览器 /
 *    Android WebView）自带「打印成 PDF」，PDF 里文字可选中；
 *  - 长图只需要把同一棵导出 DOM 按排版结果画一次（pageExportCanvas.ts），自己实现可控，
 *    也不依赖 SVG foreignObject 的图像安全策略（Chromium 157 会把它标记成污染画布）。
 *
 * 三端保存通道：
 *  - Windows 桌面：`wikiDesktop.exportPdf` / `wikiDesktop.saveExportFile`（主进程弹另存为）；
 *  - Android：`EngramPageExport.saveImage`（SAF 另存为）/ `EngramPageExport.printPage`
 *    （系统打印面板，可选「另存为 PDF」）；
 *  - 浏览器（Docker / 开发机）：PDF 走 window.print()，PNG 走 a[download]。
 */

const PRINT_ROOT_ID = 'engram-export-root';
/** Android 打印面板没有关闭回调：导出稿先留在离屏 DOM 里，超时再回收，避免打印预览取不到内容。 */
const ANDROID_PRINT_ROOT_TTL_MS = 5 * 60 * 1000;

interface DesktopExportBridge {
  exportPdf?: (name: string) => Promise<{ canceled?: boolean; filePath?: string; error?: string } | undefined>;
  saveExportFile?: (
    name: string,
    bytes: ArrayBuffer
  ) => Promise<{ canceled?: boolean; filePath?: string; error?: string } | undefined>;
}

interface AndroidExportBridge {
  saveImage?: (dataUrl: string, name: string) => boolean;
  printPage?: (name: string) => boolean;
}

function desktopBridge(): DesktopExportBridge | undefined {
  return (window as unknown as { wikiDesktop?: DesktopExportBridge }).wikiDesktop;
}

function androidBridge(): AndroidExportBridge | undefined {
  return (window as unknown as { EngramPageExport?: AndroidExportBridge }).EngramPageExport;
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '导出失败');
}

let busy = false;
let orphanRoot: HTMLElement | null = null;
let orphanTimer: ReturnType<typeof setTimeout> | null = null;

function disposeOrphanRoot(): void {
  if (orphanTimer) {
    clearTimeout(orphanTimer);
    orphanTimer = null;
  }
  orphanRoot?.remove();
  orphanRoot = null;
}

function keepRootForAndroidPrint(root: HTMLElement): void {
  disposeOrphanRoot();
  orphanRoot = root;
  orphanTimer = setTimeout(() => {
    orphanRoot?.remove();
    orphanRoot = null;
    orphanTimer = null;
  }, ANDROID_PRINT_ROOT_TTL_MS);
}

interface PreparedSheet {
  root: HTMLElement;
  article: HTMLElement;
  width: number;
  height: number;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

/** 导出稿里的图片全部换成 data URL：canvas 只要碰到外链就会 taint，toBlob 会直接失败。 */
async function inlineImages(root: ParentNode): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) return;
    const alt = img.getAttribute('alt') || '';
    const replaceWithFallback = () => {
      const fallback = document.createElement('span');
      fallback.className = 'xe-img-missing';
      fallback.textContent = alt ? `图片未能嵌入：${alt}` : '图片未能嵌入';
      img.replaceWith(fallback);
    };
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const url = new URL(src, window.location.href);
      controller = new AbortController();
      timer = setTimeout(() => controller?.abort(), 6000);
      // 同源走 cookie（/media 需要登录态）；外链只尝试 CORS，失败保留占位，不让整次导出失败
      const response = await fetch(url.href, {
        credentials: url.origin === window.location.origin ? 'same-origin' : 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      img.removeAttribute('srcset');
      img.setAttribute('src', await blobToDataUrl(blob));
    } catch {
      replaceWithFallback();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}

async function waitForImages(root: ParentNode): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map(async (img) => {
    img.loading = 'eager';
    if (typeof img.decode !== 'function') return;
    try {
      await img.decode();
    } catch {
      // 破图（mime 不对 / 文件丢了）不阻断导出：浏览器会画 alt 或占位框
    }
  }));
}

function cleanRenderedHtml(root: HTMLElement): void {
  for (const node of Array.from(root.querySelectorAll('.vditor-anchor, .vditor-copy, .vditor-toc'))) {
    node.remove();
  }
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    link.removeAttribute('target');
    link.removeAttribute('rel');
  }
}

/**
 * 把 Markdown 渲染成屏幕外的导出稿并挂到 body。
 *
 * 导出稿必须是 body 的直接子元素：打印时用 `body > :not(#engram-export-root)` 把应用本体
 * （包括 Teleport 出来的浮层 / toast）整棵藏掉，只留这一份。
 */
async function prepareSheet(meta: PageExportMeta): Promise<PreparedSheet> {
  disposeOrphanRoot();
  document.getElementById(PRINT_ROOT_ID)?.remove();

  const host = document.createElement('div');
  const source = stripTrailingEmptyTableRows(wikiLinksToMarkdown(meta.markdown || ''));
  if (source.trim()) {
    // Vditor 是编辑器链路上最重的一块：点导出时才按需加载，别把它挂在编辑页首屏
    const { default: Vditor } = await import('vditor');
    await Vditor.preview(host, source, vditorPreviewOptions(false));
    applyImageWidths(host);
    cleanRenderedHtml(host);
    await inlineImages(host);
    await waitForImages(host);
  }

  const metrics = readingMetrics(`${meta.title}\n${host.textContent || ''}`);
  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = buildExportArticle({
    title: meta.title,
    contentHtml: host.innerHTML,
    typeLabel: meta.typeLabel,
    tags: meta.tags,
    updatedAt: meta.updatedAt,
    formatDocumentTitle: meta.formatDocumentTitle,
    metrics,
  });
  document.body.appendChild(root);

  if (document.fonts?.ready) {
    await document.fonts.ready.catch(() => {});
  }

  const article = root.querySelector<HTMLElement>('.engram-export-doc');
  if (!article) {
    root.remove();
    throw new Error('导出文档生成失败');
  }
  await waitForImages(article);
  const rect = article.getBoundingClientRect();
  return {
    root,
    article,
    width: Math.max(1, Math.ceil(rect.width) || EXPORT_SHEET_WIDTH),
    height: Math.max(1, Math.ceil(rect.height)),
  };
}

function outputHeightLimit(): number {
  return androidBridge() ? EXPORT_MAX_OUTPUT_HEIGHT_ANDROID : EXPORT_MAX_OUTPUT_HEIGHT;
}

/** 导出稿 → PNG。返回的 blob 已经是最终成图尺寸。 */
async function capturePng(sheet: PreparedSheet): Promise<Blob> {
  const limit = outputHeightLimit();
  if (sheet.height > limit) {
    throw new Error(`内容太长（约 ${sheet.height}px），长图上限 ${limit}px；请改用「导出为 PDF」`);
  }
  const scale = Math.min(EXPORT_PIXEL_RATIO, limit / sheet.height);
  const width = sheet.width;
  const height = sheet.height;

  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建长图画布');
  context.scale(scale, scale);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // 直接按浏览器的排版结果重绘（见 pageExportCanvas.ts 头注释：foreignObject 在
  // Chromium 157 上会污染画布，toBlob 直接失败）
  if (!paintExportCanvas(context, sheet.article, '#f3efe6')) {
    throw new Error('导出稿没有可绘制的尺寸');
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('浏览器未能生成 PNG');
  return blob;
}

async function savePng(blob: Blob, filename: string): Promise<void> {
  const desktop = desktopBridge();
  if (desktop?.saveExportFile) {
    const result = await desktop.saveExportFile(filename, await blob.arrayBuffer());
    if (result?.error) throw new Error(result.error);
    if (result?.canceled) {
      notify.info('已取消导出');
      return;
    }
    notify.success(result?.filePath ? `长图已保存：${basename(result.filePath)}` : '长图已保存');
    return;
  }

  const android = androidBridge();
  if (android?.saveImage) {
    const accepted = android.saveImage(await blobToDataUrl(blob), filename);
    if (!accepted) throw new Error('系统保存面板不可用');
    notify.info('请在系统对话框里选择保存位置');
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  notify.success('长图已开始下载');
}

async function runPdf(sheet: PreparedSheet, filename: string): Promise<void> {
  const desktop = desktopBridge();
  if (desktop?.exportPdf) {
    const result = await desktop.exportPdf(filename);
    sheet.root.remove();
    if (result?.error) throw new Error(result.error);
    if (result?.canceled) {
      notify.info('已取消导出');
      return;
    }
    notify.success(result?.filePath ? `PDF 已保存：${basename(result.filePath)}` : 'PDF 已保存');
    return;
  }

  const android = androidBridge();
  if (android?.printPage) {
    if (!android.printPage(filename.replace(/\.pdf$/i, ''))) {
      throw new Error('系统打印面板不可用');
    }
    // 打印适配器可能在对话框关闭后才取页面内容：这份离屏导出稿不能立刻删
    keepRootForAndroidPrint(sheet.root);
    notify.info('在打印面板里选择「另存为 PDF」即可保存');
    return;
  }

  // 浏览器：Chromium 打印预览自带「另存为 PDF」，标题会作为默认文件名
  const previousTitle = document.title;
  document.title = filename.replace(/\.pdf$/i, '');
  const cleanup = () => {
    document.title = previousTitle;
    sheet.root.remove();
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 120000);
  notify.info('在打印对话框里选择「另存为 PDF」');
  window.print();
}

/** 导出当前笔记为 PDF（桌面直接落盘；浏览器 / Android 走系统打印面板的「另存为 PDF」）。 */
export async function exportPagePdf(meta: PageExportMeta): Promise<void> {
  if (busy) {
    notify.info('正在生成导出文件，请稍候');
    return;
  }
  busy = true;
  const toastId = notify.info('正在准备导出稿…');
  let sheet: PreparedSheet | null = null;
  try {
    sheet = await prepareSheet(meta);
    const filename = exportFileName(exportDisplayName(meta).name, 'pdf');
    await runPdf(sheet, filename);
  } catch (error) {
    sheet?.root.remove();
    notify.error(errorMessage(error));
  } finally {
    dismissToast(toastId);
    busy = false;
  }
}

/** 导出当前笔记为整篇长图 PNG。 */
export async function exportPageImage(meta: PageExportMeta): Promise<void> {
  if (busy) {
    notify.info('正在生成导出文件，请稍候');
    return;
  }
  busy = true;
  const toastId = notify.info('正在生成长图…');
  let sheet: PreparedSheet | null = null;
  try {
    sheet = await prepareSheet(meta);
    const blob = await capturePng(sheet);
    const filename = exportFileName(exportDisplayName(meta).name, 'png');
    sheet.root.remove();
    sheet = null;
    await savePng(blob, filename);
  } catch (error) {
    notify.error(errorMessage(error));
  } finally {
    sheet?.root.remove();
    dismissToast(toastId);
    busy = false;
  }
}
