import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Codex CLI 接入。
 *
 * Codex 的 MCP 配置在 ~/.codex/config.toml：启用一个 streamable HTTP MCP 只需
 * `[mcp_servers.engram]` 表，带 url 与 http_headers. `codex mcp add` 仅支持
 * `--bearer-token-env-var`（要求用户环境变量），无法直接写 Bearer 头，所以这里
 * 与 dshConfig 同一取舍：文本级维护本方固定的 TOML 片段，不 parse 整个 TOML，
 * 避免新增依赖与破坏用户手写内容/注释/其他 [mcp_servers.*] 条目。
 *
 * 识别范围 = 表头 `[mcp_servers.engram]` 到下一个表头之间的完整块；
 * 注册前紧邻的注释行属于该块，整体替换或删除。
 */

/** $CODEX_HOME：未设环境变量时默认 ~/.codex（与 Codex CLI config.toml 默认位置一致） */
export function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env || path.join(os.homedir(), '.codex');
}

export function codexConfigPath(home: string = codexHome()): string {
  return path.join(home, 'config.toml');
}

const BLOCK_HEADER = [
  '# Engram 知识库 MCP（由 Engram 设置页「Agent 接入」维护，重新注册会整块替换下面这张表）。',
  '# Engram 未启动时 Codex 照常启动，只是这组 mcp__engram__* 工具缺席。',
].join('\n');

const ENGRAM_HEADER = '[mcp_servers.engram]';
const ENGRAM_HEADER_RE = /^\[mcp_servers\.engram\][ \t]*$/;
const TABLE_HEADER_RE = /^\[/;

export function engramBlock(url: string, token: string): string {
  return [
    ...BLOCK_HEADER.split('\n'),
    ENGRAM_HEADER,
    `url = "${url}"`,
    `http_headers = { "Authorization" = "Bearer ${token}" }`,
  ].join('\n');
}

function readConfigLines(configPath: string): string[] {
  return fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
}

/** 定位 engram 块 [start, end)，start 为表头（或紧邻注释首行）；找不到返回 null */
function findEntryRange(lines: string[]): [number, number] | null {
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ENGRAM_HEADER_RE.test(lines[i])) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return null;
  let start = headerIndex;
  // 块上方紧邻（无空行间隔）的连续注释行属于该块，一并处理
  while (start > 0 && /^\s*#/.test(lines[start - 1])) start--;
  let end = headerIndex + 1;
  while (end < lines.length && !TABLE_HEADER_RE.test(lines[end])) end++;
  for (let i = end - 1; i > start; i--) {
    if (lines[i].trim() === '') end = i;
    else break;
  }
  return [start, end];
}

/** 保留原文换行风格写入；读取时已剥 BOM，末尾统一保留一个换行 */
function writeConfigLines(configPath: string, lines: string[], eol: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, lines.join(eol).replace(/(\r?\n)+$/, '') + eol);
}

export function codexRegistered(configPath: string = codexConfigPath()): boolean {
  try {
    return findEntryRange(readConfigLines(configPath)) !== null;
  } catch {
    return false; // 无配置文件视为未注册
  }
}

/** codex 命令是否在 PATH 中（Windows 兼顾 PATHEXT） */
export function codexCliOnPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): boolean {
  const raw = env.PATH || env.Path || '';
  if (!raw) return false;
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)
      .flatMap((ext) => [ext, ext.toLowerCase()])
    : [''];
  return raw.split(path.delimiter).filter(Boolean).some((dir) =>
    exts.some((ext) => exists(path.join(dir, `codex${ext}`))),
  );
}

export interface CodexStatus {
  installed: boolean;
  registered: boolean;
  home: string;
  configPath: string;
}

/** installed：Codex CLI 在 PATH，或本机已有 $CODEX_HOME（至少运行过一次） */
export function getCodexStatus(): CodexStatus {
  const home = codexHome();
  const configPath = codexConfigPath(home);
  return {
    installed: codexCliOnPath() || fs.existsSync(home),
    registered: codexRegistered(configPath),
    home,
    configPath,
  };
}

/**
 * 注册（或整块替换）Engram MCP 条目；其余表、注释与顺序逐字保留。
 * 返回写入的配置文件路径。
 */
export function registerCodexMcp(url: string, token: string, configPath: string = codexConfigPath()): string {
  const exists = fs.existsSync(configPath);
  const raw = exists ? fs.readFileSync(configPath, 'utf8') : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = exists ? raw.replace(/^\uFEFF/, '').split(/\r?\n/) : [];
  const range = findEntryRange(lines);
  let rest = range
    ? [...lines.slice(0, range[0]), ...lines.slice(range[1])]
    : lines;
  while (rest.length && rest[rest.length - 1].trim() === '') rest.pop();
  // 文件里本来只有 Engram 块时，移除后回落到块头注释，保持「有文件 = 已初始化过」的形态
  if (!range && rest.length === 0 && exists) rest = BLOCK_HEADER.split('\n');
  const body = rest.length
    ? [...rest, '', ...engramBlock(url, token).split('\n')]
    : engramBlock(url, token).split('\n');
  writeConfigLines(configPath, body, eol);
  return configPath;
}

/** 移除注册；文件不存在或没有 engram 块时静默不变（其他内容保留） */
export function unregisterCodexMcp(configPath: string = codexConfigPath()): void {
  if (!fs.existsSync(configPath)) return;
  const raw = fs.readFileSync(configPath, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const range = findEntryRange(lines);
  if (!range) return;
  let rest = [...lines.slice(0, range[0]), ...lines.slice(range[1])];
  // 文件里本来只有 Engram 块时，移除后回落到块头注释，避免把文件写成空行
  if (rest.every((line) => line.trim() === '')) rest = BLOCK_HEADER.split('\n');
  writeConfigLines(configPath, rest, eol);
}
