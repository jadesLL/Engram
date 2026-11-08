import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zcodeEngineCandidates } from './zcodeConfig.js';
import { builtinAgentSkillRoot, resolveCliRuntime, writeCliShim, type CliRuntime } from './cliShim.js';
import { CUSTOMER_RESEARCH_SKILL_NAME, ENGRAM_SKILL_NAME } from '../content/agentSkill.js';
import {
  agentSkillInstalled,
  assertAgentSkillWritable,
  installAgentSkills,
  removeAgentSkills,
} from './agentSkill.js';
import { cleanupLegacyAgentConfig } from './agentLegacyConfig.js';

/**
 * 外置客户端「Agent 接入」注册表：只装 skill + CLI 包装脚本，不再写任何客户端的 MCP 配置。
 *
 * 每个客户端只关心两件事：
 *  1. 本机有没有装（检测目录 / 环境变量 / 可执行文件）；
 *  2. skill 装到哪些目录（各客户端约定不同，见各条注释）。
 * 注册 = 写本机 engram 包装脚本 + 把 <root>/engram、<root>/engram-customer-research 两份 skill
 * 装上（正文里的 {{ENGRAM}} 换成完整 CLI 命令）；注销 = 只删带管理标记的那两份文件。
 * 用户自己写的同名 skill 一律拒绝覆盖（沿用旧 assert...Writable 语义）。
 *
 * Qoder / WorkBuddy 这类客户端按产品变体（国际版 / 国内版、标准版 / 海外版）使用不同配置目录，
 * 同一台机器可能两个变体都装了，而 Engram 看不到用户实际启动哪一个——**存在的变体目录全部维护**，
 * 否则会把 skill 写进客户端根本不读的那套目录（「显示接入成功但没效果」）。
 */

export type AgentClientId = 'claude' | 'codex' | 'dsh' | 'zcode' | 'kimi-code' | 'workbuddy' | 'qoder';

export interface AgentClientStatus {
  id: AgentClientId;
  title: string;
  /** 本机是否检测到该客户端 */
  installed: boolean;
  /** 两份 skill 在全部维护根里都已安装（engram + engram-customer-research） */
  skillsInstalled: boolean;
  /** 主 skill 文件路径（第一个维护根）；未检测到客户端时是默认安装位置 */
  skillPath: string;
  /** 全部维护的 skill 文件路径（多套变体目录时有多个） */
  skillPaths: string[];
  /** 本机 engram CLI 是否就绪（dist/cli/cli.js 存在） */
  cliAvailable: boolean;
  /** 写进 skill 的调用命令（CLI 不可用时回退 "engram"） */
  cliCommand: string;
}

export interface AgentDetectOptions {
  /** 注入环境变量（测试） */
  env?: NodeJS.ProcessEnv;
  /** 注入文件存在判断（测试） */
  exists?: (file: string) => boolean;
  /** 注入目录判断（测试） */
  isDir?: (dir: string) => boolean;
}

export interface AgentRegisterOptions extends AgentDetectOptions {
  /** 注入 CLI 运行时（测试 / 桌面端显式指定） */
  runtime?: CliRuntime;
}

export interface AgentRegisterResult {
  client: AgentClientStatus;
  cli: CliRuntime;
  /** 实际写入的 skill 文件 */
  skillPaths: string[];
  /** 顺带清掉的旧版本 Engram 配置（旧 MCP 条目 / 写错目录的 skill），只删本方写入的内容 */
  cleaned: string[];
}

export interface AgentUnregisterResult {
  client: AgentClientStatus;
  /** 实际删除的 skill 文件 */
  removed: string[];
  /** 顺带清掉的旧版本 Engram 配置 */
  cleaned: string[];
}

export interface AgentStatusOptions extends AgentDetectOptions {
  runtime?: CliRuntime;
}

interface AgentIo {
  exists: (file: string) => boolean;
  isDir: (dir: string) => boolean;
}

