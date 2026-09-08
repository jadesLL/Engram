import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { PORT } from '../config.js';

const CONFIG_PATH = path.join(os.homedir(), '.engram', 'config.json');

/**
 * CLI 零配置：服务端启动时把本机地址与专用 token 登记到 ~/.engram/config.json，
 * 外部 Agent 跑 engram CLI 无需手动 login。地址由 PORT 环境变量决定（桌面版 fork
 * 时注入实际监听端口，含回退端口；Docker 版为容器内值），代码不写死任何地址。
 * 仅覆盖自己登记的（source=server）或空配置；用户手动 `engram login` 保存的显式
 * 选择（无 source 字段）优先，不被启动覆盖。Docker 远程场景写入落在容器内文件
 * 系统、到不了宿主机 home，失败静默跳过——该场景仍由用户手动 login 登记远程地址。
 */
export function autoRegisterCliConfig(): void {
  try {
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 新建 */ }
    if (existing.url && existing.source !== 'server') return;
    let token = (db.prepare(`SELECT token FROM mcp_tokens WHERE name = 'cli'`).get() as { token?: string })?.token;
    if (!token) {
      token = `lwiki_${crypto.randomBytes(24).toString('hex')}`;
      db.prepare(`INSERT INTO mcp_tokens(token, name, created_at) VALUES(?, ?, ?)`)
        .run(token, 'cli', now());
    }
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      url: `http://127.0.0.1:${PORT}`,
      token,
      allowPrivate: true,
      source: 'server',
    }, null, 2));
  } catch { /* 无宿主 home（容器）或权限不足：跳过，CLI 走手动 login */ }
}
