import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ExternalMcpTarget = 'workbuddy' | 'qoder';

export function externalMcpConfigPath(target: ExternalMcpTarget, home = os.homedir()): string {
  return target === 'workbuddy'
    ? path.join(home, '.workbuddy-ai', 'mcp.json')
    : path.join(process.env.QODER_CONFIG_DIR || path.join(home, '.qoder'), 'settings.json');
}

export function externalMcpInstalled(target: ExternalMcpTarget, home = os.homedir()): boolean {
  if (target === 'workbuddy') return fs.existsSync(path.join(home, '.workbuddy'));
  return fs.existsSync(path.join(home, '.qoder')) || fs.existsSync(path.join(home, '.qoder-cn'));
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

export function externalMcpStatus(target: ExternalMcpTarget, home = os.homedir()) {
  const configPath = externalMcpConfigPath(target, home);
  const config = readConfig(configPath);
  return {
    installed: externalMcpInstalled(target, home),
    registered: Boolean(servers(config).engram),
    configPath,
  };
}

export function registerExternalMcp(target: ExternalMcpTarget, url: string, token: string, home = os.homedir()): string {
  if (!externalMcpInstalled(target, home)) throw new Error('未检测到目标客户端');
  const configPath = externalMcpConfigPath(target, home);
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
  return configPath;
}

export function unregisterExternalMcp(target: ExternalMcpTarget, home = os.homedir()): void {
  const configPath = externalMcpConfigPath(target, home);
  if (!fs.existsSync(configPath)) return;
  const config = readConfig(configPath);
  const mcpServers = servers(config);
  if (!Object.hasOwn(mcpServers, 'engram')) return;
  delete mcpServers.engram;
  config.mcpServers = mcpServers;
  writeConfig(configPath, config);
}
