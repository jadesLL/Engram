import fs from 'node:fs';

/**
 * 当前运行版本：
 *  - Docker 镜像：构建期写入的 /app/VERSION
 *  - 桌面端：Electron 主进程 fork 时经 ENGRAM_APP_VERSION 注入
 *  - 开发环境：'dev'，前端 fallback 到编译期 APP_VERSION
 */
export function currentVersion(): string {
  const fromEnv = process.env.ENGRAM_APP_VERSION;
  if (fromEnv) return fromEnv;
  try {
    const v = fs.readFileSync('/app/VERSION', 'utf8').trim();
    return v || 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * 语义化版本比较（'v' 前缀容忍、非数字段按 0 处理）。
 * 返回 >0 表示 a 更新，0 表示相同，<0 表示 b 更新。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((seg) => {
        const m = seg.match(/\d+/);
        return m ? Number(m[0]) : 0;
      });
  const pa = parse(a || '0');
  const pb = parse(b || '0');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
