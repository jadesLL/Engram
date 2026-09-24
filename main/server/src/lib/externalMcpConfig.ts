import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ExternalMcpTarget = 'workbuddy' | 'qoder';

/**
 * 外部客户端用户级 MCP 配置的读写。
 *
 * 这些客户端按产品变体（国内版 / 海外版）切换配置目录，目录名不同，写错位置客户端
 * 根本不读——「一键接入显示成功但没效果」就是这么来的：
 *
 * - WorkBuddy：国内版 `~/.workbuddy`，海外版 `~/.workbuddy-ai`。客户端自身按
 *   `WORKBUDDY_CONFIG_DIR` → `CODEBUDDY_CONFIG_DIR` → `~/.workbuddy` 解析配置目录，
 *   海外版由启动器把 `WORKBUDDY_CONFIG_DIR` 指到 `~/.workbuddy-ai`。
 * - Qoder：国际版 `~/.qoder`（`QODER_CONFIG_DIR`），国内版 `~/.qoder-cn`
 *   （`QODERCN_CONFIG_DIR`）。同一台机器可能两个都装了，而 Engram 看不到用户实际启动
 *   哪一个，所以存在的变体目录全部维护。
 *
 * 配置文件位置与格式不变：WorkBuddy 是 `<配置目录>/mcp.json`，Qoder 是
 * `<配置目录>/settings.json`，都在顶层 `mcpServers` 下维护一条 `engram`，其余键原样保留。
 */

const CONFIG_FILE: Record<ExternalMcpTarget, string> = {
  workbuddy: 'mcp.json',
  qoder: 'settings.json',
};

/** 未检测到客户端时，界面回显用的默认配置目录 */
const DEFAULT_DIR: Record<ExternalMcpTarget, string> = {
  workbuddy: '.workbuddy',
  qoder: '.qoder',
};

function firstEnv(names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
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

/**
 * 目录里除 Engram 自己写的那份配置外还有别的东西吗？
 *
 * 用来判断客户端是否真的装过：客户端首次运行会写下 settings.json、日志、缓存等，
 * 而 Engram 的早期版本可能在客户端并不存在时凭 `mkdirSync` 造出一个只有配置文件的目录，
 * 那不该被当成「已安装」，否则注册会继续写进一个没人读的地方。
 */
function hasClientData(dir: string, configFile: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name !== configFile);
  } catch {
    return false;
  }
}

/** WorkBuddy 要维护的配置目录：环境变量优先（海外版靠它），否则按客户端自身的回退顺序 */
function workbuddyDirs(home: string): string[] {
  const fromEnv = firstEnv(['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR']);
  if (fromEnv) return [fromEnv];
  return [path.join(home, '.workbuddy'), path.join(home, '.workbuddy-ai')]
    .filter((dir) => isDir(dir) && hasClientData(dir, CONFIG_FILE.workbuddy));
}

/** Qoder 要维护的配置目录：环境变量指定哪个就只管哪个，否则国内版 / 国际版存在的都写 */
function qoderDirs(home: string): string[] {
  const fromEnv = [firstEnv(['QODER_CONFIG_DIR']), firstEnv(['QODERCN_CONFIG_DIR'])]
    .filter((dir): dir is string => Boolean(dir));
  if (fromEnv.length) return [...new Set(fromEnv)];
  return [path.join(home, '.qoder'), path.join(home, '.qoder-cn')]
    .filter((dir) => isDir(dir) && hasClientData(dir, CONFIG_FILE.qoder));
}

/** 需要维护的全部配置文件；返回空数组表示本机没检测到该客户端 */
export function externalMcpConfigPaths(target: ExternalMcpTarget, home = os.homedir()): string[] {
  const dirs = target === 'workbuddy' ? workbuddyDirs(home) : qoderDirs(home);
  return dirs.map((dir) => path.join(dir, CONFIG_FILE[target]));
}

export function externalMcpInstalled(target: ExternalMcpTarget, home = os.homedir()): boolean {
  return externalMcpConfigPaths(target, home).length > 0;
}

