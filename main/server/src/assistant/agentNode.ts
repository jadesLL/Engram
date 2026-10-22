import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 内置 Agent（dsh）的 Node 运行时解析——桌面端的关键路径。
 *
 * 背景（2026-10-22 桌面端实测）：内嵌 server 在桌面端跑在 Electron 的纯 Node 模式里
 * （ELECTRON_RUN_AS_NODE=1，process.execPath 是 Engram.exe）。dsh 启动时要用
 * node-addon-require-builtin 探测 V8 内部结构（internal/modules/esm/loader 等），
 * 它只认 Electron 43/44/44.7/45 的 V8 指纹；Electron 36 直接被拒：
 *
 *   dsh: host preparation failed: node-addon-require-builtin unsupported:
 *   Unsupported/no-context (unsupported Electron runtime fingerprint: Node 22.19.0,
 *   V8 13.6.233.17-electron.0 (supported Electron versions: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6))
 *
 * 于是「内置 Agent 控制台」进程 code 1 提前退出，聊天运行时同理。Docker 里 server 本身就是
 * 真实 Node，不受影响。结论：桌面端必须用**真实 Node.js（>=20）**拉 dsh。
 *
 * 真实 Node 从哪儿来：
 *  - 安装包形态：desktop/package.json 的 extraResources 带上 resources/node/node.exe，
 *    desktop 主进程把路径经 ENGRAM_NODE_BIN 传给 server；
 *  - 源码模式：系统 Node（PATH）或 install-engram.ps1 的便携 Node（%LOCALAPPDATA%\engram\node）。
 *
 * 解析到之后把 process.execPath 覆盖成真实 Node：控制台直接 spawn(process.execPath, ...)，
 * 聊天运行时走官方 SDK 而 SDK 把命令硬编码成 process.execPath（@deepseek-ai/dsh-sdk-client
 * 的 resolveDshLaunch，没有注入点），两处因此都拿到真实 Node，行为与 Docker 一致。
 * process.execPath 在 Electron 36 的纯 Node 模式里是可写属性（desktop 端 2026-10-22 实测）。
 *
 * 打包后 dsh 在 app.asar 里，真实 Node 读不了 asar：desktop 打包把 server/** 解包到
 * app.asar.unpacked（desktop/package.json 的 asarUnpack），所以 dsh 入口要用 nativePathForPlainNode()
 * 换成真实路径再交给 Node。
 */

/** dsh 官方要求 Node >= 20（@deepseek-ai/dsh 的 engines） */
export const MIN_NODE_MAJOR = 20;

/** 便携 Node 相对 %LOCALAPPDATA% 的路径（install-engram.ps1 的默认安装根，与 desktop 侧同一份约定） */
export const PORTABLE_NODE_REL = ['engram', 'node', 'node.exe'];

/** Node 可执行文件的来源，只用于状态展示与排查 */
export type AgentNodeSource = 'process' | 'env' | 'bundled' | 'portable' | 'path' | 'none';

export interface AgentNodeStatus {
  ok: boolean;
  /** 实际用于拉起 dsh 的 Node 可执行文件；失败时为空串 */
  path: string;
  source: AgentNodeSource;
  /** 真实 Node 的版本号（形如 22.20.0）；失败时为空串 */
  version: string;
  /** 失败原因（给设置页/日志的人话） */
  error: string;
}

interface NodeCandidate {
  path: string;
  source: Exclude<AgentNodeSource, 'process' | 'none'>;
}

export interface AgentNodeOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  platform?: NodeJS.Platform;
  /** Electron 的 process.resourcesPath（安装包含 resources/node/node.exe） */
  resourcesPath?: string;
  /** 进程自带的 versions（默认 process.versions） */
  processVersions?: NodeJS.ProcessVersions;
  /** 进程自身可执行文件（Electron 模式下不能当 Node 用） */
  execPath?: string;
  /** 探测候选版本的函数（单测注入；默认真跑 `node -p process.versions.node`） */
  probe?: (file: string) => string | null;
  /** 把 process.execPath 指向真实 Node 的方式（单测注入；默认 defineProperty 覆盖） */
  applyExecPath?: (file: string) => void;
}

function nodeBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/** 解析 Node 版本输出（容忍 v 前缀与多余空白）；解析不到返回 null */
export function parseNodeVersion(output: string | null | undefined): string | null {
  const match = /v?(\d+\.\d+\.\d+)/.exec((output || '').trim());
  return match ? match[1] : null;
}

/** Node 主版本号（非法版本按 0 处理，必然低于门槛） */
export function nodeMajor(version: string): number {
  return Number((version || '').split('.')[0]) || 0;
}

/** 是否为 Electron 运行时：ELECTRON_RUN_AS_NODE 纯 Node 模式下 process.versions.electron 依然存在 */
export function isElectronRuntime(versions: NodeJS.ProcessVersions = process.versions): boolean {
  const electron = (versions as unknown as Record<string, string | undefined>).electron;
  return typeof electron === 'string' && electron !== '';
}

