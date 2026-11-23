import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from '../config.js';
import {
  PYTHON_RUNTIME_VERSION,
  pythonRuntimeAssetFor,
  pythonRuntimeUrl,
  type PythonRuntimeAsset,
} from './pythonRuntimeAssets.js';

/**
 * Engram 共享 Python 运行时（随用随下，全部接入共用一份）。
 *
 * 现状：只有「办公本接入」（讯飞 doxent）的官方客户端是 Python 脚本，但它不是唯一可能的
 * 使用者——以后任何 Python 技能 / CLI 都应复用这里的解释器，而不是各自再要求用户装 Python。
 *
 * 设计：
 *  - **不碰系统环境**：解压在 `<数据目录>/runtime/python/<版本>/`，不进注册表、不改系统 PATH，
 *    卸载 / 迁移数据目录时一起走；同一台机器只下载一次（模型与 Node 运行时各自独立）。
 *  - **身份即安全边界**：固定 python-build-standalone 修订、字节数与 SHA-256，下载后校验再解压；
 *    解压后实际跑一次 `--version` 确认能启动，才算 ready。
 *  - **先系统、后托管？** 反过来：显式 DOXENT_PYTHON 最优先，其次是这份托管运行时（版本固定、
 *    行为可预期），系统 Python 只作为没下载时的兜底。
 *  - **Docker 不重复下载**：运行镜像已内置 python3（见 Dockerfile），系统解释器直接可用。
 *  - **后台任务 + 轮询**：约 21MB 的下载不能在设置页请求里硬等；进度由 GET 状态轮询。
 */

export type PythonRuntimePhase = 'ready' | 'missing' | 'downloading' | 'installing' | 'error' | 'unsupported';

export interface PythonRuntimeStatus {
  /** 当前平台有没有固定资产（Docker/桌面端支持的组合见 pythonRuntimeAssets.ts） */
  supported: boolean;
  /** `${process.platform}-${process.arch}` */
  platform: string;
  /** 目标版本（清单里的固定版本） */
  version: string;
  ready: boolean;
  phase: PythonRuntimePhase;
  /** 已下载字节（仅 downloading 阶段有意义） */
  downloadedBytes: number;
  /** 压缩包总字节（界面显示「约 xxMB」） */
  totalBytes: number;
  /** 托管运行时的安装根目录（未安装时也给出，便于排障） */
  root: string;
  /** ready / error 时的解释器绝对路径 */
  interpreter?: string;
  error: string;
}

export interface PythonRuntimeProbe {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface PythonRuntimeOptions {
  /** 注入运行时根目录（测试；默认 <DATA_DIR>/runtime/python） */
  root?: string;
  /** 注入平台标识（测试；默认 process.platform-process.arch） */
  platform?: string;
  /** 注入固定资产（测试 / 离线内置包；默认按平台从清单取） */
  asset?: PythonRuntimeAsset;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** 注入解释器探测（测试：CI 上不能运行下载来的跨平台二进制） */
  probe?: (interpreter: string) => Promise<PythonRuntimeProbe>;
  /** 安装完成后的回调（路由用它回收 Agent 运行时，让新 PATH 生效） */
  onInstalled?: () => void;
}

/** Python 官方客户端的最低要求（官方 meta.json：3.8+） */
export const PYTHON_MIN_MAJOR = 3;
export const PYTHON_MIN_MINOR = 8;

const PROBE_TIMEOUT_MS = 15_000;
/** 解压上限：防止损坏/恶意压缩包把磁盘写满（install_only 实际约 100–200MB） */
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

export function pythonRuntimePlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** 默认安装根目录：<数据目录>/runtime/python（随数据卷/用户数据目录持久化） */
export function pythonRuntimeBase(root?: string): string {
  return root ?? path.join(DATA_DIR, 'runtime', 'python');
}

/** 版本目录：只用清单里的固定版本，升级时自然换目录、旧目录由安装收尾清理 */
export function pythonRuntimeRoot(options: PythonRuntimeOptions = {}): string {
  return path.join(pythonRuntimeBase(options.root), PYTHON_RUNTIME_VERSION);
}

/** 解释器相对布局（python-build-standalone 的 install_only 顶层固定为 python/） */
function interpreterRelative(platform: string): string {
  return platform.startsWith('win32') ? path.join('python', 'python.exe') : path.join('python', 'bin', 'python3');
}

export function pythonRuntimeInterpreter(options: PythonRuntimeOptions = {}): string {
  return path.join(pythonRuntimeRoot(options), interpreterRelative(options.platform ?? pythonRuntimePlatform()));
}

/** 托管解释器（同步判断文件在不在）：doxent 探测 / Agent PATH 注入用，不启动进程 */
export function managedPythonInterpreter(options: PythonRuntimeOptions = {}): string | null {
  const platform = options.platform ?? pythonRuntimePlatform();
  const interpreter = pythonRuntimeInterpreter({ ...options, platform });
  try {
    return fs.statSync(interpreter).isFile() ? interpreter : null;
  } catch {
    return null;
  }
}

/** 把托管运行时目录放到 PATH 最前面；未安装时原样返回（系统 Python / Docker 内置 python3 兜底） */
export function withManagedPythonEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: PythonRuntimeOptions = {},
): NodeJS.ProcessEnv {
  const interpreter = managedPythonInterpreter(options);
  if (!interpreter) return env;
  const dir = path.dirname(interpreter);
  const next: NodeJS.ProcessEnv = { ...env };
  // Windows 的 env 键名大小写不敏感：先取值再删别名，避免同一变量两份拼写
  const current = next.PATH || next.Path || '';
  delete next.Path;
  next.PATH = current ? dir + path.delimiter + current : dir;
  // 官方客户端按 UTF-8 输出中文；Agent 里其他 Python 脚本同样受益
  if (!next.PYTHONIOENCODING) next.PYTHONIOENCODING = 'utf-8';
  if (!next.PYTHONUTF8) next.PYTHONUTF8 = '1';
  return next;
}

