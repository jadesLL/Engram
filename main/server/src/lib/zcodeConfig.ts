import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ZCode 桌面端自带引擎的探测（Agent 接入检测用）。
 *
 * MCP 时代这里还有 cli/config.json 的 MCP 注册与 zcodeMcpUrl；接入改为 CLI + skill 后
 * 注册不再写客户端配置，只保留「本机是否装了 ZCode」这一件事（见 lib/agentAccess.ts）。
 * 不依赖数据库：设置页的 zcode_config 仍可经 /api/settings 原样存取（旧客户端兼容），
 * 但服务端不再解析它做 MCP 注册。
 *
 * 候选位置：C 盘默认目录（per-machine 与 per-user）优先，再扫 D..Z 盘符的常见安装目录
 * （用户可能装到非 C 盘）。
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
