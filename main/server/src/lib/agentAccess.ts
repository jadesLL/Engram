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

/**
 * 外置客户端「Agent 接入」注册表：只装 skill + CLI 包装脚本，不再写任何客户端的 MCP 配置。
 *
 * 每个客户端只关心两件事：
 *  1. 本机有没有装（检测目录 / 环境变量 / 可执行文件）；
 *  2. skill 装到哪个目录（各客户端约定不同，见各条注释）。
 * 注册 = 写本机 engram 包装脚本 + 把 <root>/engram、<root>/engram-customer-research 两份 skill
 * 装上（正文里的 {{ENGRAM}} 换成完整 CLI 命令）；注销 = 只删带管理标记的那两份文件。
 * 用户自己写的同名 skill 一律拒绝覆盖（沿用旧 assert...Writable 语义）。
 */

export type AgentClientId = 'claude' | 'codex' | 'dsh' | 'zcode' | 'kimi-code' | 'workbuddy' | 'qoder';

export interface AgentClientStatus {
  id: AgentClientId;
  title: string;
  /** 本机是否检测到该客户端 */
  installed: boolean;
  /** 两份 skill 都已安装（engram + engram-customer-research） */
  skillsInstalled: boolean;
  /** 主 skill 文件路径（engram/SKILL.md）；未检测到客户端时是默认安装位置 */
  skillPath: string;
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
}

