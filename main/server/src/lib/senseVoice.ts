import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import os from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bundledDshBin, bundledDshHome } from '../assistant/config.js';
import {
  AGENT_NODE_MISSING_ERROR,
  agentNodeCandidates,
  isElectronRuntime,
  nativePathForPlainNode,
  pickUsableAgentNode,
  probeNodeVersion,
} from '../assistant/agentNode.js';
import {
  SENSEVOICE_ASSETS,
  SENSEVOICE_MODEL_INT8,
  SENSEVOICE_SOURCES,
  SENSEVOICE_TOKENS,
  SENSEVOICE_TOTAL_BYTES,
  SENSEVOICE_VAD,
  type SenseVoiceAsset,
} from './senseVoiceAssets.js';

/**
 * 本机离线语音识别：SenseVoice Small（sherpa-onnx）。
 *
 * 为什么不用 Windows SAPI：SAPI 的 DictationGrammar 对真实麦克风的长句经常只回几个字
 * （2026-11-23 用户实测：5 秒录音音量 9–15%，多次返回「没有识别到语音」）。随包 dsh
 * 已带 SenseVoice Provider 与 sherpa-onnx 原生运行时，这里复用它：
 *  - 模型缓存目录与 dsh 的语音输入共用（`<数据目录>/dsh/speech-to-text/sensevoice`）；
 *  - 模型文件固定修订 + SHA-256 校验，用户点「下载模型」才联网，不自动下载；
 *  - 推理放在独立 Node 子进程（worker.js）里：原生模块不需要与 Electron ABI 匹配，
 *    云端模型不可用 / 不想配 Key 的用户也能离线转写；
 *  - Windows / Linux（Docker）/ macOS 都可用；SAPI 只保留为兼容兜底。
 *
 * 录音仍然只在请求里存在：worker 通过环回 HTTP 接收 WAV，不落盘、不进日志。
 */

export type SenseVoicePhase = 'ready' | 'missing' | 'preparing' | 'error';

export interface SenseVoiceStatus {
  /** 当前平台有没有 SenseVoice 运行时（原生包 / Node / worker 均可解析） */
  supported: boolean;
  platform: string;
  ready: boolean;
  phase: SenseVoicePhase;
  downloadedBytes: number;
  totalBytes: number;
  /** 正在下载的文件名（非 preparing 时为空） */
  currentFile: string;
  error: string;
  modelRoot: string;
  sources: string[];
  nodeAvailable: boolean;
}

/** 与 dsh 语音输入共用缓存目录 */
const SENSEVOICE_ROOT = path.join(bundledDshHome(), 'speech-to-text', 'sensevoice');
const MODEL_DIR = path.join(SENSEVOICE_ROOT, 'models', 'sensevoice-onnx');
const VAD_DIR = path.join(SENSEVOICE_ROOT, 'models', 'silero');

/** 原生包已验证的平台（与 dsh Provider 一致） */
const SUPPORTED_PLATFORMS = new Set([
  'win32-x64',
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
]);

const INFERENCE_TIMEOUT_MS = 120_000;
const WORKER_START_TIMEOUT_MS = 120_000;
const WORKER_IDLE_MS = 5 * 60_000;
/** 与服务端 SPEECH_MAX_AUDIO_BYTES 一致（6MB WAV） */
const MAX_AUDIO_BYTES = 6 * 1024 * 1024;

function senseVoicePlatform(): string {
  return `${process.platform}-${process.arch}`;
}

function senseVoicePlatformSupported(): boolean {
  return SUPPORTED_PLATFORMS.has(senseVoicePlatform());
}

/** worker 脚本在随包 dsh 依赖里；打包后要从 app.asar.unpacked 走真实路径 */
let workerPathCache: { value: string | null } | null = null;

function resolveWorkerPath(): string | null {
  if (workerPathCache) return workerPathCache.value;
  const dshBin = bundledDshBin();
  if (!dshBin) {
    workerPathCache = { value: null };
    return null;
  }
  try {
    const require = createRequire(dshBin);
    const resolved = require.resolve('@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/worker');
    workerPathCache = { value: nativePathForPlainNode(resolved) };
  } catch {
    workerPathCache = { value: null };
  }
  return workerPathCache.value;
}

/** 真实 Node：Electron 进程不能直接跑 sherpa 原生模块（ABI / V8 内存笼），与 dsh 同一套解析 */
let nodePathCache: { ok: boolean; path: string; error: string } | null = null;

function resolveNodePath(): { ok: boolean; path: string; error: string } {
  if (nodePathCache) return nodePathCache;
  if (!isElectronRuntime()) {
    nodePathCache = { ok: true, path: process.execPath, error: '' };
    return nodePathCache;
  }
  const picked = pickUsableAgentNode(agentNodeCandidates(), probeNodeVersion);
  nodePathCache = picked
    ? { ok: true, path: picked.path, error: '' }
    : { ok: false, path: '', error: AGENT_NODE_MISSING_ERROR };
  return nodePathCache;
}