/* ------------------------------------------------------------------ *
 * 解释器探测
 * ------------------------------------------------------------------ */

interface ProbeCache {
  key: string;
  value: PythonRuntimeProbe;
}

let probeCache: ProbeCache | null = null;

function fileStamp(file: string): string {
  try {
    const info = fs.statSync(file);
    return `${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

/** 跑一次 `python --version` 并解析版本号（只接受 3.8+，否则报版本过低） */
export function defaultPythonProbe(interpreter: string): Promise<PythonRuntimeProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PythonRuntimeProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(interpreter, ['-E', '-s', '--version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, error: 'Python 运行时启动超时' });
    }, PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ ok: false, error: `Python 运行时无法启动：${error.message}` }));
    child.on('close', (code) => {
      const text = (stdout + '\n' + stderr).trim();
      const match = /Python (\d+)\.(\d+)\.(\d+)/.exec(text);
      if (code !== 0 || !match) {
        finish({ ok: false, error: `Python 运行时无法启动（退出码 ${code ?? 'unknown'}）${text ? '：' + text.slice(0, 200) : ''}` });
        return;
      }
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major < PYTHON_MIN_MAJOR || (major === PYTHON_MIN_MAJOR && minor < PYTHON_MIN_MINOR)) {
        finish({ ok: false, error: `Python ${major}.${minor} 版本过低（需要 3.8+）` });
        return;
      }
      finish({ ok: true, version: `${major}.${minor}.${match[3]}` });
    });
  });
}

async function inspectRuntime(
  options: PythonRuntimeOptions,
): Promise<{ ready: boolean; version?: string; error: string }> {
  const platform = options.platform ?? pythonRuntimePlatform();
  const interpreter = pythonRuntimeInterpreter({ ...options, platform });
  const stamp = fileStamp(interpreter);
  if (stamp === 'missing') return { ready: false, error: '' };
  const key = `${platform}|${interpreter}|${stamp}`;
  if (probeCache?.key === key) {
    return probeCache.value.ok
      ? { ready: true, version: probeCache.value.version, error: '' }
      : { ready: false, error: probeCache.value.error || 'Python 运行时不可用，请重新下载' };
  }
  const probe = options.probe ?? defaultPythonProbe;
  const value = await probe(interpreter);
  probeCache = { key, value };
  return value.ok
    ? { ready: true, version: value.version, error: '' }
    : { ready: false, error: value.error || 'Python 运行时不可用，请重新下载' };
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

interface InstallJob {
  controller: AbortController;
  root: string;
  phase: 'downloading' | 'installing' | 'error';
  downloadedBytes: number;
  error: string;
  startedAt: number;
  onInstalled?: () => void;
}

let installJob: InstallJob | null = null;

/** 清掉探测与任务缓存（测试；重新下载前也用它） */
export function resetPythonRuntimeCaches(): void {
  probeCache = null;
}

function jobFor(root: string): InstallJob | null {
  return installJob && installJob.root === root ? installJob : null;
}

export async function pythonRuntimeStatus(options: PythonRuntimeOptions = {}): Promise<PythonRuntimeStatus> {
  const platform = options.platform ?? pythonRuntimePlatform();
  const root = pythonRuntimeRoot(options);
  const asset = options.asset ?? pythonRuntimeAssetFor(platform);
  const base = {
    supported: Boolean(asset),
    platform,
    version: PYTHON_RUNTIME_VERSION,
    root,
  };
  if (!asset) {
    return {
      ...base,
      ready: false,
      phase: 'unsupported',
      downloadedBytes: 0,
      totalBytes: 0,
      error: '当前平台没有随包 Python 运行时（Docker 镜像已内置 python3，无需下载）',
    };
  }
  const job = jobFor(root);
  if (job?.phase === 'downloading') {
    return {
      ...base,
      ready: false,
      phase: 'downloading',
      downloadedBytes: Math.min(job.downloadedBytes, asset.bytes),
      totalBytes: asset.bytes,
      error: '',
    };
  }
  if (job?.phase === 'installing') {
    return {
      ...base,
      ready: false,
      phase: 'installing',
      downloadedBytes: asset.bytes,
      totalBytes: asset.bytes,
      error: '',
    };
  }
  const inspected = await inspectRuntime(options);
  if (inspected.ready) {
    return {
      ...base,
      // 以实际启动成功的解释器版本为准（镜像/离线包可能换成同一版本线的其他补丁号）
      version: inspected.version || PYTHON_RUNTIME_VERSION,
      ready: true,
      phase: 'ready',
      downloadedBytes: asset.bytes,
      totalBytes: asset.bytes,
      interpreter: pythonRuntimeInterpreter({ ...options, platform }),
      error: '',
    };
  }
  return {
    ...base,
    ready: false,
    phase: job?.phase === 'error' || inspected.error ? 'error' : 'missing',
    downloadedBytes: 0,
    totalBytes: asset.bytes,
    ...(inspected.error ? { interpreter: pythonRuntimeInterpreter({ ...options, platform }) } : {}),
    error: job?.error || inspected.error,
  };
}

/* ------------------------------------------------------------------ *
 * 下载 / 解压 / 安装
 * ------------------------------------------------------------------ */

function downloadUrls(asset: PythonRuntimeAsset, env: NodeJS.ProcessEnv): string[] {
  const primary = pythonRuntimeUrl(asset.platform, env) || asset.url;
  return primary === asset.url ? [primary] : [primary, asset.url];
}

function describeDownloadError(error: any): string {
  const message = String(error?.message || error || '未知错误');
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(message)) return '网络连接失败（检查网络或代理后重试）';
  if (/abort/i.test(message)) return '已取消';
  return message.slice(0, 200);
}

async function downloadArchive(
  asset: PythonRuntimeAsset,
  job: InstallJob,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  let lastError = '';
  for (const url of downloadUrls(asset, env)) {
    job.controller.signal.throwIfAborted();
    try {
      const response = await fetchImpl(url, { signal: job.controller.signal, redirect: 'follow' });
      if (!response.ok || !response.body) {
        lastError = `HTTP ${response.status}`;
        await response.body?.cancel().catch(() => {});
        continue;
      }
      const chunks: Buffer[] = [];
      let done = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          const chunk = Buffer.from(value);
          done += chunk.length;
          if (done > asset.bytes) throw new Error('下载内容超过预期大小');
          chunks.push(chunk);
          job.downloadedBytes = done;
        }
      } finally {
        reader.releaseLock();
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length !== asset.bytes) {
        lastError = `文件大小不符（${buffer.length}/${asset.bytes}）`;
        continue;
      }
      if (createHash('sha256').update(buffer).digest('hex') !== asset.sha256) {
        lastError = 'SHA-256 校验失败';
        continue;
      }
      return buffer;
    } catch (error: any) {
      if (job.controller.signal.aborted) throw error;
      lastError = describeDownloadError(error);
      console.warn(`[python] 运行时下载失败（${new URL(url).origin}）：${lastError}`);
    }
  }
  throw new Error(`下载 Python 运行时失败：${lastError || '所有下载源都不可用'}`);
}

/** tar 路径安全检查：不允许绝对路径与 ..（防止解压穿越） */
function safeTarPath(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  return normalized.split('/').every((segment) => segment !== '..');
}

function cString(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  return buffer.toString('utf8', offset, end === -1 || end > offset + length ? offset + length : end);
}

/** 解析 pax 扩展头：`<长度> <key>=<value>\n` 重复 */
function parsePax(body: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(body.toString('ascii', offset, space));
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.toString('utf8', space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq > 0) values[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return values;
}

/**
 * 解压 tar.gz（只处理 python-build-standalone 用到的条目类型：普通文件 / 目录 / 符号链接 / 硬链接）。
 * 用内存缓冲而不是流式解析：安装是一次性动作，换来更直观的边界检查与更少的半成品状态。
 */
export function extractTarGz(archive: Buffer, destination: string): void {
  const inflated = zlib.gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  let offset = 0;
  let pax: Record<string, string> = {};
  let longName = '';
  let longLink = '';
  while (offset + 512 <= inflated.length) {
    const header = inflated.subarray(offset, offset + 512);
    // 结尾是两个全零块
    if (header.every((byte) => byte === 0)) break;
    const headerName = cString(header, 0, 100);
    const size = Number.parseInt(cString(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const linkname = cString(header, 157, 100);
    const prefix = cString(header, 345, 155);
    const mode = Number.parseInt(cString(header, 100, 8).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('tar 头损坏：文件大小非法');
    offset += 512;
    if (offset + size > inflated.length) throw new Error('tar 头损坏：文件内容被截断');
    const body = inflated.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === 'x') {
      pax = { ...pax, ...parsePax(body) };
      continue;
    }
    if (type === 'g') continue; // 全局扩展头对安装无意义
    if (type === 'L') {
      longName = cString(body, 0, body.length);
      continue;
    }
    if (type === 'K') {
      longLink = cString(body, 0, body.length);
      continue;
    }
    const name = (pax.path || longName || (prefix ? prefix + '/' + headerName : headerName)).replace(/\\/g, '/');
    const linkTarget = pax.linkpath || longLink || linkname;
    const target = path.resolve(root, name);
    pax = {};
    longName = '';
    longLink = '';
    if (!name || !safeTarPath(name) || !(target === root || target.startsWith(root + path.sep))) {
      throw new Error(`tar 条目路径不安全：${name || '(空)'}`);
    }
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (type === '2') {
      const link = linkTarget;
      const resolved = path.resolve(path.dirname(target), link);
      if (!(resolved === root || resolved.startsWith(root + path.sep))) {
        throw new Error(`tar 符号链接指向安装目录之外：${link}`);
      }
      fs.rmSync(target, { force: true });
      fs.symlinkSync(link, target);
      continue;
    }
    if (type === '1') {
      const link = path.resolve(root, linkTarget);
      if (!(link === root || link.startsWith(root + path.sep))) {
        throw new Error(`tar 硬链接指向安装目录之外：${link}`);
      }
      fs.rmSync(target, { force: true });
      fs.linkSync(link, target);
      continue;
    }
    if (type !== '0' && type !== '\u0000' && type !== '') {
      // 字符/块设备等条目不会出现在 Python 发行包；跳过比中断安全
      continue;
    }
    fs.writeFileSync(target, body);
    if (mode) {
      try {
        fs.chmodSync(target, mode & 0o777);
      } catch {
        /* Windows 不支持可执行位 */
      }
    }
  }
}

/** Windows 上补一个 python3.exe 别名：技能里 `python3 ...` 的写法也能直接跑 */
function ensureWindowsAliases(root: string): void {
  const dir = path.join(root, 'python');
  const exe = path.join(dir, 'python.exe');
  for (const alias of ['python3.exe']) {
    const target = path.join(dir, alias);
    if (fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(exe, target);
    } catch {
      /* 复制失败不影响 python.exe 本身可用 */
    }
  }
}

function removeStaleVersions(base: string, keep: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/^\d+\.\d+\.\d+$/.test(name) || name === keep) continue;
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
    } catch {
      /* 被占用就下次再清 */
    }
  }
}

/**
 * 目录换入。Windows 上刚被探测进程 / 杀毒软件扫过的文件会短暂占用目录，
 * rename 可能返回 EPERM/EBUSY；短暂重试即可，不能把一次瞬时占用当成安装失败。
 */
async function renameWithRetry(from: string, to: string, attempts = 20): Promise<void> {
  let lastError: any;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error: any) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(String(error?.code))) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}

/** 删旧目录同理：杀毒/索引服务短暂占用时重试，避免「重装运行时」永久失败 */
async function rmWithRetry(target: string, attempts = 10): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(String(error?.code)) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

async function runInstall(job: InstallJob, options: PythonRuntimeOptions, asset: PythonRuntimeAsset): Promise<void> {
  const platform = options.platform ?? pythonRuntimePlatform();
  const env = options.env ?? process.env;
  const probe = options.probe ?? defaultPythonProbe;
  const base = pythonRuntimeBase(options.root);
  const target = pythonRuntimeRoot(options);
  const staging = path.join(base, `.stage-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(base, { recursive: true });
    // 上次进程崩溃残留的 .stage-*：重试前清掉，避免数据目录里越积越多
    try {
      for (const name of fs.readdirSync(base)) {
        if (name.startsWith('.stage-')) fs.rmSync(path.join(base, name), { recursive: true, force: true });
      }
    } catch {
      /* 目录刚建好 / 权限受限：后续步骤会给出真实错误 */
    }
    fs.rmSync(staging, { recursive: true, force: true });
    const archive = await downloadArchive(asset, job, options.fetchImpl ?? fetch, env);
    job.controller.signal.throwIfAborted();
    job.phase = 'installing';
    extractTarGz(archive, staging);
    if (platform.startsWith('win32')) ensureWindowsAliases(staging);
    const interpreter = path.join(staging, interpreterRelative(platform));
    const verified = await probe(interpreter);
    if (!verified.ok) throw new Error(verified.error || 'Python 运行时校验失败');
    job.controller.signal.throwIfAborted();
    fs.writeFileSync(
      path.join(staging, '.engram-python.json'),
      JSON.stringify(
        { name: 'python', version: PYTHON_RUNTIME_VERSION, platform, source: asset.url, sha256: asset.sha256, installedAt: new Date().toISOString() },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    await rmWithRetry(target);
    await renameWithRetry(staging, target);
    removeStaleVersions(base, PYTHON_RUNTIME_VERSION);
    resetPythonRuntimeCaches();
    installJob = null;
    console.info(`[python] 共享运行时已就绪：${target}（Python ${verified.version || PYTHON_RUNTIME_VERSION}）`);
    try {
      job.onInstalled?.();
    } catch (error) {
      console.warn('[python] 安装完成回调失败（下次启动仍会生效）', error);
    }
  } catch (error: any) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (job.controller.signal.aborted) {
      if (installJob === job) installJob = null;
      return;
    }
    job.phase = 'error';
    job.error = describeDownloadError(error);
    if (installJob === job) installJob = job;
    console.warn('[python] 运行时安装失败：', job.error);
  }
}

/** 开始下载安装（幂等）：立即返回当前状态，进度由 pythonRuntimeStatus 轮询 */
export async function startPythonRuntimeInstall(
  options: PythonRuntimeOptions = {},
): Promise<PythonRuntimeStatus> {
  const platform = options.platform ?? pythonRuntimePlatform();
  const asset = options.asset ?? pythonRuntimeAssetFor(platform);
  if (!asset) throw new Error('当前平台没有可下载的 Python 运行时');
  const root = pythonRuntimeRoot(options);
  if (installJob && installJob.root === root && installJob.phase !== 'error') return pythonRuntimeStatus(options);
  const current = await pythonRuntimeStatus({ ...options, platform });
  if (current.ready) return current;
  const job: InstallJob = {
    controller: new AbortController(),
    root,
    phase: 'downloading',
    downloadedBytes: 0,
    error: '',
    startedAt: Date.now(),
    onInstalled: options.onInstalled,
  };
  installJob = job;
  resetPythonRuntimeCaches();
  void runInstall(job, { ...options, platform }, asset);
  return pythonRuntimeStatus({ ...options, platform });
}

/** 取消下载 / 解压；已失败的记录也一并清掉，便于重试 */
export async function cancelPythonRuntimeInstall(
  options: PythonRuntimeOptions = {},
): Promise<PythonRuntimeStatus> {
  const job = installJob;
  if (job) {
    job.controller.abort();
    installJob = null;
  }
  return pythonRuntimeStatus(options);
}
