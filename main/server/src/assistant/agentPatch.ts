import fs from 'node:fs';
import path from 'node:path';
import { cleanupLegacyRoute, profileDir, CONSOLE_PROFILE } from './agentSettings.js';

/**
 * 内置 Agent 的 dsh 覆盖层（由 Engram 生成、通过 SDK 的 --patch 显式叠加）：
 *
 *  engram-chat.cordis.yml —— 聊天运行时专用：把 sdk 应用（stdio JSON-RPC）叠到
 *  web profile 上，并关掉 Web UI 相关条目。
 *
 * 知识库不再经 MCP 接入：内置 Agent 改用 PATH 里的 `engram` 命令（shim 与 skill 由
 * lib/cliShim.ts 负责）。旧版本写入的 MCP 覆盖层（engram.cordis.yml）与 home 层 patch 里的
 * mcp-engram 条目必须清掉——MCP 端点已删除，留着只会让 dsh 叠加一个连不上的 MCP 客户端。
 *
 * 为什么聊天跑 web profile：模型与插件由 DSH 原生控制台（web profile 的设置/插件页）管理，
 * 聊天运行时必须和它共用同一个 profile，控制台里的改动才会对聊天生效。聊天进程只需要再加
 * 一个 stdio JSON-RPC 应用即可（dsh 的 sdk-app 本来就是一组插件，可以叠到任意 profile 上）。
 *
 * 不能用 `$DSH_HOME/cordis.patch.yml`（home patch）：dsh 启动时自动叠加，SDK 又把它当
 * --patch 再叠一次，重复条目会让启动失败；专属文件只走显式叠加。
 */

/** 旧版本（MCP 时代）写入的覆盖层文件名：升级时删掉 */
export const LEGACY_AGENT_PATCH_FILE = 'engram.cordis.yml';
export const CHAT_PATCH_FILE = 'engram-chat.cordis.yml';
/** home 层 patch（dsh 自动叠加）：旧版本曾把 MCP 条目写在这里 */
export const HOME_PATCH_FILE = 'cordis.patch.yml';
/** 旧 MCP 条目的 loader entry id / serverName（清理时按这两个标记识别本方条目） */
const LEGACY_ENTRY_ID = 'mcp-engram';

const CHAT_HEADER = [
  '# Engram 聊天运行时的 dsh 覆盖层（自动生成，重新写入会整块替换；不要手工编辑）。',
  '# 作用：在 web profile 上叠一层 sdk 应用（stdio JSON-RPC），并关掉 Web UI 相关条目。',
  '# 模型与插件由 DSH 控制台管理（同一 profile），这里不改它们。',
  '# 知识库访问走 PATH 里的 engram 命令（不写 MCP 条目）。',
];

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

/** 写聊天运行时覆盖层（stdio JSON-RPC + 关 Web UI）；目录不存在时创建 profile 目录 */
export function writeChatPatch(home: string): string {
  fs.mkdirSync(profileDir(home), { recursive: true });
  // 顺带做升级清理：0.2.x 遗留的 settings.yaml 与 dsh 导入到 profile patch 的旧模型路由
  cleanupLegacyRoute(home);
  const file = chatPatchPath(home);
  fs.writeFileSync(file, chatPatchText(), 'utf8');
  return file;
}

/* ---------------------------------------------------------------- 旧 MCP 覆盖层清理 */

const TOP_LEVEL_ITEM = /^-(\s|$)/;

/** 匹配旧 MCP 条目行（id 行或 serverName 行）；识别与删除共用 */
function isLegacyMcpEntryLine(line: string): boolean {
  return new RegExp(`^\\s*-\\s+id:\\s*${LEGACY_ENTRY_ID}(\\s|$)`).test(line)
    || /^\s*serverName:\s*['"]?engram['"]?(\s|$)/.test(line);
}

/** 定位旧 MCP 条目所属顶层块 [start, end)，start 为列 0 的 “- ” 行；找不到返回 null */
function findEntryRange(lines: string[]): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    if (!isLegacyMcpEntryLine(lines[i])) continue;
    let start = i;
    while (start > 0 && !TOP_LEVEL_ITEM.test(lines[start])) start--;
    if (!TOP_LEVEL_ITEM.test(lines[start])) return null;
    let end = start + 1;
    while (end < lines.length && !TOP_LEVEL_ITEM.test(lines[end])) end++;
    return [start, end];
  }
  return null;
}

/** 块上方紧邻（无空行间隔）的连续注释行属于该块，一并删掉 */
function blockStartWithComment(lines: string[], start: number): number {
  let s = start;
  while (s > 0 && /^\s*#/.test(lines[s - 1])) s--;
  return s;
}

/**
 * 升级清理（每次启动运行时都跑一遍，幂等）：
 *  1. 删旧版本生成的 MCP 覆盖层 `<home>/engram.cordis.yml`；
 *  2. 清 `<home>/cordis.patch.yml` 里含 mcp-engram 的条目（只删本方块，用户手写的其它条目与注释逐字保留；
 *     删完没有顶层条目了就把整个文件删掉——空的 home patch 对 dsh 没有意义）。
 */
export function cleanupLegacyMcpPatches(home: string): {
  removedAgentPatch: boolean;
  cleanedHomePatch: boolean;
} {
  let removedAgentPatch = false;
  const legacy = path.join(home, LEGACY_AGENT_PATCH_FILE);
  try {
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true });
      removedAgentPatch = true;
    }
  } catch {
    /* 删不掉时下次启动再试 */
  }

  let cleanedHomePatch = false;
  const patch = path.join(home, HOME_PATCH_FILE);
  try {
    if (fs.existsSync(patch)) {
      const lines = fs.readFileSync(patch, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
      let changed = false;
      let range = findEntryRange(lines);
      while (range) {
        const start = blockStartWithComment(lines, range[0]);
        lines.splice(start, range[1] - start);
        changed = true;
        range = findEntryRange(lines);
      }
      if (changed) {
        // 没有顶层条目了就删文件（剩下的只有本方写的文件头注释）
        if (!lines.some((line) => TOP_LEVEL_ITEM.test(line))) {
          fs.rmSync(patch, { force: true });
        } else {
          fs.writeFileSync(
            patch,
            lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '') + '\n',
            'utf8',
          );
        }
        cleanedHomePatch = true;
      }
    }
  } catch {
    /* 读不了/写不了时下次启动再试 */
  }
  return { removedAgentPatch, cleanedHomePatch };
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