/** 默认版本探测：真跑一次 Node（一次约几十毫秒，只在首次使用内置 Agent 时发生） */
export function probeNodeVersion(file: string): string | null {
  try {
    const output = execFileSync(file, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return parseNodeVersion(output);
  } catch {
    return null;
  }
}

/**
 * 候选 Node 可执行文件（按优先级，去重、去不存在、去进程自身）。
 *
 * 1. ENGRAM_NODE_BIN：desktop 主进程显式传入（安装包 resources/node 或它解析出的便携/系统 Node）；
 * 2. 安装包随包：<resourcesPath>/node/node.exe；
 * 3. 源码模式便携 Node：%LOCALAPPDATA%\engram\node\node.exe（install-engram.ps1 装的）；
 * 4. PATH 里的 node（源码模式机器通常有；桌面安装包也会命中用户自己装的 Node）。
 */
export function agentNodeCandidates(options: AgentNodeOptions = {}): NodeCandidate[] {
  const env = options.env ?? process.env;
  const exists = options.exists ?? fs.existsSync;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const binary = nodeBinaryName(platform);
  const seen = new Set<string>();
  const out: NodeCandidate[] = [];
  const push = (file: string | undefined, source: NodeCandidate['source']): void => {
    if (!file) return;
    const normalized = path.resolve(file);
    if (seen.has(normalized)) return;
    if (execPath && path.resolve(execPath) === normalized) return; // 进程自身（Electron）不能当 Node
    try {
      if (!exists(normalized)) return;
    } catch {
      return;
    }
    seen.add(normalized);
    out.push({ path: normalized, source });
  };

  push(env.ENGRAM_NODE_BIN, 'env');
  if (options.resourcesPath) push(path.join(options.resourcesPath, 'node', binary), 'bundled');
  const localAppData = env.LOCALAPPDATA || env.LocalAppData;
  if (localAppData) push(path.join(localAppData, ...PORTABLE_NODE_REL), 'portable');
  const pathValue = env.PATH || env.Path || '';
  for (const raw of pathValue.split(path.delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    push(path.join(dir, binary), 'path');
  }
  return out;
}

/**
 * 把 app.asar 里的路径换成真实文件路径（app.asar.unpacked）。
 * 非 asar 路径（源码模式 / Docker）原样返回；映射目标不存在也原样返回，交给上层报错。
 */
export function nativePathForPlainNode(file: string, exists: (p: string) => boolean = fs.existsSync): string {
  if (!file) return file;
  const marker = /([\\/])app\.asar([\\/])/;
  if (!marker.test(file)) return file;
  const candidate = file.replace(marker, '$1app.asar.unpacked$2');
  try {
    return exists(candidate) ? candidate : file;
  } catch {
    return file;
  }
}

/** 在候选里挑第一个「能跑且版本 >= 20」的 Node（探测函数可注入，便于单测） */
export function pickUsableAgentNode(
  candidates: NodeCandidate[],
  probe: (file: string) => string | null,
): { path: string; source: NodeCandidate['source']; version: string } | null {
  for (const candidate of candidates) {
    const version = probe(candidate.path);
    if (version && nodeMajor(version) >= MIN_NODE_MAJOR) {
      return { path: candidate.path, source: candidate.source, version };
    }
  }
  return null;
}

/** 失败时给用户看的说明（设置页控制台状态会直接显示） */
export const AGENT_NODE_MISSING_ERROR =
  '未找到可运行内置 Agent 的 Node.js 20+：桌面端必须用真实 Node 启动 dsh（Electron 36 的运行时不被 dsh 原生模块支持）。' +
  '源码模式请安装 Node.js 20+（或重跑 install-engram.ps1 装便携 Node）；安装包形态应随包携带 resources/node/node.exe。';

let cachedStatus: AgentNodeStatus | null = null;

/** 清掉缓存（单测用） */
export function resetAgentNodeRuntimeCache(): void {
  cachedStatus = null;
}

/**
 * 确保进程用真实 Node 拉 dsh：非 Electron（Docker / 源码直跑）直接用进程自身；
 * Electron 模式解析真实 Node 并覆盖 process.execPath。结果缓存，失败也缓存（避免反复探测）。
 */
export function ensureAgentNodeRuntime(options: AgentNodeOptions = {}): AgentNodeStatus {
  if (cachedStatus) return cachedStatus;
  const versions = options.processVersions ?? process.versions;
  if (!isElectronRuntime(versions)) {
    cachedStatus = {
      ok: true,
      path: options.execPath ?? process.execPath,
      source: 'process',
      version: parseNodeVersion((versions as unknown as Record<string, string | undefined>).node) ?? '',
      error: '',
    };
    return cachedStatus;
  }

  const candidates = agentNodeCandidates(options);
  const probe = options.probe ?? probeNodeVersion;
  const picked = pickUsableAgentNode(candidates, probe);
  if (!picked) {
    const hint = candidates.length
      ? `候选 Node 都不可用（需要 20+）：${candidates.map((c) => c.path).join('、')}`
      : '没有找到任何候选 Node（ENGRAM_NODE_BIN / resources/node / 便携 Node / PATH 均为空）';
    cachedStatus = { ok: false, path: '', source: 'none', version: '', error: `${AGENT_NODE_MISSING_ERROR}（${hint}）` };
    return cachedStatus;
  }

  // 聊天运行时走官方 SDK，SDK 内部固定用 process.execPath 起子进程，没有注入点——
  // 只能把进程的 execPath 指向真实 Node（Electron 36 的纯 Node 模式里该属性可写，已实测）。
  try {
    const apply =
      options.applyExecPath ??
      ((file: string) => {
        Object.defineProperty(process, 'execPath', {
          value: file,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      });
    apply(picked.path);
  } catch (error) {
    cachedStatus = {
      ok: false,
      path: picked.path,
      source: picked.source,
      version: picked.version,
      error: `无法把 process.execPath 指向真实 Node（${(error as Error).message}）：聊天运行时无法启动 dsh`,
    };
    return cachedStatus;
  }

  cachedStatus = { ok: true, path: picked.path, source: picked.source, version: picked.version, error: '' };
  return cachedStatus;
}

/** 只读状态：未初始化时返回 ok=false 的占位（不触发探测） */
export function currentAgentNodeStatus(): AgentNodeStatus {
  return cachedStatus ?? { ok: false, path: '', source: 'none', version: '', error: '尚未初始化' };
}
