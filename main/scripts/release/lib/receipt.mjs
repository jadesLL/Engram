// 发布收据（releases/<ver>/release.json）的构造校验与 sha256 工具。
import crypto from 'node:crypto';
import fs from 'node:fs';

export const RECEIPT_SCHEMA_VERSION = 1;
/** 收据里允许的产物类型。 */
export const ARTIFACT_KINDS = ['exe', 'apk', 'tar.gz', 'other'];

const SHA256_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 计算文件 sha256（小写十六进制）。 */
export function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 校验 YYYY-MM-DD 是否为合法日历日期。 */
export function isValidDateString(text) {
  if (typeof text !== 'string' || !DATE_RE.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 统一的产物文件名（sha256sum 输出里可能带 ./ 或 * 前缀）。 */
export function normalizeArtifactName(name) {
  return String(name)
    .trim()
    .replace(/^\*/, '')
    .replace(/^\.\//, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop();
}

/**
 * 解析 sha256 校验文件（兼容 "<hex>  file"、"<hex> *./file" 两种 sha256sum 输出）。
 * @returns {Array<{name: string, sha256: string}>}
 */
export function parseSha256File(text) {
  const records = [];
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(trimmed);
    if (!m) continue;
    records.push({ name: normalizeArtifactName(m[2]), sha256: m[1].toLowerCase() });
  }
  return records;
}

/**
 * 校验发布收据结构。
 * @param {object} receipt
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReceipt(receipt) {
  const errors = [];
  const push = (message) => errors.push(message);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, errors: ['收据必须是 JSON 对象'] };
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    push(`schemaVersion 必须为 ${RECEIPT_SCHEMA_VERSION}（当前 ${JSON.stringify(receipt.schemaVersion)}）`);
  }
  if (typeof receipt.version !== 'string' || !SEMVER_RE.test(receipt.version)) {
    push(`version 必须是合法版本号（当前 ${JSON.stringify(receipt.version)}）`);
  }
  if (typeof receipt.tag !== 'string') {
    push('tag 必须是字符串');
  } else if (typeof receipt.version === 'string' && receipt.tag !== `v${receipt.version}`) {
    push(`tag 必须等于 v<version>（version=${receipt.version}，tag=${receipt.tag}）`);
  }
  if (!isValidDateString(receipt.date)) push(`date 必须是合法日历日期 YYYY-MM-DD（当前 ${JSON.stringify(receipt.date)}）`);
  for (const key of ['commit', 'image', 'imageDigest', 'notes']) {
    if (receipt[key] !== undefined && (typeof receipt[key] !== 'string' || !receipt[key].trim())) {
      push(`${key} 若提供必须是非空字符串`);
    }
  }

  const artifacts = receipt.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    push('artifacts 必须是非空数组');
  } else {
    const names = new Set();
    const kinds = new Set();
    artifacts.forEach((artifact, index) => {
      const where = `artifacts[${index}]`;
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
        push(`${where} 必须是对象`);
        return;
      }
      if (typeof artifact.name !== 'string' || !artifact.name.trim()) {
        push(`${where}.name 必须是非空字符串`);
      } else if (names.has(artifact.name)) {
        push(`artifacts 名称重复：${artifact.name}`);
      } else {
        names.add(artifact.name);
      }
      if (!ARTIFACT_KINDS.includes(artifact.kind)) {
        push(`${where}.kind 必须是 ${ARTIFACT_KINDS.join(' / ')} 之一（当前 ${JSON.stringify(artifact.kind)}）`);
      } else {
        kinds.add(artifact.kind);
      }
      if (!Number.isInteger(artifact.size) || artifact.size < 0) {
        push(`${where}.size 必须是非负整数（当前 ${JSON.stringify(artifact.size)}）`);
      }
      if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) {
        push(`${where}.sha256 必须是 64 位小写十六进制（当前 ${JSON.stringify(artifact.sha256)}）`);
      }
    });
    if (!kinds.has('exe')) push('artifacts 至少包含一个 exe');
    if (!kinds.has('apk')) push('artifacts 至少包含一个 apk');
  }

  if (receipt.publicRelease !== undefined) {
    const publicRelease = receipt.publicRelease;
    if (!publicRelease || typeof publicRelease !== 'object' || Array.isArray(publicRelease)) {
      push('publicRelease 若提供必须是对象');
    } else {
      if (typeof publicRelease.repo !== 'string' || !publicRelease.repo.includes('/')) {
        push('publicRelease.repo 必须是 owner/name 形式');
      }
      if (typeof publicRelease.tag !== 'string' || publicRelease.tag !== receipt.tag) {
        push('publicRelease.tag 必须与 tag 一致');
      }
      if (!Array.isArray(publicRelease.assets) || publicRelease.assets.some((asset) => typeof asset !== 'string')) {
        push('publicRelease.assets 必须是字符串数组');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
