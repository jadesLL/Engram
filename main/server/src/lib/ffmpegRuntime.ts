import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from '../config.js';

/**
 * 视频关键帧抽取用的 ffmpeg 运行时。
 *
 * 为什么不把 ffmpeg 打进安装包/镜像：
 *  - 三端产物只共享 server/web，ffmpeg 是平台相关的原生二进制（Windows / Linux x64 / arm64），
 *    打进每个产物会让安装包和镜像多出几十 MB，而且 Docker 离线构建层也会被它拖慢；
 *  - Engram 已经有「按需下载运行时」的先例（本机语音模型、Python 运行时），视频配图复用同一套姿势：
 *    第一次需要截帧时下载到 <数据目录>/runtime/ffmpeg/<平台>-<架构>/，之后直接复用。
 *
 * 二进制的来源固定为 ffmpeg-static 的 b6.0 release（单文件 gz，Node 直接 gunzip，不依赖系统 tar/unzip）。
 * 每个平台都钉死 SHA256；校验失败就删除临时文件并放弃截帧，绝不执行未校验的二进制。
 * 该构建是 GPL 版本（含 x264 等），由上游 GitHub Release 直接下载；运行时目录会写一份 NOTICE 记录来源与许可。
 */

/** 上游 release tag（固定，不跟 latest；换版本时三个平台的 sha256 必须一起更新） */
const RELEASE_TAG = 'b6.0';
const RELEASE_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE_TAG}`;

interface FfmpegAsset {
  file: string;
  sha256: string;
}

/** 当前支持的平台；win32-arm64 / darwin 暂不提供，截帧会优雅降级为只放封面 */
const ASSETS: Record<string, FfmpegAsset> = {
  'win32-x64': {
    file: 'ffmpeg-win32-x64.gz',
    sha256: '450d66226c79405c724e821f291cab0911e934bfa9fa2231adcab587f3e07b50',
  },
  'linux-x64': {
    file: 'ffmpeg-linux-x64.gz',
    sha256: '17c1ae10b52ac499180679fe6ba77e17642390c4eedb0f1e3b0ac045da55128f',
  },
  'linux-arm64': {
    file: 'ffmpeg-linux-arm64.gz',
    sha256: '2b708b2d15041d2a192c1db24c7a8a1d24f645a8242dce1c744ff2392b86ada1',
  },
};

/** 运行时下载进度（字节）；jobs 会把它转成任务详情 */
export interface FfmpegProgress {
  (stage: string, detail?: string): void;
}

export interface EnsureFfmpegOptions {
  signal?: AbortSignal;
  onProgress?: FfmpegProgress;
  /** 测试/离线部署可覆盖二进制路径；传空串表示不下载 */
  download?: boolean;
}

export function ffmpegPlatformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

/** 当前平台是否提供了可下载的 ffmpeg 构建 */
export function ffmpegSupported(platform: string = process.platform, arch: string = process.arch): boolean {
  return Boolean(ASSETS[ffmpegPlatformKey(platform, arch)]);
}

export function ffmpegBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/** 运行时目录：<数据目录>/runtime/ffmpeg/<平台>-<架构> */
export function ffmpegRuntimeDir(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  return path.join(DATA_DIR, 'runtime', 'ffmpeg', ffmpegPlatformKey(platform, arch));
}

/** 已安装的 ffmpeg 路径；未安装返回 null（不触发下载） */
export function installedFfmpegPath(
  platform: string = process.platform,
  arch: string = process.arch
): string | null {
  const override = (process.env.VIDEO_FFMPEG_PATH || '').trim();
  if (override) {
    try {
      if (fs.statSync(override).isFile()) return override;
    } catch {
      /* 覆盖路径不存在时继续找运行时目录 */
    }
  }
  const bin = path.join(ffmpegRuntimeDir(platform, arch), ffmpegBinaryName(platform));
  try {
    return fs.statSync(bin).isFile() ? bin : null;
  } catch {
    return null;
  }
}

function assetFor(platform: string, arch: string): FfmpegAsset | null {
  return ASSETS[ffmpegPlatformKey(platform, arch)] || null;
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 同一时刻只跑一个下载：并发转换不会各自拉一遍几十 MB 的运行时 */
let downloading: Promise<string | null> | null = null;

/**
 * 确保 ffmpeg 可用：本机已有就直接返回；没有则按需下载、校验、解压。
 *
 * 任何失败都返回 null，由视频管线降级为「只放封面/不放图」，不能因为截图工具没装好让整条提炼失败。
 */
export async function ensureFfmpeg(options: EnsureFfmpegOptions = {}): Promise<string | null> {
  const installed = installedFfmpegPath();
  if (installed) return installed;
  if (options.download === false) return null;
  const asset = assetFor(process.platform, process.arch);
  if (!asset) {
    options.onProgress?.('准备截图', '当前平台没有可用的 ffmpeg 构建，跳过关键帧');
    return null;
  }
  if (downloading) return downloading;

  downloading = (async () => {
    const dir = ffmpegRuntimeDir();
    const bin = path.join(dir, ffmpegBinaryName());
    const tempDir = path.join(DATA_DIR, 'tmp', 'ffmpeg-' + crypto.randomUUID());
    const gzPath = path.join(tempDir, asset.file);
    const outPath = path.join(tempDir, ffmpegBinaryName());
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      options.onProgress?.('准备截图', '首次使用，下载 ffmpeg 运行时（约 29 MB）');
      // 企业内网/国内网络可把同版本 gz 放到自有镜像，用 VIDEO_FFMPEG_URL 覆盖下载地址；
      // 无论是上游还是镜像，仍按钉死的 SHA256 校验，镜像内容不对不会被执行。
      const downloadUrl = (process.env.VIDEO_FFMPEG_URL || '').trim() || `${RELEASE_BASE}/${asset.file}`;
      const response = await fetch(downloadUrl, {
        redirect: 'follow',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)])
          : AbortSignal.timeout(180_000),
        headers: { 'user-agent': 'Engram/ffmpeg-runtime' },
      });
      if (!response.ok || !response.body) {
        throw new Error(`下载失败：HTTP ${response.status}`);
      }
      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0;
      let lastReport = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          const now = Date.now();
          if (options.onProgress && (now - lastReport > 800 || (total > 0 && received >= total))) {
            lastReport = now;
            options.onProgress(
              '准备截图',
              '下载 ffmpeg 运行时 ' + formatMb(received) + (total ? ' / ' + formatMb(total) : '')
            );
          }
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as any), counter, fs.createWriteStream(gzPath), {
        signal: options.signal,
      });
      const actual = sha256File(gzPath);
      if (actual !== asset.sha256) {
        throw new Error('ffmpeg 运行时校验失败');
      }
      await pipeline(
        fs.createReadStream(gzPath),
        createGunzip(),
        fs.createWriteStream(outPath, { mode: 0o755 }),
        { signal: options.signal }
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(outPath, 0o755);
      fs.renameSync(outPath, bin);
      fs.writeFileSync(
        path.join(dir, 'NOTICE.txt'),
        [
          'ffmpeg runtime downloaded by Engram',
          'source: ' + downloadUrl,
          'release: ' + RELEASE_TAG,
          'sha256(gz): ' + asset.sha256,
          'license: GPL-3.0-or-later (ffmpeg-static upstream build)',
          '',
        ].join('\n'),
        'utf8'
      );
      options.onProgress?.('准备截图', 'ffmpeg 运行时已就绪');
      return bin;
    } catch (error: any) {
      options.signal?.throwIfAborted();
      options.onProgress?.(
        '准备截图',
        '截图工具不可用，本次只放封面：' + (error?.message || String(error))
      );
      return null;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败不影响结果 */
      }
    }
  })().finally(() => {
    downloading = null;
  });

  return downloading;
}
