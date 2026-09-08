import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DeepSeek Harness（dsh）接入。
 *
 * dsh 的 MCP 只能通过 patch 配置层启用：$DSH_HOME/cordis.patch.yml（顶层 YAML 数组，
 * 每项是 loader patch 条目）。没有管理子命令，这里直接做文本级块编辑——只动本方维护的
 * 固定块（id: mcp-engram / serverName: engram），不 parse 整个文件，避免引入 YAML 依赖
 * 与破坏用户手写的 !!js 等标签。registered 判定与块定位共用同一函数，保证状态与注销
 * 行为一致。
 */

const ENTRY_ID = 'mcp-engram';

/** $DSH_HOME：未设环境变量时默认 ~/.dsh（与 dsh 的 settings-file 等插件一致） */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  return env || path.join(os.homedir(), '.dsh');
}

export function dshPatchPath(home: string = dshHome()): string {
  return path.join(home, 'cordis.patch.yml');
}

const PATCH_HEADER = [
  '# Machine-local DSH user patch layer ($DSH_HOME/cordis.patch.yml).',
  "# Applied over EVERY profile's own cordis.patch.yml (web / headless / sdk / acp / ...),",
  '# so keep this a top-level YAML array of loader patch entries.',
].join('\n');

export function engramPatchBlock(url: string, token: string): string {
  return [
    '# Engram 知识库 MCP（由 Engram 设置页「Agent 接入」维护，重新注册会整块替换）。',
    '# Engram 未启动时 DSH 照常启动，只是 mcp__engram__* 工具缺席。',
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: engram',
    '        transport: streamable-http',
    `        url: ${url}`,
    '        headers:',
    `          Authorization: 'Bearer ${token}'`,
  ].join('\n');
}

/** 匹配本方条目行（id 行或 serverName 行）；registered 判定与删除共用 */
function isEntryLine(line: string): boolean {
  return /^\s*-\s+id:\s*mcp-engram(\s|$)/.test(line) ||
    /^\s*serverName:\s*['"]?engram['"]?(\s|$)/.test(line);
}

const TOP_LEVEL_ITEM = /^-(\s|$)/;

/** 定位 engram 条目所属顶层块 [start, end)，start 为列 0 的 “- ” 行；找不到返回 null */
function findEntryRange(lines: string[]): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    if (!isEntryLine(lines[i])) continue;
    let start = i;
    while (start > 0 && !TOP_LEVEL_ITEM.test(lines[start])) start--;
    if (!TOP_LEVEL_ITEM.test(lines[start])) return null;
    let end = start + 1;
    while (end < lines.length && !TOP_LEVEL_ITEM.test(lines[end])) end++;
    return [start, end];
  }
  return null;
}

/** 块上方紧邻（无空行间隔）的连续注释行属于该块，一并处理 */
function blockStartWithComment(lines: string[], start: number): number {
  let s = start;
  while (s > 0 && /^\s*#/.test(lines[s - 1])) s--;
  return s;
}

function readPatchLines(patchPath: string): string[] {
  return fs.readFileSync(patchPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
}

function writePatchLines(patchPath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, lines.join('\n').replace(/\n+$/, '') + '\n');
}

export function dshRegistered(patchPath: string = dshPatchPath()): boolean {
  try {
    return findEntryRange(readPatchLines(patchPath)) !== null;
  } catch {
    return false; // 无 patch 文件视为未注册
  }
}

export function dshLoggedIn(home: string = dshHome()): boolean {
  try {
    return fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export interface DshStatus {
  installed: boolean;
  loggedIn: boolean;
  registered: boolean;
  home: string;
}

export function getDshStatus(): DshStatus {
  const home = dshHome();
  return {
    installed: fs.existsSync(home),
    loggedIn: dshLoggedIn(home),
    registered: dshRegistered(),
    home,
  };
}

/**
 * 注册（或整块替换）Engram MCP 条目；其余顶层块与注释逐字保留。
 * 返回写入的 patch 文件路径。
 */
export function registerDshMcp(url: string, token: string, patchPath: string = dshPatchPath()): string {
  const lines = fs.existsSync(patchPath) ? readPatchLines(patchPath) : PATCH_HEADER.split(/\r?\n/);
  const range = findEntryRange(lines);
  let rest: string[];
  if (range) {
    const start = blockStartWithComment(lines, range[0]);
    rest = [...lines.slice(0, start), ...lines.slice(range[1])];
  } else {
    rest = lines;
  }
  // 去掉结尾空行后空一行接新块
  writePatchLines(patchPath, [...rest, '', ...engramPatchBlock(url, token).split('\n')]);
  return patchPath;
}

/** 移除注册；文件不存在或没有可定位块时静默不变 */
export function unregisterDshMcp(patchPath: string = dshPatchPath()): void {
  if (!fs.existsSync(patchPath)) return;
  const lines = readPatchLines(patchPath);
  const range = findEntryRange(lines);
  if (!range) return;
  const start = blockStartWithComment(lines, range[0]);
  lines.splice(start, range[1] - start);
  writePatchLines(patchPath, lines);
}
