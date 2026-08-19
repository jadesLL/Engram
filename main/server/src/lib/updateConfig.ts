import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * 应用内自更新配置，统一存放在数据目录的 .env 文件（Docker 内 /data/.env，
 * 随数据卷持久化、容器重建不丢、不进代码库）。
 * 写入时保留文件中其他无关行，只增改本模块持有的键。
 *
 * 键说明：
 *  - UPDATE_IMAGE_REF          镜像更新源（不含 tag 的镜像地址），缺省从当前容器镜像推导
 *  - UPDATE_REGISTRY_USERNAME  私有 Registry 用户名
 *  - UPDATE_REGISTRY_TOKEN     私有 Registry 令牌
 *  - UPDATE_GITEA_URL          Gitea 服务地址（版本检测用，可空）
 *  - UPDATE_GITEA_REPO         Gitea 仓库 owner/name（版本检测用，可空）
 *  - UPDATE_GITEA_TOKEN        Gitea API 令牌（公开仓库可留空）
 */
export const UPDATE_ENV_FILE = path.join(DATA_DIR, '.env');

export const UPDATE_ENV_KEYS = {
  imageRef: 'UPDATE_IMAGE_REF',
  registryUsername: 'UPDATE_REGISTRY_USERNAME',
  registryToken: 'UPDATE_REGISTRY_TOKEN',
  giteaUrl: 'UPDATE_GITEA_URL',
  giteaRepo: 'UPDATE_GITEA_REPO',
  giteaToken: 'UPDATE_GITEA_TOKEN',
} as const;

export interface UpdateEnv {
  imageRef: string;
  registryUsername: string;
  registryToken: string;
  giteaUrl: string;
  giteaRepo: string;
  giteaToken: string;
}

/** 解析 .env 文本（KEY=VALUE，容忍引号与注释行） */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 读配置；文件不存在或键缺失时返回空字符串 */
export function readUpdateEnv(): UpdateEnv {
  let parsed: Record<string, string> = {};
  try {
    parsed = parseEnv(fs.readFileSync(UPDATE_ENV_FILE, 'utf8'));
  } catch {
    /* 文件不存在视为未配置 */
  }
  return {
    imageRef: parsed[UPDATE_ENV_KEYS.imageRef] || '',
    registryUsername: parsed[UPDATE_ENV_KEYS.registryUsername] || '',
    registryToken: parsed[UPDATE_ENV_KEYS.registryToken] || '',
    giteaUrl: parsed[UPDATE_ENV_KEYS.giteaUrl] || '',
    giteaRepo: parsed[UPDATE_ENV_KEYS.giteaRepo] || '',
    giteaToken: parsed[UPDATE_ENV_KEYS.giteaToken] || '',
  };
}

/**
 * 保留式写入：只替换本模块的键，其余行原样保留。
 * patch 中 undefined 表示保持不变，空串表示清除该键。
 */
export function writeUpdateEnv(patch: Partial<UpdateEnv>): UpdateEnv {
  const lines = (() => {
    try {
      return fs.readFileSync(UPDATE_ENV_FILE, 'utf8').split(/\r?\n/);
    } catch {
      return [];
    }
  })();

  const keyToValue: Record<string, string> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    keyToValue[UPDATE_ENV_KEYS[field as keyof typeof UPDATE_ENV_KEYS]] = value;
  }

  const managed = new Set(Object.values(UPDATE_ENV_KEYS));
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0 && managed.has(trimmed.slice(0, eq).trim())) {
      const key = trimmed.slice(0, eq).trim();
      if (key in keyToValue) {
        seen.add(key);
        const value = keyToValue[key];
        if (value) kept.push(`${key}=${value}`);
        // 空值 → 删除该行
      } else {
        kept.push(line);
      }
    } else if (trimmed !== '' || kept.length) {
      // 保留空行与无关行（开头连续空行丢弃，避免文件越来越长）
      kept.push(line);
    }
  }
  for (const [key, value] of Object.entries(keyToValue)) {
    if (!seen.has(key) && value) kept.push(`${key}=${value}`);
  }

  let content = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
  if (!content.trim()) content = '';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(UPDATE_ENV_FILE, content, 'utf8');
  return readUpdateEnv();
}

/**
 * 从当前运行容器的镜像 ref 推导默认更新源：
 * `registry/repo:tag` → `registry/repo`（tag 固定用 latest 跟踪发版线）。
 * 本地构建镜像（如 example-wiki:1.1.5，无 registry 前缀）无法推导，返回 null。
 */
export function deriveDefaultImageRef(currentImage: string): string | null {
  const ref = currentImage.split('@')[0];
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  // 冒号在最后一个斜杠之后才是 tag；否则（如 registry:5000/repo）无 tag
  if (lastColon > lastSlash) {
    return ref.slice(0, lastColon) || null;
  }
  return ref.includes('/') ? ref : null;
}

/**
 * 构造 Docker Engine API 的 X-Registry-Auth 头：
 * base64(JSON({username, password, serveraddress}))，由 dockerd 向 registry 认证。
 */
export function buildRegistryAuthHeader(imageRef: string, username: string, token: string): string | undefined {
  if (!username || !token) return undefined;
  // imageRef 形如 registryhost[:port]/path → serveraddress 取 host 部分
  const firstSlash = imageRef.indexOf('/');
  const host = firstSlash > 0 ? imageRef.slice(0, firstSlash) : imageRef;
  return Buffer.from(
    JSON.stringify({ username, password: token, serveraddress: host }),
    'utf8',
  ).toString('base64');
}
