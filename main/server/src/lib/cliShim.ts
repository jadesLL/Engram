import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAgentNodeRuntime } from '../assistant/agentNode.js';
import { installAgentSkills } from './agentSkill.js';

/**
 * 本机 engram CLI 的运行时解析与包装脚本（shim）。
 *
 * 内置 Agent（dsh）与外置客户端不再经 MCP：知识库 = PATH 里的一条 engram 命令。
 * 服务端只负责把这个命令准备好：
 *  1. 解析 Node：桌面端用随包 / 便携的真实 Node（ensureAgentNodeRuntime，dsh 同一套），
 *     Docker / 源码模式即进程自身；
 *  2. 解析入口：dist/cli/cli.js（相对本文件 ../cli/cli.js，src 与 dist 同构）；
 *  3. 写包装脚本 <home>/.engram/bin/engram(.cmd)，内置 Agent 的 PATH 里放这个目录，
 *     外置客户端安装 skill 后按 skill 里给出的完整命令调用。
 * 包装脚本与 skill 都不含令牌：连接信息在 ~/.engram/config.json（服务端启动时登记）。
 */

export interface CliRuntime {
  /** 拉起 CLI 的 Node 可执行文件（桌面端 = resources/node/node.exe） */
  nodePath: string;
  /** CLI 入口 cli.js 的绝对路径 */
  scriptPath: string;
  /** 带引号的完整调用命令："<node>" "<script>"（写进 skill 与包装脚本） */
  command: string;
  /** 本机包装脚本路径（Windows：<home>/.engram/bin/engram.cmd；POSIX：<home>/.engram/bin/engram） */
  shimPath: string;
  /** cli.js 是否存在（不存在 = 还没构建 server，命令不可用） */
  available: boolean;
  /** available=false 或初始化失败时的原因（给设置页 / 日志的人话） */
  error?: string;
}