function runtimePaths(): {
  workerPath: string | null;
  node: { ok: boolean; path: string; error: string };
  workerError: string;
} {
  const workerPath = resolveWorkerPath();
  const node = resolveNodePath();
  let workerError = '';
  if (!senseVoicePlatformSupported()) {
    workerError = `当前平台（${senseVoicePlatform()}）没有随包的 SenseVoice 原生运行时`;
  } else if (!workerPath) {
    workerError = '随包 dsh 里没有找到 SenseVoice worker，请更新/重装 Engram';
  } else if (!node.ok) {
    workerError = node.error;
  }
  return { workerPath, node, workerError };
}

/* ------------------------------------------------------------------ *
 * 模型文件校验与进度
 * ------------------------------------------------------------------ */

/** 相同 size + mtime 的校验结果缓存：打开菜单/轮询状态时不重复算 239MB 的 SHA-256 */
const verifyCache = new Map<string, { stamp: string; ok: boolean }>();

function stampOf(file: string): string {
  try {
    const info = fs.statSync(file);
    return `${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

function assetDir(asset: SenseVoiceAsset): string {
  return asset === SENSEVOICE_VAD ? VAD_DIR : MODEL_DIR;
}

async function matchesAsset(asset: SenseVoiceAsset, signal?: AbortSignal): Promise<{ ok: boolean; bytes: number }> {
  const file = path.join(assetDir(asset), asset.name);
  const stamp = stampOf(file);
  if (stamp === 'missing') return { ok: false, bytes: 0 };
  const bytes = Number(stamp.split(':')[0]) || 0;
  if (bytes !== asset.bytes) return { ok: false, bytes };
  const cached = verifyCache.get(file);
  if (cached?.stamp === stamp) return { ok: cached.ok, bytes };
  signal?.throwIfAborted();
  try {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    const ok = hash.digest('hex') === asset.sha256;
    verifyCache.set(file, { stamp, ok });
    return { ok, bytes };
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    return { ok: false, bytes };
  }
}

interface Inspection {
  ready: boolean;
  corrupt: boolean;
  downloadedBytes: number;
  error: string;
}

async function inspectSenseVoice(): Promise<Inspection> {
  let downloadedBytes = 0;
  let missing = false;
  let corrupt = false;
  for (const asset of SENSEVOICE_ASSETS) {
    const result = await matchesAsset(asset);
    downloadedBytes += Math.min(result.bytes, asset.bytes);
    if (!result.ok) {
      if (result.bytes === 0) missing = true;
      else corrupt = true;
    }
  }
  if (!missing && !corrupt) {
    return { ready: true, corrupt: false, downloadedBytes: SENSEVOICE_TOTAL_BYTES, error: '' };
  }
  return {
    ready: false,
    corrupt,
    downloadedBytes,
    error: corrupt ? '本机识别模型文件校验失败，请重新下载' : '',
  };
}

/* ------------------------------------------------------------------ *
 * 模型下载
 * ------------------------------------------------------------------ */

interface PrepareJob {
  controller: AbortController;
  phase: 'preparing' | 'error';
  downloadedBytes: number;
  currentFile: string;
  error: string;
  startedAt: number;
}

let prepareJob: PrepareJob | null = null;

function sourceUrls(asset: SenseVoiceAsset): string[] {
  const pathname = new URL(asset.url).pathname;
  return SENSEVOICE_SOURCES.map((origin) => new URL(pathname, origin).href);
}

function describeDownloadError(error: any): string {
  const message = String(error?.message || error || '未知错误');
  if (/fetch failed/i.test(message)) return '网络连接失败（检查网络或代理后重试）';
  if (/abort/i.test(message)) return '已取消';
  return message.slice(0, 200);
}

async function downloadAsset(
  asset: SenseVoiceAsset,
  job: PrepareJob,
  completedBefore: number
): Promise<void> {
  const dir = assetDir(asset);
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, asset.name);
  const existing = await matchesAsset(asset, job.controller.signal);
  if (existing.ok) {
    job.downloadedBytes = completedBefore + asset.bytes;
    return;
  }

  let lastError = '';
  for (const url of sourceUrls(asset)) {
    job.controller.signal.throwIfAborted();
    const partial = `${destination}.${randomBytes(4).toString('hex')}.part`;
    try {
      const response = await fetch(url, { signal: job.controller.signal, redirect: 'follow' });
      if (!response.ok || !response.body) {
        lastError = `HTTP ${response.status}`;
        await response.body?.cancel().catch(() => {});
        continue;
      }
      const hash = createHash('sha256');
      let done = 0;
      let reported = -1;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          done += chunk.length;
          if (done > asset.bytes) {
            callback(new Error('下载内容超过预期大小'));
            return;
          }
          hash.update(chunk);
          const percent = Math.floor((done / asset.bytes) * 100);
          if (percent !== reported) {
            reported = percent;
            job.downloadedBytes = completedBefore + done;
            job.currentFile = asset.name;
          }
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as any),
        meter,
        fs.createWriteStream(partial, { flags: 'wx' })
      );
      if (done !== asset.bytes) {
        lastError = `文件大小不符（${done}/${asset.bytes}）`;
        continue;
      }
      if (hash.digest('hex') !== asset.sha256) {
        lastError = 'SHA-256 校验失败';
        continue;
      }
      job.controller.signal.throwIfAborted();
      fs.renameSync(partial, destination);
      verifyCache.delete(destination);
      job.downloadedBytes = completedBefore + asset.bytes;
      return;
    } catch (error: any) {
      if (job.controller.signal.aborted) throw error;
      lastError = describeDownloadError(error);
      console.warn(`[speech] SenseVoice 下载失败（${new URL(url).origin} / ${asset.name}）：${lastError}`);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  }
  throw new Error(`下载 ${asset.name} 失败：${lastError || '所有下载源都不可用'}`);
}

async function runPrepare(job: PrepareJob): Promise<void> {
  try {
    // 上次进程崩溃可能留下 .part；重试前清掉，避免磁盘里越积越多
    for (const dir of [MODEL_DIR, VAD_DIR]) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith('.part')) fs.rmSync(path.join(dir, name), { force: true });
        }
      } catch {
        /* 目录还不存在 */
      }
    }
    let completed = 0;
    for (const asset of SENSEVOICE_ASSETS) {
      job.currentFile = asset.name;
      job.downloadedBytes = completed;
      await downloadAsset(asset, job, completed);
      completed += asset.bytes;
      job.downloadedBytes = completed;
    }
    const inspection = await inspectSenseVoice();
    if (!inspection.ready) throw new Error(inspection.error || '模型文件校验失败');
    prepareJob = null;
    console.info('[speech] SenseVoice 本机识别模型已就绪');
  } catch (error: any) {
    if (job.controller.signal.aborted) {
      prepareJob = null;
      return;
    }
    job.phase = 'error';
    job.error = describeDownloadError(error);
    console.warn('[speech] SenseVoice 模型准备失败：', job.error);
  }
}

/** 开始下载（幂等）：立即返回当前状态，进度由 status 轮询 */
export async function startSenseVoicePrepare(): Promise<SenseVoiceStatus> {
  const runtime = runtimePaths();
  if (!senseVoicePlatformSupported() || !runtime.workerPath || !runtime.node.ok) {
    throw new Error(runtime.workerError || '本机识别运行时不可用，无法准备模型');
  }
  if (!prepareJob || prepareJob.phase === 'error') {
    const controller = new AbortController();
    const job: PrepareJob = {
      controller,
      phase: 'preparing',
      downloadedBytes: 0,
      currentFile: '',
      error: '',
      startedAt: Date.now(),
    };
    prepareJob = job;
    void runPrepare(job);
  }
  return senseVoiceStatus();
}

export function cancelSenseVoicePrepare(): void {
  const job = prepareJob;
  if (!job) return;
  job.controller.abort();
  if (job.phase === 'error') prepareJob = null;
}

export async function senseVoiceStatus(): Promise<SenseVoiceStatus> {
  const platform = senseVoicePlatform();
  const runtime = runtimePaths();
  const supported = senseVoicePlatformSupported() && Boolean(runtime.workerPath) && runtime.node.ok;
  const base = {
    supported,
    platform,
    totalBytes: SENSEVOICE_TOTAL_BYTES,
    modelRoot: SENSEVOICE_ROOT,
    sources: [...SENSEVOICE_SOURCES],
    nodeAvailable: runtime.node.ok,
  };
  if (prepareJob?.phase === 'preparing') {
    return {
      ...base,
      ready: false,
      phase: 'preparing',
      downloadedBytes: Math.min(prepareJob.downloadedBytes, SENSEVOICE_TOTAL_BYTES),
      currentFile: prepareJob.currentFile,
      error: '',
    };
  }
  const inspection = await inspectSenseVoice();
  const failed = inspection.corrupt || Boolean(prepareJob?.error);
  return {
    ...base,
    ready: inspection.ready,
    phase: inspection.ready ? 'ready' : failed ? 'error' : 'missing',
    downloadedBytes: inspection.downloadedBytes,
    currentFile: '',
    error: inspection.error || prepareJob?.error || runtime.workerError,
  };
}

/* ------------------------------------------------------------------ *
 * Worker 进程与转写
 * ------------------------------------------------------------------ */

interface WorkerHandle {
  child: ChildProcess;
  port: number;
  token: string;
  timer: NodeJS.Timeout | null;
}

let worker: WorkerHandle | null = null;
let workerStarting: Promise<WorkerHandle> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function workerConfig() {
  return {
    dataRoot: SENSEVOICE_ROOT,
    model: path.join(MODEL_DIR, SENSEVOICE_MODEL_INT8.name),
    tokens: path.join(MODEL_DIR, SENSEVOICE_TOKENS.name),
    vad: path.join(VAD_DIR, SENSEVOICE_VAD.name),
    threads: Math.max(1, Math.min(4, os.cpus().length - 1)),
    maxAudioBytes: MAX_AUDIO_BYTES,
    segmentSeconds: 30,
  };
}

function touch(handle: WorkerHandle): void {
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = setTimeout(() => {
    if (worker === handle) stopSenseVoiceWorker();
  }, WORKER_IDLE_MS);
  handle.timer.unref?.();
}

async function startWorker(): Promise<WorkerHandle> {
  const inspection = await inspectSenseVoice();
  if (!inspection.ready) {
    throw new Error(inspection.error || '本机识别模型还没下载：请在语音输入菜单里点「下载模型」');
  }
  const runtime = runtimePaths();
  if (!runtime.workerPath || !runtime.node.ok) {
    throw new Error(runtime.workerError || '本机识别运行时不可用');
  }
  const token = randomBytes(32).toString('hex');
  const child = spawn(runtime.node.path, [runtime.workerPath, JSON.stringify(workerConfig())], {
    env: { ...process.env, DSH_SPEECH_TOKEN: token },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      reject(new Error('SenseVoice 启动超时'));
    }, WORKER_START_TIMEOUT_MS);
    const onData = (chunk: unknown) => {
      stdout += String(chunk);
      const line = stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find((item) => /^\{"port":\d+\}$/.test(item));
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        resolve(Number(parsed.port));
      } catch {
        /* 半行继续等 */
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `SenseVoice 进程启动失败（退出码 ${code ?? 'unknown'}）${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}`
        )
      );
    });
  });
  const handle: WorkerHandle = { child, port, token, timer: null };
  child.once('exit', () => {
    if (worker === handle) worker = null;
  });
  touch(handle);
  console.info(`[speech] SenseVoice worker 已就绪（端口 ${port}）`);
  return handle;
}

async function getWorker(): Promise<WorkerHandle> {
  if (worker) return worker;
  if (workerStarting) return workerStarting;
  workerStarting = startWorker()
    .then((handle) => {
      worker = handle;
      return handle;
    })
    .finally(() => {
      workerStarting = null;
    });
  return workerStarting;
}

/** 空闲 / 出错 / 服务退出时释放模型内存；下次请求会自动重启 */
export function stopSenseVoiceWorker(): void {
  const handle = worker;
  worker = null;
  if (!handle) return;
  if (handle.timer) clearTimeout(handle.timer);
  try {
    handle.child.kill();
  } catch {
    /* 已退出 */
  }
}

// 服务退出时别把 worker 留成孤儿进程（空闲计时器是兜底，但进程可能先退出）
process.once('exit', stopSenseVoiceWorker);

/** 用 SenseVoice 转写一段 16k 单声道 PCM16 WAV（调用方已做格式/时长校验） */
export async function transcribeSenseVoice(wav: Buffer): Promise<{ text: string }> {
  const task = queue.then(async () => {
    const handle = await getWorker();
    touch(handle);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
    try {
      const response = await fetch(
        `http://127.0.0.1:${handle.port}/transcribe?language=auto`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${handle.token}`,
            'content-type': 'application/octet-stream',
            'content-length': String(wav.byteLength),
          },
          body: wav,
          signal: controller.signal,
        }
      );
      const raw = await response.text();
      if (!response.ok) {
        let detail = raw;
        try {
          detail = JSON.parse(raw)?.error || raw;
        } catch {
          /* 原始报文 */
        }
        // 4xx 是输入问题（WAV 不合法），worker 仍可复用；5xx 回收进程，下次重启
        if (response.status >= 500) stopSenseVoiceWorker();
        throw new Error(`本机识别失败：${String(detail).slice(0, 200)}`);
      }
      const parsed = JSON.parse(raw);
      const text = String(parsed?.text || '')
        .replace(/<\|[^|]*\|>/g, '')
        .replace(/\r\n?/g, '\n')
        .trim();
      return { text };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        stopSenseVoiceWorker();
        throw new Error('本机识别超时了，请缩短录音后重试');
      }
      // 环回连接失败通常意味着 worker 已退出：下一次重新拉起
      if (/fetch failed|ECONNREFUSED|socket hang up/i.test(String(error?.message || ''))) stopSenseVoiceWorker();
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  });
  queue = task.catch(() => {});
  return task;
}
