import fs from 'node:fs';
import path from 'node:path';
import { engramPatchBlock } from '../lib/dshConfig.js';
import { zcodeMcpUrl } from '../lib/zcodeConfig.js';
import { cleanupLegacyRoute, quote, type CustomRoute } from './agentSettings.js';

/**
 * 内置 Agent 的 dsh patch 层（`<数据目录>/dsh/engram.cordis.yml`）。
 *
 * 通过 SDK 的 `patches` 参数显式叠加（dsh 的层序：bundle → profile patch → home patch →
 * --patch），因此这一层永远压过 dsh 自己导入的 settings.yaml.imported 与 profile patch。
 *
 * 内容两块：
 *  1. Engram 知识库 MCP 条目（`mcp-engram`，insert）；
 *  2. 模型路由（`llm-pi-ai` / `agent-default-model`，id 定向覆盖 config）。
 *
 * 为什么不写 `$DSH_HOME/cordis.patch.yml`：那一层是 home patch，dsh 启动时自动叠加，
 * 而 SDK 又把本文件作为 `--patch` 显式叠加 → 同一条目被应用两次，启动即报
 * `duplicate loader entry id`。专属文件只走显式叠加，也不与用户手写配置混住。
 */

export const AGENT_PATCH_FILE = 'engram.cordis.yml';

const HEADER = [
  '# Engram 内置 Agent 的 dsh patch 层（自动生成，重新写入会整块替换；不要手工编辑）。',
  '# 由 设置 → Agent 与自动化 → 内置 Agent 维护：知识库 MCP 条目 + 自定义模型路由。',
  '# 层级：--patch 覆盖在 bundle / profile patch 之上（0.2.x 的 settings.yaml 只做一次性导入）。',
];

export function agentPatchPath(home: string): string {
  return path.join(home, AGENT_PATCH_FILE);
}

/**
 * 模型路由 patch 条目。
 *
 * patch 的 config 是**整体替换**：llm-pi-ai 段只保留 Engram 自己声明的 provider，
 * 与 0.1.5 写 settings.yaml 时的语义一致（当时也是整段替换）。
 * 不写 `name`：id 定向 patch 只按 id 命中，0.2.1 实测保留原 name。
 */
export function modelRouteBlocks(route: CustomRoute): string[] {
  return [
    '# Engram 模型路由（设置页维护）：0.2.x 起 dsh 的 settings.yaml 只做一次性导入，路由必须走 patch。',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${route.provider}:`,
    '        displayName: Engram 自定义地址',
    `        apiKeyEnv: ${route.keyEnv}`,
    `        api: ${route.api}`,
    `        baseURL: ${quote(route.baseUrl)}`,
    '        models:',
    `          - id: ${quote(route.model)}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${route.provider}`,
    `    model: ${quote(route.model)}`,
  ];
}

export interface AgentPatchInput {
  /** 知识库 MCP 的 Bearer token（运行时注入；只写哈希后的访问令牌，不写 Key） */
  token: string;
  /** 自定义模型路由；null/undefined 时不写路由条目（走 dsh 自带 deepseek-official） */
  route?: CustomRoute | null;
  /** 知识库 MCP 地址；默认取当前服务地址 */
  mcpUrl?: string;
}

/** 生成 patch 文件全文（末尾恰好一个换行） */
export function agentPatchText(input: AgentPatchInput): string {
  const url = input.mcpUrl || zcodeMcpUrl;
  const blocks = [HEADER.join('\n'), '', engramPatchBlock(url, input.token)];
  if (input.route) blocks.push('', modelRouteBlocks(input.route).join('\n'));
  return `${blocks.join('\n').replace(/\n+$/, '')}\n`;
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

/**
 * 写内置 Agent 的 patch 文件（每次运行前刷新，token 轮换即生效）。
 *
 * 顺带做两件迁移清理：
 *  - 早期 home 层 legacy patch（会与本文件重复）；
 *  - 0.1.5 遗留的 settings.yaml + 它被 0.2.x 导入到 profile patch 的同名条目
 *    （否则关掉自定义地址后旧路由会反超默认值）。
 *
 * @returns 写入的 patch 文件路径
 */
export function writeAgentPatch(home: string, input: AgentPatchInput): string {
  fs.mkdirSync(home, { recursive: true });
  dropLegacyHomePatch(home);
  cleanupLegacyRoute(home);
  const file = agentPatchPath(home);
  fs.writeFileSync(file, agentPatchText(input), 'utf8');
  return file;
}

// loader 条目 id 最多缩进 4 格（顶层 0 / insert 块内 4）；更深的 id 属于 config 里的数据列表（如 models）
const ANY_ENTRY_ID = /^ {0,4}-\s+id:\s*(\S+)\s*$/;

/** patch 文本里出现的所有 loader entry id（含 insert 块内的嵌套条目，展示用） */
export function agentPatchEntryIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = ANY_ENTRY_ID.exec(line);
    if (match) ids.push(match[1].replace(/^['"]|['"]$/g, ''));
  }
  return ids;
}