/** 首个（主）配置文件；未检测到客户端时回落到该客户端的默认路径，供界面提示 */
export function externalMcpConfigPath(target: ExternalMcpTarget, home = os.homedir()): string {
  return externalMcpConfigPaths(target, home)[0]
    ?? path.join(home, DEFAULT_DIR[target], CONFIG_FILE[target]);
}

function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置文件根节点必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function servers(config: Record<string, unknown>): Record<string, unknown> {
  const value = config.mcpServers;
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcpServers 必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function writeConfig(file: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.engram-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** 读坏或写不动的配置文件不该让状态接口整体失败，按「未注册」处理 */
function registeredIn(file: string): boolean {
  try {
    return Object.hasOwn(servers(readConfig(file)), 'engram');
  } catch {
    return false;
  }
}

export function externalMcpStatus(target: ExternalMcpTarget, home = os.homedir()) {
  const configPaths = externalMcpConfigPaths(target, home);
  return {
    installed: configPaths.length > 0,
    registered: configPaths.some(registeredIn),
    configPath: configPaths[0] ?? externalMcpConfigPath(target, home),
    configPaths,
  };
}

/**
 * 清掉早期版本写错位置的 WorkBuddy 配置。
 *
 * 旧实现固定写 `~/.workbuddy-ai/mcp.json`（海外版目录），国内版客户端从不读它。
 * 仅当该文件不在本次维护范围内、且所在目录除这份配置外空无一物（确实是 Engram
 * 留下的空壳，而不是真装了海外版）时才动手；清完为空则连目录一起收掉。
 */
function cleanupLegacyWorkbuddy(home: string, activePaths: string[]): void {
  const legacyDir = path.join(home, '.workbuddy-ai');
  const legacyFile = path.join(legacyDir, CONFIG_FILE.workbuddy);
  if (activePaths.includes(legacyFile)) return;
  if (!fs.existsSync(legacyFile)) return;
  if (hasClientData(legacyDir, CONFIG_FILE.workbuddy)) return;
  try {
    const config = readConfig(legacyFile);
    const mcpServers = servers(config);
    if (!Object.hasOwn(mcpServers, 'engram')) return;
    delete mcpServers.engram;
    config.mcpServers = mcpServers;
    if (Object.keys(mcpServers).length > 0) {
      writeConfig(legacyFile, config); // 还有别的 server，保留文件
      return;
    }
    fs.unlinkSync(legacyFile);
    if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
  } catch {
    // 遗留清理属于顺带收尾，失败不影响本次注册结果
  }
}

/** 写入全部变体目录，返回实际写入的文件；失败的文件名随异常抛出，避免静默漏写 */
export function registerExternalMcp(target: ExternalMcpTarget, url: string, token: string, home = os.homedir()): string[] {
  const configPaths = externalMcpConfigPaths(target, home);
  if (!configPaths.length) throw new Error('未检测到目标客户端');
  const failures: string[] = [];
  for (const configPath of configPaths) {
    try {
      const config = readConfig(configPath);
      config.mcpServers = {
        ...servers(config),
        engram: {
          type: target === 'workbuddy' ? 'streamableHttp' : 'http',
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      };
      writeConfig(configPath, config);
    } catch (e: any) {
      failures.push(`${configPath}（${e?.message ?? '写入失败'}）`);
    }
  }
  if (target === 'workbuddy') cleanupLegacyWorkbuddy(home, configPaths);
  if (failures.length === configPaths.length) throw new Error(`写入失败：${failures.join('；')}`);
  if (failures.length) throw new Error(`部分写入失败（其余变体已注册）：${failures.join('；')}`);
  return configPaths;
}

/** 移除全部变体目录里的 engram 条目；单个文件读坏或写不动时继续处理其余变体 */
export function unregisterExternalMcp(target: ExternalMcpTarget, home = os.homedir()): string[] {
  const configPaths = externalMcpConfigPaths(target, home);
  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = readConfig(configPath);
      const mcpServers = servers(config);
      if (!Object.hasOwn(mcpServers, 'engram')) continue;
      delete mcpServers.engram;
      config.mcpServers = mcpServers;
      writeConfig(configPath, config);
    } catch {
      // 忽略单个变体的读写异常，继续清理其余变体
    }
  }
  if (target === 'workbuddy') cleanupLegacyWorkbuddy(home, configPaths);
  return configPaths;
}
