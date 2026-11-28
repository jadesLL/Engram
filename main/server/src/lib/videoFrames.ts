import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 关键帧抽取：把成文里的 `![图注](frame:MM:SS)` 占位换成真实截图。
 *
 * 分工：
 *  - 视频模型在观看笔记里已经看过画面，由文本模型决定哪些论点值得配图、选哪个时间点；
 *  - 这里只做确定性的事：校验时间点、调 ffmpeg 抽一张 jpg、交给 imageAssets 落盘。
 *
 * 时间点格式支持 mm:ss 与 hh:mm:ss；超出视频时长的按片尾处理，避免 ffmpeg 抽不到帧。
 */

/** `frame:MM:SS` / `frame:HH:MM:SS` 占位（只看 markdown 图片语法里的 src） */
const FRAME_SRC_RE = /frame:(\d{1,3}:\d{2}(?::\d{2})?)/i;

export function parseFrameTimestamp(raw: string): number | null {
  const parts = String(raw || '').trim().split(':').map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
  return Number.isFinite(seconds) ? seconds : null;
}

export function formatFrameTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface FramePlaceholder {
  /** 占位出现的位置（用于替换时保持顺序，不直接改正文） */
  start: number;
  end: number;
  alt: string;
  timestamp: string;
  seconds: number;
}

/** 扫描正文里的 frame 占位（按出现顺序） */
export function parseFramePlaceholders(markdown: string): FramePlaceholder[] {
  const out: FramePlaceholder[] = [];
  const re = /!\[([^\]]*)\]\(\s*(frame:[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/gi;
  for (const match of String(markdown || '').matchAll(re)) {
    const src = FRAME_SRC_RE.exec(match[2] || '');
    if (!src) continue;
    const seconds = parseFrameTimestamp(src[1]);
    if (seconds === null) continue;
    out.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      alt: match[1] || '视频截图',
      timestamp: src[1],
      seconds,
    });
  }
  return out;
}

/** 正文里是否还有 frame 占位（测试与兜底用） */
export function hasFramePlaceholder(markdown: string): boolean {
  return parseFramePlaceholders(markdown).length > 0;
}

/**
 * 把占位替换成真实图片 URL；resolve 返回 null 表示这张抽不到，整段占位删掉（不留下破图）。
 * 替换按位置从后往前做，避免前面的长度变化影响后面的索引。
 */
export function replaceFramePlaceholders(
  markdown: string,
  resolve: (frame: FramePlaceholder) => string | null
): { markdown: string; replaced: number } {
  const placeholders = parseFramePlaceholders(markdown);
  let result = String(markdown || '');
  let replaced = 0;
  for (let index = placeholders.length - 1; index >= 0; index -= 1) {
    const frame = placeholders[index];
    const url = resolve(frame);
    result = result.slice(0, frame.start) + (url ? `![${frame.alt}](${url})` : '') + result.slice(frame.end);
    if (url) replaced += 1;
  }
  return { markdown: result.replace(/\n{3,}/g, '\n\n'), replaced };
}

export interface ExtractedFrame {
  seconds: number;
  path: string;
  bytes: number;
}

export interface ExtractFramesOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxWidth?: number;
  onProgress?: (message: string) => void;
  /** 单帧失败时回调；不传则整批失败。截图是增强项，调用方通常选择跳过坏帧继续 */
  onFrameError?: (seconds: number, error: Error) => void;
}

/** 调 ffmpeg 抽一帧；失败抛可读错误，由上层决定是否降级 */
export async function extractFrames(
  ffmpegPath: string,
  videoPath: string,
  timestamps: number[],
  destDir: string,
  options: ExtractFramesOptions = {}
): Promise<ExtractedFrame[]> {
  fs.mkdirSync(destDir, { recursive: true });
  const unique = [...new Set(timestamps.map((value) => Math.max(0, Number(value) || 0)))].sort((a, b) => a - b);
  const maxWidth = Math.max(320, Number(options.maxWidth) || 1280);
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || 30_000);
  const frames: ExtractedFrame[] = [];
  for (let index = 0; index < unique.length; index += 1) {
    options.signal?.throwIfAborted();
    const seconds = unique[index];
    const out = path.join(destDir, `frame-${String(index + 1).padStart(2, '0')}.jpg`);
    options.onProgress?.(`抽取关键帧 ${index + 1}/${unique.length}`);
    try {
      await runFfmpeg(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', seconds.toFixed(3),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', `scale='min(${maxWidth},iw)':-2`,
        '-q:v', '3',
        '-y',
        out,
      ], { signal: options.signal, timeoutMs });
      const stat = fs.statSync(out);
      if (!stat.isFile() || stat.size <= 0) throw new Error('图片为空');
      frames.push({ seconds, path: out, bytes: stat.size });
    } catch (error: any) {
      options.signal?.throwIfAborted();
      if (!options.onFrameError) throw error;
      options.onFrameError(seconds, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return frames;
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg 超时（${Math.round(options.timeoutMs / 1000)} 秒）`));
    }, options.timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      reject(new Error('关键帧抽取已取消'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new Error('无法启动 ffmpeg：' + (error?.message || String(error))));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error('ffmpeg 退出码 ' + code + (stderr ? '：' + stderr.trim() : '')));
    });
  });
}
