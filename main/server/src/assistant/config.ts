import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from '../config.js';
import { getSetting, setSetting } from '../lib/db.js';

/**
 * 内置 Agent（聊天抽屉）配置与路径。
 *
 * 与「Agent 接入」（给用户自己安装的 harness 注册 MCP）互不相干：这里是 Engram 随包
 * 内置的 dsh 运行时，DSH_HOME 放在数据目录下，凭据与知识库一起走持久卷。
 */

export interface AgentConfig {
  /** 覆盖 dsh 入口（默认用随包依赖里的 @deepseek-ai/dsh/lib/bin.js） */
  dshPath?: string;
  /** 模型名（留空用 dsh 默认；填了自定义地址则必填） */
  model?: string;
  /** 自定义 API 地址：填了就走 llm-pi-ai 自定义 provider 路由，留空走 dsh 自带的 deepseek-official */
  baseUrl?: string;
  /** 自定义地址的线协议（取值见 agentSettings.AGENT_APIS，默认 openai-completions） */
  api?: string;
  /** 模型凭据：跑 dsh 时经环境变量注入（自定义地址用 ENGRAM_AGENT_API_KEY，官方用 DEEPSEEK_API_KEY） */
  apiKey?: string;
}

export const AGENT_CONFIG_KEY = 'agent_config';

export function getAgentConfig(): AgentConfig {
  try {
    const raw = getSetting(AGENT_CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function setAgentConfig(patch: Partial<AgentConfig>): AgentConfig {
  const next = { ...getAgentConfig(), ...patch };
  for (const key of Object.keys(next) as Array<keyof AgentConfig>) {
    if (next[key] === undefined) delete next[key];
  }
  setSetting(AGENT_CONFIG_KEY, JSON.stringify(next));
  return next;
}

/** 内置 Agent 的 DSH_HOME：数据目录内，与用户自己的 ~/.dsh 隔离 */
export function bundledDshHome(): string {
  return path.join(DATA_DIR, 'dsh');
}

/**
 * Agent 的工作目录：独立空目录，**不是**知识库目录。
 * 姿态是只读沙箱 + 知识库只经 MCP 工具，工作目录给一个空壳即可。
 */
export function agentWorkspaceDir(): string {
  return path.join(bundledDshHome(), 'workspace');
}

let cachedBundledBin: string | null | undefined;

/** 随包依赖里的 dsh 入口；未安装返回 null */
export function bundledDshBin(): string | null {
  if (cachedBundledBin !== undefined) return cachedBundledBin;
  try {
    const require = createRequire(import.meta.url);
    cachedBundledBin = require.resolve('@deepseek-ai/dsh/lib/bin.js');
  } catch {
    cachedBundledBin = null;
  }
  return cachedBundledBin;
}

export interface ResolvedDsh {
  path: string;
  source: 'config' | 'bundled';
}

/** 解析实际使用的 dsh 入口：设置页覆盖优先，其次随包依赖 */
export function resolveDsh(): ResolvedDsh | null {
  const configured = getAgentConfig().dshPath?.trim();
  if (configured) return { path: configured, source: 'config' };
  const bundled = bundledDshBin();
  return bundled ? { path: bundled, source: 'bundled' } : null;
}
