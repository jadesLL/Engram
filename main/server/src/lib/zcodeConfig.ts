import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSetting } from './db.js';
import { PORT } from '../config.js';

export interface ZcodeConfig {
  enabled: boolean;
  mode: 'plan' | 'yolo';
  path: string;
}

/**
 * ZCode 桌面端自带引擎的候选位置：C 盘默认目录（per-machine 与 per-user）优先，
 * 再扫 D..Z 盘符的常见安装目录（用户可能装到非 C 盘）。手动指定路径优先于所有候选。
 */
export function zcodeEngineCandidates(): string[] {
  const rel = ['resources', 'glm', 'zcode.cjs'];
  const roots = [
    'C:\\Program Files\\ZCode',
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Programs', 'ZCode',
    ),
  ];
  for (let code = 'D'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (!fs.existsSync(drive)) continue;
    roots.push(`${drive}ZCode`, `${drive}Program Files\\ZCode`, `${drive}Program Files (x86)\\ZCode`);
  }
  return roots.map((r) => path.join(r, ...rel));
}
const SETTING_KEY = 'zcode_config';

export function getZcodeConfig(): ZcodeConfig {
  const raw = getSetting(SETTING_KEY);
  let parsed: any = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* 坏配置回退默认 */ }
  return {
    enabled: parsed.enabled === true,
    mode: parsed.mode === 'yolo' ? 'yolo' : 'plan',
    path: typeof parsed.path === 'string' ? parsed.path.trim() : '',
  };
}

export function zcodeInstalled(
  config: ZcodeConfig = getZcodeConfig(),
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): boolean {
  if (config.path) return exists(config.path);
  return zcodeEngineCandidates().some(exists);
}

/** ZCode 安装路径：用户显式填写的优先；未填写时取第一个存在的候选 */
export function resolveZcodeEnginePath(
  config: ZcodeConfig = getZcodeConfig(),
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string {
  if (config.path) return config.path;
  const candidates = zcodeEngineCandidates();
  return candidates.find(exists) || candidates[0];
}

/** ZCode 检测/注册用：cli/config.json 路径与 MCP 注册地址 */
export function zcodeCliConfigPath(): string {
  return path.join(os.homedir(), '.zcode', 'cli', 'config.json');
}

export const zcodeMcpUrl = `http://127.0.0.1:${PORT}/mcp`;
