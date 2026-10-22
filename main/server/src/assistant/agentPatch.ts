import fs from 'node:fs';
import path from 'node:path';
import { engramPatchBlock } from '../lib/dshConfig.js';
import { zcodeMcpUrl } from '../lib/zcodeConfig.js';
import { cleanupLegacyRoute, profileDir, CONSOLE_PROFILE } from './agentSettings.js';

/**
 * 内置 Agent 的 dsh 覆盖层（两个文件，都由 Engram 生成、通过 SDK 的 --patch 显式叠加）：
 *
 *  1. engram.cordis.yml      —— 知识库 MCP 条目（mcp-engram）；
 *  2. engram-chat.cordis.yml —— 聊天运行时专用：把 sdk 应用（stdio JSON-RPC）叠到
 *     web profile 上，并关掉 Web UI 相关条目。
 *
 * 为什么聊天跑 web profile：模型与插件由 DSH 原生控制台（web profile 的设置/插件页）管理，
 * 聊天运行时必须和它共用同一个 profile，控制台里的改动才会对聊天生效。聊天进程只需要再加
 * 一个 stdio JSON-RPC 应用即可（dsh 的 sdk-app 本来就是一组插件，可以叠到任意 profile 上）。
 *
 * 不能用 `$DSH_HOME/cordis.patch.yml`（home patch）：dsh 启动时自动叠加，SDK 又把它当
 * --patch 再叠一次，重复条目会让启动失败；专属文件只走显式叠加。
 */

export const AGENT_PATCH_FILE = 'engram.cordis.yml';
export const CHAT_PATCH_FILE = 'engram-chat.cordis.yml';

const HEADER = [
  '# Engram 内置 Agent 的 dsh 覆盖层（自动生成，重新写入会整块替换；不要手工编辑）。',
  '# 由 Engram 的「内置 Agent 控制台」与聊天运行时共用：知识库 MCP 条目 + 聊天专用 stdio 应用。',
];

const CHAT_HEADER = [
  '# Engram 聊天运行时的 dsh 覆盖层（自动生成，重新写入会整块替换；不要手工编辑）。',
  '# 作用：在 web profile 上叠一层 sdk 应用（stdio JSON-RPC），并关掉 Web UI 相关条目。',
  '# 模型与插件由 DSH 控制台管理（同一 profile），这里不改它们。',
];

export function agentPatchPath(home: string): string {
  return path.join(home, AGENT_PATCH_FILE);
}

export function chatPatchPath(home: string): string {
  return path.join(home, CHAT_PATCH_FILE);
}

/**
 * 聊天运行时覆盖层：插入 sdk-app（stdio JSON-RPC），关掉 Web UI 相关条目。
 *
 * - sdk-jsonrpc-server 拥有 stdout（新行分隔 JSON-RPC）；Web 服务会往 stdout 打 URL 行，
 *   两条流混在一起虽然协议能容忍坏行，但没必要，所以聊天进程里关掉 webserver / web-runtime；
 * - hmr 与 session-title-llm 跟 sdk profile 一样关掉：Engram 自己管自动命名与热更新。
 */
export function chatPatchText(): string {
  return [
    ...CHAT_HEADER,
    '',
    '- insert:',
    '    - id: sdk-app-startup',
    "      name: '@deepseek-ai/dsh-sdk-app'",
    '      config:',
    `        profile: ${CONSOLE_PROFILE}`,
    '    - id: sdk-jsonrpc-server',
    "      name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
    '      inject: [sdkAppStartup, loader]',
    '      config:',
    '        maxTokensAsSuccess: true',
    '- id: webserver',
    '  disabled: true',
    '- id: web-runtime',
    '  disabled: true',
    '- id: hmr',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
  ].join('\n') + '\n';
}

export interface AgentPatchInput {
  /** 知识库 MCP 的 Bearer token（运行时注入） */
  token: string;
  /** 知识库 MCP 地址；默认取当前服务地址 */
  mcpUrl?: string;
}

/** 生成 MCP 覆盖层全文（末尾恰好一个换行） */
export function agentPatchText(input: AgentPatchInput): string {
  const url = input.mcpUrl || zcodeMcpUrl;
  return `${[...HEADER, '', engramPatchBlock(url, input.token)].join('\n').replace(/\n+$/, '')}\n`;
}

/**
 * 清理早期版本遗留：曾把 Engram 条目写进 `$DSH_HOME/cordis.patch.yml`（home 层）。
 * 该文件若还在，home 层会自动叠加一次，与显式 `--patch` 合成重复 id，dsh 直接启动失败。
 * 只删含本方标记的文件，托管目录里的其它内容不动。
 */
function dropLegacyHomePatch(home: string): void {
  const legacy = path.join(home, 'cordis.patch.yml');
  try {
    if (!fs.existsSync(legacy)) return;
    const text = fs.readFileSync(legacy, 'utf8');
    if (text.includes('mcp-engram')) fs.rmSync(legacy, { force: true });
  } catch {
    /* 删不掉时下次启动再试 */
  }
}

/** 写控制台/聊天共用的 MCP 覆盖层，并顺带做升级清理 */
export function writeAgentPatch(home: string, input: AgentPatchInput): string {
  fs.mkdirSync(home, { recursive: true });
  dropLegacyHomePatch(home);
  cleanupLegacyRoute(home);
  const file = agentPatchPath(home);
  fs.writeFileSync(file, agentPatchText(input), 'utf8');
  return file;
}

/** 写聊天运行时覆盖层（stdlib JSON-RPC + 关 Web UI）；目录不存在时创建 profile 目录 */
export function writeChatPatch(home: string): string {
  fs.mkdirSync(profileDir(home), { recursive: true });
  const file = chatPatchPath(home);
  fs.writeFileSync(file, chatPatchText(), 'utf8');
  return file;
}

const ANY_ENTRY_ID = /^ {0,4}-\s+id:\s*(\S+)\s*$/;

/** patch 文本里出现的所有 loader entry id（含 insert 块内的嵌套条目，展示/测试用） */
export function agentPatchEntryIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = ANY_ENTRY_ID.exec(line);
    if (match) ids.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return ids;
}
