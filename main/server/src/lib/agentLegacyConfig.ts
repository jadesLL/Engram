import fs from 'node:fs';
import path from 'node:path';
import { cleanupLegacyMcpPatches } from '../assistant/agentPatch.js';
import { removeAgentSkills } from './agentSkill.js';
import type { AgentClientId } from './agentAccess.js';

/**
 * 旧版本写入的 Engram 客户端配置清理（MCP 时代遗留）。
 *
 * MCP 端点已删除（不再有 /mcp 与服务端 MCP SDK），旧版本曾往这些位置写 Engram MCP 条目；
 * 条目留着只会让客户端反复连一个不存在的端点。一键接入 / 移除接入时顺带清掉，规则是
 * **只删本方写入的内容**：
 *
 * - Codex：`$CODEX_HOME/config.toml` 的 `[mcp_servers.engram]` 表（含紧邻的本方注释），其余表与注释逐字保留；
 * - dsh：`$DSH_HOME/cordis.patch.yml` 的 mcp-engram 条目（沿用 assistant/agentPatch 的清理逻辑）；
 * - WorkBuddy：`<配置目录>/mcp.json` 顶层 `mcpServers.engram`；
 * - Qoder：`<配置目录>/settings.json`（国际版 ~/.qoder、国内版 ~/.qoder-cn 都清）；
 * - Kimi Code：`<KIMI_CODE_HOME>/mcp.json`。
 *
 * 另外清两处**写错目录**的旧 skill：WorkBuddy 旧版写进 `~/.codebuddy/skills`、
 * Codex 旧版写进 `$CODEX_HOME/skills`——只删带 engram-managed 标记的文件，用户自己的同名 skill 不动。
 *
 * 全部属于顺带收尾：读不到 / 写不动 / JSON 坏了都静默跳过，不影响本次接入结果。
 */

function envValue(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const CODEX_HEADER_RE = /^\[mcp_servers\.engram\][ \t]*$/;
const TOML_TABLE_RE = /^\s*\[/;
/** 块上方紧邻的 Engram 注释行（旧版本写入的块头），一并删除；用户自己的注释不碰 */
const ENGRAM_COMMENT_RE = /engram|mcp__engram__/i;

/** 删掉 Codex config.toml 里的 [mcp_servers.engram] 块；其余内容逐字保留 */
function removeCodexEngramBlock(file: string, cleaned: string[]): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return;
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const header = lines.findIndex((line) => CODEX_HEADER_RE.test(line));
  if (header < 0) return;
  let start = header;
  while (start > 0 && /^\s*#/.test(lines[start - 1]) && ENGRAM_COMMENT_RE.test(lines[start - 1])) start--;
  let end = header + 1;
  while (end < lines.length && !TOML_TABLE_RE.test(lines[end])) end++;
  while (end - 1 > start && lines[end - 1].trim() === '') end--;
  lines.splice(start, end - start);
  const text = lines.join(eol).replace(/(\r?\n){3,}/g, eol + eol).replace(/\s+$/, '');
  try {
    if (!text.trim()) {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, text + eol, 'utf8');
    }
    cleaned.push(file);
  } catch {
    /* 写不动就下次再试 */
  }
}

/** 删掉 JSON 配置顶层 mcpServers.engram；其他 server 与键原样保留 */
function removeJsonMcpEntry(file: string, cleaned: string[]): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let config: unknown;
  try {
    config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return; // JSON 坏了不动用户的文件
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  const root = config as Record<string, unknown>;
  const servers = root.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return;
  const table = servers as Record<string, unknown>;
  if (!Object.hasOwn(table, 'engram')) return;
  delete table.engram;
  if (Object.keys(table).length > 0) root.mcpServers = table;
  else delete root.mcpServers;
  try {
    fs.writeFileSync(file, JSON.stringify(root, null, 2) + '\n', { mode: 0o600 });
    cleaned.push(file);
  } catch {
    /* 写不动就下次再试 */
  }
}

/** 清掉某目录里旧版本写错位置的管理 skill（只删带 engram-managed 标记的两份） */
function removeLegacyManagedSkills(root: string, cleaned: string[]): void {
  try {
    cleaned.push(...removeAgentSkills(root));
  } catch {
    /* 目录不可读 / 不可写：跳过 */
  }
}

/**
 * 清理一个客户端旧版本写入的 Engram 配置，返回被清理的文件路径（供接入结果回执）。
 * 幂等：没有遗留时返回空数组。
 */
export function cleanupLegacyAgentConfig(
  id: AgentClientId,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const cleaned: string[] = [];
  switch (id) {
    case 'codex': {
      const codexHome = envValue(env, ['CODEX_HOME']) || path.join(home, '.codex');
      removeCodexEngramBlock(path.join(codexHome, 'config.toml'), cleaned);
      // 旧 MCP 时代的客户调研 skill 曾装进 $CODEX_HOME/skills；新根是 ~/.agents/skills
      removeLegacyManagedSkills(path.join(codexHome, 'skills'), cleaned);
      break;
    }
    case 'dsh': {
      const dshHome = envValue(env, ['DSH_HOME']) || path.join(home, '.dsh');
      const result = cleanupLegacyMcpPatches(dshHome);
      if (result.removedAgentPatch) cleaned.push(path.join(dshHome, 'engram.cordis.yml'));
      if (result.cleanedHomePatch) cleaned.push(path.join(dshHome, 'cordis.patch.yml'));
      break;
    }
    case 'workbuddy': {
      const fromEnv = [envValue(env, ['WORKBUDDY_CONFIG_DIR']), envValue(env, ['CODEBUDDY_CONFIG_DIR'])]
        .filter((dir): dir is string => Boolean(dir));
      const dirs = fromEnv.length
        ? [...new Set(fromEnv)]
        : [path.join(home, '.workbuddy'), path.join(home, '.workbuddy-ai')].filter(isDir);
      for (const dir of dirs) removeJsonMcpEntry(path.join(dir, 'mcp.json'), cleaned);
      // 旧版本把 skill 写进 ~/.codebuddy/skills
      removeLegacyManagedSkills(path.join(home, '.codebuddy', 'skills'), cleaned);
      break;
    }
    case 'qoder': {
      const fromEnv = [envValue(env, ['QODER_CONFIG_DIR']), envValue(env, ['QODERCN_CONFIG_DIR'])]
        .filter((dir): dir is string => Boolean(dir));
      const dirs = fromEnv.length
        ? [...new Set(fromEnv)]
        : [path.join(home, '.qoder'), path.join(home, '.qoder-cn')].filter(isDir);
      for (const dir of dirs) removeJsonMcpEntry(path.join(dir, 'settings.json'), cleaned);
      break;
    }
    case 'kimi-code': {
      const dir = envValue(env, ['KIMI_CODE_HOME']) || path.join(home, '.kimi-code');
      removeJsonMcpEntry(path.join(dir, 'mcp.json'), cleaned);
      break;
    }
    default:
      // claude / zcode 旧版本没有写入过 Engram MCP 配置
      break;
  }
  return cleaned;
}