export interface CliRuntimeOptions {
  /** 注入 Node 路径（测试 / 桌面端显式指定） */
  nodePath?: string;
  /** 注入 cli.js 路径（测试） */
  scriptPath?: string;
  /** 注入平台（Windows 决定 .cmd 包装脚本；测试用） */
  platform?: NodeJS.Platform;
  /** 注入文件存在判断（测试） */
  exists?: (file: string) => boolean;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** CLI 入口路径：src/lib 与 dist/lib 都相对本文件 ../cli/cli.js */
export function cliScriptPath(): string {
  return path.resolve(moduleDir, '..', 'cli', 'cli.js');
}

/** 包装脚本目录：<home>/.engram/bin */
export function cliShimDir(home = os.homedir()): string {
  return path.join(home, '.engram', 'bin');
}

/** 包装脚本路径：Windows 为 engram.cmd，其余为 engram */
export function cliShimPath(home = os.homedir(), platform = process.platform): string {
  return path.join(cliShimDir(home), platform === 'win32' ? 'engram.cmd' : 'engram');
}

/** 内置 Agent（dsh）的 skill 根：$DSH_HOME/skills 或 ~/.dsh/skills（与设置页检测同一约定） */
export function builtinAgentSkillRoot(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env.DSH_HOME?.trim();
  return path.join(dshHome || path.join(home, '.dsh'), 'skills');
}

/** CLI 连接配置：~/.engram/config.json（服务端启动时零配置登记，远程客户端手动 login 写） */
export function cliConfigPath(home = os.homedir()): string {
  return path.join(home, '.engram', 'config.json');
}

/** 解析 Node：桌面端用随包 / 便携的真实 Node，失败退回进程自身 */
function resolveNodePath(): string {
  try {
    const runtime = ensureAgentNodeRuntime();
    if (runtime.ok && runtime.path) return runtime.path;
  } catch {
    /* 探测异常按进程自身处理 */
  }
  return process.execPath;
}

function quoted(value: string): string {
  return '"' + value + '"';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析本机可用 CLI；cli.js 不存在时 available=false 并给出原因 */
export function resolveCliRuntime(home = os.homedir(), options: CliRuntimeOptions = {}): CliRuntime {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? fs.existsSync;
  const scriptPath = options.scriptPath ?? cliScriptPath();
  const nodePath = options.nodePath ?? resolveNodePath();
  let available = false;
  try {
    available = exists(scriptPath);
  } catch {
    available = false;
  }
  return {
    nodePath,
    scriptPath,
    command: quoted(nodePath) + ' ' + quoted(scriptPath),
    shimPath: cliShimPath(home, platform),
    available,
    ...(available ? {} : { error: '找不到 engram CLI 入口 ' + scriptPath + '（请先构建 server：dist/cli/cli.js）' }),
  };
}

/** 包装脚本文本：Windows 批处理 / POSIX sh，都是「把参数原样转给 node cli.js」 */
export function cliShimText(runtime: CliRuntime, platform = process.platform): string {
  if (platform === 'win32') {
    return ['@echo off', quoted(runtime.nodePath) + ' ' + quoted(runtime.scriptPath) + ' %*', ''].join('\r\n');
  }
  return ['#!/bin/sh', 'exec ' + quoted(runtime.nodePath) + ' ' + quoted(runtime.scriptPath) + ' "$@"', ''].join('\n');
}

/**
 * 写包装脚本（幂等）：内容没变就不重写（少一次无意义写盘，也保住 mtime）。
 * 返回包装脚本路径。
 */
export function writeCliShim(
  home = os.homedir(),
  runtime = resolveCliRuntime(home),
  platform = process.platform,
): string {
  const shimPath = runtime.shimPath;
  const text = cliShimText(runtime, platform);
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  let current = '';
  try {
    current = fs.readFileSync(shimPath, 'utf8');
  } catch {
    /* 首次写入 */
  }
  if (current !== text) {
    const temporary = shimPath + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temporary, text, { mode: platform === 'win32' ? 0o644 : 0o755 });
      fs.renameSync(temporary, shimPath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  if (platform !== 'win32') {
    try {
      fs.chmodSync(shimPath, 0o755);
    } catch {
      /* 文件系统不支持 chmod（如某些容器挂载）：能执行就行 */
    }
  }
  return shimPath;
}

/** 把 shim 目录放到 PATH 最前面（Windows 上删掉别名 Path，避免同一变量两份拼写） */
function withShimPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  // Windows 的 env 键名大小写不敏感、展开成普通对象后可能只剩 Path：先取值再删别名，否则会丢掉原 PATH
  const current = next.PATH || next.Path || '';
  delete next.Path;
  next.PATH = current ? dir + path.delimiter + current : dir;
  return next;
}

export interface LocalAgentCliOptions {
  /**
   * skill 安装根目录（内置 Agent 的 DSH_HOME 是 <DATA_DIR>/dsh，不在 process.env 里，
   * 由调用方显式传入 <home>/skills；省略时按 $DSH_HOME 或 ~/.dsh/skills）。
   */
  skillRoot?: string;
  /** 注入环境变量（测试 / 调用方已知 DSH_HOME 时） */
  env?: NodeJS.ProcessEnv;
  /** 注入 CLI 运行时（测试 / 桌面端显式指定），省略时按本机解析 */
  runtime?: CliRuntime;
}

/**
 * 本机接入统一入口（内置 Agent 启动 / 外置一键接入共用）：
 * 确保包装脚本就位 + 把 shim 目录注入 PATH + 给内置 Agent 装 engram skill。
 * 失败不抛：状态里带 error，调用方（聊天 / 控制台）按「没有知识库命令」降级处理。
 */
export function ensureLocalAgentCli(
  home = os.homedir(),
  options: LocalAgentCliOptions = {},
): { cli: CliRuntime; env: NodeJS.ProcessEnv } {
  let cli = options.runtime ?? resolveCliRuntime(home);
  let env: NodeJS.ProcessEnv = { ...process.env };
  if (!cli.available) return { cli, env };
  try {
    const shimPath = writeCliShim(home, cli);
    env = withShimPath(env, path.dirname(shimPath));
  } catch (error) {
    cli = { ...cli, error: '写入 engram 包装脚本失败：' + errorMessage(error) };
  }
  try {
    // 内置 Agent 直接跑 engram：PATH 里有 shim，skill 正文也用 engram 简写
    const skillRoot = options.skillRoot ?? builtinAgentSkillRoot(home, options.env ?? process.env);
    installAgentSkills(skillRoot, 'engram');
  } catch (error) {
    cli = {
      ...cli,
      error: (cli.error ? cli.error + '；' : '') + '安装 engram skill 失败：' + errorMessage(error),
    };
  }
  return { cli, env };
}