interface AgentClientDef {
  id: AgentClientId;
  title: string;
  installed: (home: string, env: NodeJS.ProcessEnv, io: AgentIo) => boolean;
  /** 全部要维护的 skill 根（变体目录存在时全部返回；都没有时给默认根用于展示/首次接入） */
  skillRoots: (home: string, env: NodeJS.ProcessEnv, io: AgentIo) => string[];
}

function defaultIsDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 取第一个非空环境变量（客户端配置目录常按国内版 / 海外版用不同变量） */
function envValue(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** 客户端命令是否在 PATH（Windows 兼顾 PATHEXT；与旧 codexCliOnPath 同口径） */
function binaryOnPath(binary: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): boolean {
  const raw = env.PATH || env.Path || '';
  if (!raw) return false;
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
      .flatMap((ext) => [ext, ext.toLowerCase()])
    : [''];
  return raw.split(path.delimiter).filter(Boolean).some((dir) =>
    extensions.some((ext) => exists(path.join(dir, binary + ext))),
  );
}

/**
 * WorkBuddy 配置目录（多套变体全部维护）：
 * 环境变量优先（海外版启动器会把 WORKBUDDY_CONFIG_DIR 指到 ~/.workbuddy-ai），
 * 否则取存在的 ~/.workbuddy / ~/.workbuddy-ai；都没有时回落 ~/.workbuddy 供展示。
 */
function workbuddyConfigDirs(
  home: string,
  env: NodeJS.ProcessEnv,
  io: AgentIo,
): { dirs: string[]; fallback: string; fromEnv: boolean } {
  const fromEnv = [envValue(env, ['WORKBUDDY_CONFIG_DIR']), envValue(env, ['CODEBUDDY_CONFIG_DIR'])]
    .filter((dir): dir is string => Boolean(dir));
  if (fromEnv.length) {
    const dirs = [...new Set(fromEnv)];
    return { dirs, fallback: dirs[0], fromEnv: true };
  }
  const existing = [path.join(home, '.workbuddy'), path.join(home, '.workbuddy-ai')].filter((dir) => io.isDir(dir));
  return { dirs: existing, fallback: path.join(home, '.workbuddy'), fromEnv: false };
}

/**
 * Qoder 配置目录（多套变体全部维护）：
 * 国际版 ~/.qoder（QODER_CONFIG_DIR）、国内版 ~/.qoder-cn（QODERCN_CONFIG_DIR）。
 * 环境变量指定哪个就只管哪个；否则存在的变体目录全部维护（用户实际启动哪个都生效）。
 */
function qoderConfigDirs(
  home: string,
  env: NodeJS.ProcessEnv,
  io: AgentIo,
): { dirs: string[]; fallback: string; fromEnv: boolean } {
  const fromEnv = [envValue(env, ['QODER_CONFIG_DIR']), envValue(env, ['QODERCN_CONFIG_DIR'])]
    .filter((dir): dir is string => Boolean(dir));
  if (fromEnv.length) {
    const dirs = [...new Set(fromEnv)];
    return { dirs, fallback: dirs[0], fromEnv: true };
  }
  const existing = [path.join(home, '.qoder'), path.join(home, '.qoder-cn')].filter((dir) => io.isDir(dir));
  return { dirs: existing, fallback: path.join(home, '.qoder'), fromEnv: false };
}

/**
 * 客户端检测与 skill 根（契约第 6 节表格）：
 * | claude      | ~/.claude                | ~/.claude/skills        |
 * | codex       | $CODEX_HOME 或 ~/.codex  | ~/.agents/skills        |
 * | dsh         | $DSH_HOME 或 ~/.dsh      | <home>/skills           |
 * | zcode       | ~/.zcode 或引擎路径      | ~/.zcode/skills         |
 * | kimi-code   | $KIMI_CODE_HOME 或 ~/.kimi-code | <home>/skills   |
 * | workbuddy   | ~/.workbuddy / ~/.workbuddy-ai（环境变量优先） | <配置目录>/skills（存在的变体全部维护） |
 * | qoder       | ~/.qoder / ~/.qoder-cn   | <配置目录>/skills（存在的变体全部维护） |
 */
const CLIENTS: AgentClientDef[] = [
  {
    id: 'claude',
    title: 'Claude Code',
    installed: (home, _env, io) => io.isDir(path.join(home, '.claude')),
    skillRoots: (home) => [path.join(home, '.claude', 'skills')],
  },
  {
    id: 'codex',
    title: 'Codex',
    installed: (home, env, io) => {
      const codexHome = envValue(env, ['CODEX_HOME']);
      if (codexHome && io.isDir(codexHome)) return true;
      return io.isDir(path.join(home, '.codex')) || binaryOnPath('codex', env, io.exists);
    },
    // Codex 的用户级 skill 根是共享的 ~/.agents/skills，与 $CODEX_HOME 无关
    skillRoots: (home) => [path.join(home, '.agents', 'skills')],
  },
  {
    id: 'dsh',
    title: 'DeepSeek Harness',
    installed: (home, env, io) => io.isDir(envValue(env, ['DSH_HOME']) || path.join(home, '.dsh')),
    skillRoots: (home, env) => [path.join(envValue(env, ['DSH_HOME']) || path.join(home, '.dsh'), 'skills')],
  },
  {
    id: 'zcode',
    title: 'ZCode',
    installed: (home, _env, io) =>
      io.isDir(path.join(home, '.zcode')) || zcodeEngineCandidates().some((file) => io.exists(file)),
    skillRoots: (home) => [path.join(home, '.zcode', 'skills')],
  },
  {
    id: 'kimi-code',
    title: 'Kimi Code CLI',
    installed: (home, env, io) => io.isDir(envValue(env, ['KIMI_CODE_HOME']) || path.join(home, '.kimi-code')),
    skillRoots: (home, env) => [
      path.join(envValue(env, ['KIMI_CODE_HOME']) || path.join(home, '.kimi-code'), 'skills'),
    ],
  },
  {
    id: 'workbuddy',
    title: 'WorkBuddy',
    installed: (home, env, io) => {
      const { dirs, fromEnv } = workbuddyConfigDirs(home, env, io);
      return fromEnv ? dirs.some((dir) => io.isDir(dir)) : dirs.length > 0;
    },
    // skill 根跟随配置目录：运行时 SkillsVersionEmitter 监视 <配置目录>/skills 与
    // <配置目录>/connectors/skills（2026-11 版实测），不是旧的 ~/.codebuddy/skills。
    skillRoots: (home, env, io) => {
      const { dirs, fallback } = workbuddyConfigDirs(home, env, io);
      return (dirs.length ? dirs : [fallback]).map((dir) => path.join(dir, 'skills'));
    },
  },
  {
    id: 'qoder',
    title: 'Qoder',
    installed: (home, env, io) => {
      const { dirs, fromEnv } = qoderConfigDirs(home, env, io);
      return fromEnv ? dirs.some((dir) => io.isDir(dir)) : dirs.length > 0;
    },
    skillRoots: (home, env, io) => {
      const { dirs, fallback } = qoderConfigDirs(home, env, io);
      return (dirs.length ? dirs : [fallback]).map((dir) => path.join(dir, 'skills'));
    },
  },
];

function agentIo(options: AgentDetectOptions = {}): AgentIo {
  return {
    exists: options.exists ?? fs.existsSync,
    isDir: options.isDir ?? defaultIsDir,
  };
}

function clientDef(id: string): AgentClientDef {
  const def = CLIENTS.find((client) => client.id === id);
  if (!def) throw new Error('未知客户端：' + id);
  return def;
}

/** 是否为已知客户端 id（路由入参校验用） */
export function isAgentClientId(value: string): value is AgentClientId {
  return CLIENTS.some((client) => client.id === value);
}

function detected(def: AgentClientDef, home: string, env: NodeJS.ProcessEnv, io: AgentIo): boolean {
  try {
    return def.installed(home, env, io);
  } catch {
    return false;
  }
}

/** 单个客户端状态（skill 目录、CLI 可用性） */
export function agentClientStatus(
  id: AgentClientId,
  home = os.homedir(),
  options: AgentStatusOptions = {},
): AgentClientStatus {
  const def = clientDef(id);
  const env = options.env ?? process.env;
  const io = agentIo(options);
  const runtime = options.runtime ?? resolveCliRuntime(home);
  const roots = def.skillRoots(home, env, io);
  const skillPaths = roots.map((root) => path.join(root, ENGRAM_SKILL_NAME, 'SKILL.md'));
  const installed = detected(def, home, env, io);
  return {
    id: def.id,
    title: def.title,
    installed,
    skillsInstalled: installed && roots.length > 0 && roots.every(
      (root) => agentSkillInstalled(root, ENGRAM_SKILL_NAME) && agentSkillInstalled(root, CUSTOMER_RESEARCH_SKILL_NAME),
    ),
    skillPath: skillPaths[0] ?? path.join(home, '.engram', 'skills', ENGRAM_SKILL_NAME, 'SKILL.md'),
    skillPaths,
    cliAvailable: runtime.available,
    cliCommand: runtime.available ? runtime.command : 'engram',
  };
}

/** 全部客户端状态（设置页「Agent 接入」列表） */
export function agentClients(home = os.homedir(), options: AgentStatusOptions = {}): AgentClientStatus[] {
  const runtime = options.runtime ?? resolveCliRuntime(home);
  return CLIENTS.map((def) => agentClientStatus(def.id, home, { ...options, runtime }));
}

/**
 * 一键接入：写本机 engram 包装脚本 + 在全部维护根安装两份 skill，并顺带清掉旧版本写入的
 * Engram MCP 条目与写错目录的 skill（只删带管理标记 / 名为 engram 的本方条目）。
 * 未检测到客户端或 CLI 未构建时抛错；同名非 Engram 管理的 skill 在写任何文件前就拒绝。
 */
export function registerAgentAccess(
  id: AgentClientId,
  home = os.homedir(),
  options: AgentRegisterOptions = {},
): AgentRegisterResult {
  const def = clientDef(id);
  const env = options.env ?? process.env;
  const io = agentIo(options);
  const runtime = options.runtime ?? resolveCliRuntime(home);
  if (!detected(def, home, env, io)) throw new Error('未检测到本机 ' + def.title + ' 客户端');
  if (!runtime.available) throw new Error('engram CLI 尚未就绪：' + (runtime.error || runtime.scriptPath));
  const roots = def.skillRoots(home, env, io);
  // 先预检同名冲突，再写任何文件：冲突时不动用户的目录，也不写 shim
  for (const root of roots) {
    assertAgentSkillWritable(root, ENGRAM_SKILL_NAME);
    assertAgentSkillWritable(root, CUSTOMER_RESEARCH_SKILL_NAME);
  }
  const cleaned = cleanupLegacyAgentConfig(def.id, home, env);
  writeCliShim(home, runtime);
  const skillPaths = roots.flatMap((root) => installAgentSkills(root, runtime.command));
  return {
    client: agentClientStatus(def.id, home, { ...options, runtime }),
    cli: runtime,
    skillPaths,
    cleaned,
  };
}

/** 移除接入：只删带管理标记的两份 skill（全部变体根 + 旧版本写错目录的入口 skill），不动客户端其他文件 */
export function unregisterAgentAccess(
  id: AgentClientId,
  home = os.homedir(),
  options: AgentStatusOptions = {},
): AgentUnregisterResult {
  const def = clientDef(id);
  const env = options.env ?? process.env;
  const io = agentIo(options);
  const roots = def.skillRoots(home, env, io);
  const removed = roots.flatMap((root) => removeAgentSkills(root));
  const cleaned = cleanupLegacyAgentConfig(def.id, home, env);
  return { client: agentClientStatus(def.id, home, options), removed, cleaned };
}

/**
 * 内置 Agent（dsh）的 skill 根：ensureLocalAgentCli 与设置页检测共用同一约定。
 * 单独导出便于测试与文档引用。
 */
export function dshSkillRoot(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return builtinAgentSkillRoot(home, env);
}
