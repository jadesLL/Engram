// 版本号读写：desktop/package.json、web/src/version.ts、docker-compose.yml 三处单源。
// 零第三方依赖，只用 node: 内置模块（Node >= 20）。
import fs from 'node:fs';
import path from 'node:path';

/** 三处版本号来源（路径相对 main 根）。 */
export const VERSION_SOURCES = [
  { id: 'desktop', file: 'desktop/package.json', kind: 'json' },
  { id: 'web', file: 'web/src/version.ts', kind: 'regex' },
  { id: 'compose', file: 'docker-compose.yml', kind: 'regex' },
];

/** web/src/version.ts 的版本号写法。 */
const WEB_VERSION_RE = /APP_VERSION\s*=\s*'([^']+)'/;
/** docker-compose.yml 里本地镜像 tag（只认 image: engram:<tag>，改镜像仓库不参与版本一致性）。 */
const COMPOSE_VERSION_RE = /^(\s*image:\s*engram:)(\S+)(\s*)$/m;
/** package.json 顶层 version 字段（取第一个 "version" 键，依赖列表里的字段名不会是 version）。 */
const JSON_VERSION_RE = /("version"\s*:\s*")([^"]*)(")/;

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * 从一份版本来源文件文本里取出版本号；取不到返回 null。
 * @param {{kind: string}} source
 * @param {string} text
 */
function extractVersion(source, text) {
  if (source.kind === 'json') {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { version: null, error: `JSON 解析失败：${err.message}` };
    }
    if (typeof data.version !== 'string' || !data.version) {
      return { version: null, error: '缺少顶层 version 字段' };
    }
    return { version: data.version, error: null };
  }
  if (source.id === 'web') {
    const m = WEB_VERSION_RE.exec(text);
    if (!m) return { version: null, error: "找不到 APP_VERSION = '…' 写法" };
    return { version: m[1], error: null };
  }
  if (source.id === 'compose') {
    const m = COMPOSE_VERSION_RE.exec(text);
    if (!m) return { version: null, error: '找不到 image: engram:<版本> 行' };
    return { version: m[2], error: null };
  }
  return { version: null, error: `未知来源类型：${source.id}` };
}

/**
 * 读三处版本号。
 * @param {string} repoDir main 根目录
 * @returns {{version: string|null, sources: Array<{id: string, file: string, version: string|null, ok: boolean, error?: string}>, consistent: boolean}}
 */
export function readVersions(repoDir) {
  const sources = VERSION_SOURCES.map((source) => {
    const filePath = path.join(repoDir, source.file);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return { id: source.id, file: source.file, version: null, ok: false, error: `读取失败：${err.code || err.message}` };
    }
    const { version, error } = extractVersion(source, text);
    if (error) return { id: source.id, file: source.file, version: null, ok: false, error };
    return { id: source.id, file: source.file, version, ok: true };
  });

  const primary = sources.find((source) => source.ok) || null;
  const version = primary ? primary.version : null;
  const consistent = Boolean(primary) && sources.every((source) => source.ok && source.version === version);
  return { version, sources, consistent };
}

/** 把某个来源文件文本里的版本号替换成 newVersion（只做最小替换，不重排格式）。 */
function replaceVersion(source, text, newVersion) {
  if (source.kind === 'json') {
    if (!JSON_VERSION_RE.test(text)) return null;
    return text.replace(JSON_VERSION_RE, (_m, before, _old, after) => before + newVersion + after);
  }
  if (source.id === 'web') {
    if (!WEB_VERSION_RE.test(text)) return null;
    return text.replace(WEB_VERSION_RE, (_m) => `APP_VERSION = '${newVersion}'`);
  }
  if (source.id === 'compose') {
    if (!COMPOSE_VERSION_RE.test(text)) return null;
    return text.replace(COMPOSE_VERSION_RE, (_m, before, _old, after) => before + newVersion + after);
  }
  return null;
}

/**
 * 写三处版本号并立即回读校验；任何一处定位失败或回读不一致都会抛错。
 * @param {string} repoDir main 根目录
 * @param {string} newVersion 形如 1.5.11（可带 v 前缀）
 * @returns {Array<{id: string, file: string, from: string, to: string}>}
 */