export interface AgentUnregisterResult {
  client: AgentClientStatus;
  /** 实际删除的 skill 文件 */
  removed: string[];
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
  skillRoot: (home: string, env: NodeJS.ProcessEnv, io: AgentIo) => string;
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

/** Qoder 配置目录：环境变量优先（国际版 / 国内版各自变量），否则取检测到的变体，最后回落 ~/.qoder */
function qoderConfigDir(home: string, env: NodeJS.ProcessEnv, isDir: (dir: string) => boolean): string {
  const fromEnv = [envValue(env, ['QODER_CONFIG_DIR']), envValue(env, ['QODERCN_CONFIG_DIR'])]
    .filter((dir): dir is string => Boolean(dir));
  for (const dir of fromEnv) {
    if (isDir(dir)) return dir;
  }
  if (fromEnv.length) return fromEnv[0];
  const international = path.join(home, '.qoder');
  if (isDir(international)) return international;
  const china = path.join(home, '.qoder-cn');
  if (isDir(china)) return china;
  return international;
}

/**
 * 客户端检测与 skill 根（契约第 6 节表格）：
 * | claude      | ~/.claude                | ~/.claude/skills        |
 * | codex       | $CODEX_HOME 或 ~/.codex  | ~/.agents/skills        |
 * | dsh         | $DSH_HOME 或 ~/.dsh      | <home>/skills           |
 * | zcode       | ~/.zcode 或引擎路径      | ~/.zcode/skills         |
 * | kimi-code   | $KIMI_CODE_HOME 或 ~/.kimi-code | <home>/skills   |
 * | workbuddy   | ~/.workbuddy / ~/.workbuddy-ai（环境变量优先） | ~/.codebuddy/skills |
 * | qoder       | ~/.qoder / ~/.qoder-cn   | <config>/skills         |
 */
const CLIENTS: AgentClientDef[] = [
  {
    id: 'claude',
    title: 'Claude Code',
    installed: (home, _env, io) => io.isDir(path.join(home, '.claude')),
    skillRoot: (home) => path.join(home, '.claude', 'skills'),
  },
  {
    id: 'codex',
    title: 'Codex',
    installed: (home, env, io) => {
      const codexHome = envValue(env, ['CODEX_HOME']);
      if (codexHome && io.isDir(codexHome)) return true;
      return io.isDir(path.join(home, '.codex')) || binaryOnPath('codex', env, io.exists);
    },
    // Codex 的用户级 skill 根是 ~/.agents/skills，与 $CODEX_HOME 无关
    skillRoot: (home) => path.join(home, '.agents', 'skills'),
  },
  {
    id: 'dsh',
    title: 'DeepSeek Harness',
    installed: (home, env, io) => io.isDir(envValue(env, ['DSH_HOME']) || path.join(home, '.dsh')),
    skillRoot: (home, env) => path.join(envValue(env, ['DSH_HOME']) || path.join(home, '.dsh'), 'skills'),
  },
  {
    id: 'zcode',
    title: 'ZCode',
    installed: (home, _env, io) =>
      io.isDir(path.join(home, '.zcode')) || zcodeEngineCandidates().some((file) => io.exists(file)),
    skillRoot: (home) => path.join(home, '.zcode', 'skills'),
  },
  {
    id: 'kimi-code',
    title: 'Kimi Code CLI',
    installed: (home, env, io) => io.isDir(envValue(env, ['KIMI_CODE_HOME']) || path.join(home, '.kimi-code')),
    skillRoot: (home, env) => path.join(envValue(env, ['KIMI_CODE_HOME']) || path.join(home, '.kimi-code'), 'skills'),
  },
  {
    id: 'workbuddy',
    title: 'WorkBuddy',
    installed: (home, env, io) => {
      const fromEnv = envValue(env, ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR']);
      if (fromEnv) return io.isDir(fromEnv);
      return io.isDir(path.join(home, '.workbuddy')) || io.isDir(path.join(home, '.workbuddy-ai'));
    },
    // WorkBuddy 的 skill 根与配置目录无关，固定 ~/.codebuddy/skills
    skillRoot: (home) => path.join(home, '.codebuddy', 'skills'),
  },
  {
    id: 'qoder',
    title: 'Qoder',
    installed: (home, env, io) => {
      const fromEnv = [envValue(env, ['QODER_CONFIG_DIR']), envValue(env, ['QODERCN_CONFIG_DIR'])]
        .filter((dir): dir is string => Boolean(dir));
      if (fromEnv.length) return fromEnv.some((dir) => io.isDir(dir));
      return io.isDir(path.join(home, '.qoder')) || io.isDir(path.join(home, '.qoder-cn'));
    },
    skillRoot: (home, env, io) => path.join(qoderConfigDir(home, env, io.isDir), 'skills'),
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
  const root = def.skillRoot(home, env, io);
  return {
    id: def.id,
    title: def.title,
    installed: detected(def, home, env, io),
    skillsInstalled:
      agentSkillInstalled(root, ENGRAM_SKILL_NAME) && agentSkillInstalled(root, CUSTOMER_RESEARCH_SKILL_NAME),
    skillPath: path.join(root, ENGRAM_SKILL_NAME, 'SKILL.md'),
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
 * 一键接入：写本机 engram 包装脚本 + 安装两份 skill。
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
  const root = def.skillRoot(home, env, io);
  // 先预检同名冲突，再写任何文件：冲突时不动用户的目录，也不写 shim
  assertAgentSkillWritable(root, ENGRAM_SKILL_NAME);
  assertAgentSkillWritable(root, CUSTOMER_RESEARCH_SKILL_NAME);
  writeCliShim(home, runtime);
  const skillPaths = installAgentSkills(root, runtime.command);
  return {
    client: agentClientStatus(def.id, home, { ...options, runtime }),
    cli: runtime,
    skillPaths,
  };
}

/** 移除接入：只删带管理标记的两份 skill（旧版本装的入口 skill 一并清掉），不动客户端其他文件 */
export function unregisterAgentAccess(
  id: AgentClientId,
  home = os.homedir(),
  options: AgentStatusOptions = {},
): AgentUnregisterResult {
  const def = clientDef(id);
  const env = options.env ?? process.env;
  const io = agentIo(options);
  const root = def.skillRoot(home, env, io);
  const removed = removeAgentSkills(root);
  return { client: agentClientStatus(def.id, home, options), removed };
}

/**
 * 内置 Agent（dsh）的 skill 根：ensureLocalAgentCli 与设置页检测共用同一约定。
 * 单独导出便于测试与文档引用。
 */
export function dshSkillRoot(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return builtinAgentSkillRoot(home, env);
}
