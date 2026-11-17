import fs from 'node:fs';

/**
 * dsh 凭据文件（<DSH_HOME>/.credentials.yaml，dsh-credentials-local 的格式）的只读解析。
 *
 * 为什么单独成模块：这份文件同时装两类内容——
 *   - `records:` 下的运行期授权（例如控制台启动时写入的 `client-connection/browser-session`）；
 *   - `refs:` 下用户配置的 API Key（`DEEPSEEK_API_KEY: sk-…`）。
 * 「有没有配模型 Key」只能看 refs；把整份文件里任意 key: value 都当成 Key（旧口径）会在
 * 控制台一启动后就误判为「已配置」。
 *
 * 兼容两种写法：
 *   refs:
 *     {
 *       DASHSCOPE_API_KEY: 'sk-xxx',
 *     }
 * 以及块状 map（refs: 下按 KEY: value 缩进）。值只用于发请求与判定，绝不回显给前端。
 */

/** 行首缩进宽度 */
export function indentOf(line: string): number {
  const match = /^\s*/.exec(line);
  return match ? match[0].length : 0;
}

/** 去掉 YAML 标量两侧的引号（单引号里的 '' 是一个单引号；双引号做常见转义还原） */
export function unquoteScalar(raw: string): string {
  const value = raw.trim().replace(/\s+#.*$/, '');
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return value;
}

/** 解析凭据文件的 `refs:` 映射（只返回非空值） */
export function parseCredentialRefs(text: string): Record<string, string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^refs:\s*(#.*)?$/.test(lines[index].trim())) continue;
    let flow = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '{') {
        flow = true;
        continue;
      }
      if (trimmed === '}' || trimmed === '},') {
        flow = false;
        index = cursor;
        break;
      }
      if (!flow && indentOf(line) === 0) {
        index = cursor - 1;
        break;
      }
      const match = /^(?:-\s*)?"?([A-Za-z0-9_./-]+)"?\s*:\s*(.+?)\s*,?\s*$/.exec(trimmed);
      if (!match) continue;
      const value = unquoteScalar(match[2]);
      if (value) out[match[1]] = value;
    }
  }
  return out;
}

/** 凭据文件里是否有任意一个真实的 ref（= 用户填过模型 Key）；records 里的授权不算 */
export function hasCredentialRefs(text: string): boolean {
  return Object.keys(parseCredentialRefs(text)).length > 0;
}

/** 读文件后判定；文件不存在/读失败一律按「没有 Key」 */
export function credentialsFileHasRefs(file: string): boolean {
  try {
    return hasCredentialRefs(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}