export function writeVersions(repoDir, newVersion) {
  const parsed = parseSemver(newVersion);
  if (!parsed) throw new Error(`目标版本号不合法：${newVersion}`);
  const target = formatSemver(parsed);

  const changes = [];
  const planned = [];
  for (const source of VERSION_SOURCES) {
    const filePath = path.join(repoDir, source.file);
    const text = fs.readFileSync(filePath, 'utf8');
    const { version: from, error } = extractVersion(source, text);
    if (error) throw new Error(`${source.file}：${error}`);
    const nextText = replaceVersion(source, text, target);
    if (nextText === null) throw new Error(`${source.file}：无法定位版本号位置，未写入`);
    planned.push({ source, filePath, from, nextText });
    changes.push({ id: source.id, file: source.file, from, to: target });
  }
  for (const item of planned) {
    fs.writeFileSync(item.filePath, item.nextText, 'utf8');
  }

  const reread = readVersions(repoDir);
  const bad = reread.sources.filter((source) => !source.ok || source.version !== target);
  if (bad.length > 0) {
    throw new Error(
      `写入后回读校验失败：${bad.map((source) => `${source.file}=${source.version ?? source.error}`).join('，')}`,
    );
  }
  return changes;
}

/**
 * 解析 semver（允许可选 v 前缀与 +build 元数据）。
 * @param {string} text
 * @returns {{major: number, minor: number, patch: number, prerelease: string|null}|null}
 */
export function parseSemver(text) {
  if (typeof text !== 'string') return null;
  const m = SEMVER_RE.exec(text.trim());
  if (!m) return null;
  const prerelease = m[4] ? m[4] : null;
  if (prerelease !== null) {
    const ids = prerelease.split('.');
    if (ids.some((id) => id === '')) return null;
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/** 把 parseSemver 的结果格式化回字符串（不含 v 前缀）。 */
export function formatSemver(parts) {
  if (!parts || typeof parts !== 'object') throw new TypeError('formatSemver 需要 { major, minor, patch, prerelease }');
  const base = `${parts.major}.${parts.minor}.${parts.patch}`;
  return parts.prerelease ? `${base}-${parts.prerelease}` : base;
}

/** semver prerelease 比较；返回 -1 / 0 / 1。 */
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xNumeric) {
      return -1;
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 比较两个 semver 字符串（允许 v 前缀）；返回 -1 / 0 / 1。
 * @param {string} a
 * @param {string} b
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`不合法版本号：${a}`);
  if (!pb) throw new Error(`不合法版本号：${b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * 计算下一个版本。
 * request 为 major|minor|patch 时按段递增并清空 prerelease；否则必须是显式版本且大于 current。
 * @param {string} current
 * @param {string} request
 * @returns {string}
 */
export function nextVersion(current, request) {
  const cur = parseSemver(current);
  if (!cur) throw new Error(`当前版本号不合法：${current}`);
  const keyword = typeof request === 'string' ? request.trim() : '';
  if (keyword === 'major' || keyword === 'minor' || keyword === 'patch') {
    if (keyword === 'major') return formatSemver({ major: cur.major + 1, minor: 0, patch: 0, prerelease: null });
    if (keyword === 'minor') return formatSemver({ major: cur.major, minor: cur.minor + 1, patch: 0, prerelease: null });
    return formatSemver({ major: cur.major, minor: cur.minor, patch: cur.patch + 1, prerelease: null });
  }
  const target = parseSemver(request);
  if (!target) throw new Error(`版本参数无效：${request}（只支持 major|minor|patch 或显式 x.y.z）`);
  const targetText = formatSemver(target);
  if (compareSemver(targetText, current) <= 0) {
    throw new Error(`目标版本必须大于当前版本（当前 ${formatSemver(cur)}，目标 ${targetText}）`);
  }
  return targetText;
}

/**
 * 解析 CLI 用的 main 根目录：优先显式 --repo；否则当前目录，再退一级找 main/。
 * 两者都没有 desktop/package.json 时抛错（由调用方转成 [FAIL] + 退出码 1）。
 * @param {string|undefined|null} explicit
 * @returns {string}
 */
export function resolveMainDir(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!fs.existsSync(path.join(dir, 'desktop', 'package.json'))) {
      const err = new Error(`--repo 指向的目录不是 main 根（缺少 desktop/package.json）：${dir}`);
      err.exitCode = 2;
      throw err;
    }
    return dir;
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'desktop', 'package.json'))) return cwd;
  const nested = path.join(cwd, 'main');
  if (fs.existsSync(path.join(nested, 'desktop', 'package.json'))) return nested;
  throw new Error(`当前工作目录不是 main 根（缺少 desktop/package.json）：${cwd}；可加 --repo <mainDir> 指定`);
}
