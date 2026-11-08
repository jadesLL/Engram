#!/usr/bin/env node
// 发版产物核对与归档：重算 sha256、校验 sha256 文件、生成带 schema 的 releases/<ver>/release.json。
// 退出码：0 成功 / 1 检查或运行失败 / 2 参数错误。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMainDir } from './lib/versions.mjs';
import { hashFile, parseSha256File, normalizeArtifactName, validateReceipt, RECEIPT_SCHEMA_VERSION } from './lib/receipt.mjs';

const USAGE = `用法：
  node scripts/release/archive.mjs --tag v<ver> --from <artifactsDir> [--copy] [--out <releasesDir>] [--repo <mainDir>]
  node scripts/release/archive.mjs --tag v<ver> --download [--copy] --gitea-url <url> --repo-path <owner/name> [--token <t>]

可选：--commit <sha> --image <ref> --image-digest <sha256:…> --date YYYY-MM-DD --notes "<文字>" --public-repo <owner/name>
说明：
  --from      读取目录里的 exe/apk/sha256-<ver>.txt（可选 tar.gz），重算 sha256 后写收据
  --download  从 Gitea Release 下载附件（token 取 --token 或环境变量 GITEA_TOKEN）
  --copy      把产物复制进 <releasesDir>/<ver>/（默认只写收据，不动产物）`;

const TAG_RE = /^v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/;

function usageFail(message) {
  console.log(`[FAIL] ${message}`);
  console.log(USAGE);
  process.exit(2);
}

function todayLocal() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isValidDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 从目录里收集本版本产物。 */
function collectArtifacts(dir, version) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const exeName = `Engram Setup ${version}.exe`;
  const apkName = `Engram ${version}.apk`;
  const shaName = `sha256-${version}.txt`;
  const artifacts = [];
  let shaFile = entries.includes(shaName) ? shaName : entries.find((name) => /^sha256-.*\.txt$/.test(name)) || null;
  const push = (name, kind) => {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    artifacts.push({ name, kind, size: stat.size, sha256: hashFile(filePath), filePath });
  };
  if (entries.includes(exeName)) push(exeName, 'exe');
  if (entries.includes(apkName)) push(apkName, 'apk');
  for (const name of entries) {
    if (name === exeName || name === apkName || name === shaFile) continue;
    if (/\.tar\.gz$/i.test(name) && name.includes(version)) push(name, 'tar.gz');
  }
  return { artifacts, shaFile };
}

/** 重算 sha256 并与 sha256 文件比对；返回 errors / warnings。 */
function verifyAgainstShaFile({ artifacts, shaFile, dir }) {
  const errors = [];
  const warnings = [];
  if (!shaFile) {
    warnings.push(`目录里没有 sha256-<版本>.txt，只按实际哈希写收据`);
    return { errors, warnings };
  }
  const records = parseSha256File(fs.readFileSync(path.join(dir, shaFile), 'utf8'));
  if (records.length === 0) errors.push(`${shaFile} 里没有可解析的 sha256 记录`);
  const recordMap = new Map(records.map((record) => [normalizeArtifactName(record.name), record.sha256]));
  const known = new Set();
  for (const artifact of artifacts) {
    const record = recordMap.get(normalizeArtifactName(artifact.name));
    if (!record) {
      if (artifact.kind === 'exe' || artifact.kind === 'apk') {
        errors.push(`${artifact.name} 未在 ${shaFile} 中记录`);
      } else {
        warnings.push(`${artifact.name} 未在 ${shaFile} 中记录`);
      }
      continue;
    }
    known.add(normalizeArtifactName(artifact.name));
    if (record !== artifact.sha256) {
      errors.push(`${artifact.name} sha256 不符（记录 ${record.slice(0, 12)}…，实际 ${artifact.sha256.slice(0, 12)}…）`);
    }
  }
  for (const record of records) {
    const name = normalizeArtifactName(record.name);
    if (known.has(name)) continue;
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) {
      warnings.push(`${shaFile} 记录了不存在的文件：${record.name}`);
      continue;
    }
    if (hashFile(filePath) !== record.sha256) errors.push(`${record.name} sha256 不符`);
  }
  return { errors, warnings };
}

function downloadAssetCandidates(baseUrl, repoPath, asset, token) {
  const candidates = [];
  if (asset.id !== undefined) {
    candidates.push({
      url: `${baseUrl}/api/v1/repos/${repoPath}/releases/assets/${asset.id}`,
      headers: { Accept: 'application/octet-stream' },
    });
  }
  const relative = asset.browser_download_url || asset.download_url;
  if (relative) {
    const absolute = /^https?:\/\//i.test(relative) ? relative : `${baseUrl}${relative.startsWith('/') ? '' : '/'}${relative}`;
    candidates.push({ url: absolute, headers: {} });
    if (token) {
      const separator = absolute.includes('?') ? '&' : '?';
      candidates.push({ url: `${absolute}${separator}token=${encodeURIComponent(token)}`, headers: {} });
    }
  }
  return candidates;
}

async function downloadReleaseAssets({ giteaUrl, repoPath, tag, token, outDir }) {
  const baseUrl = giteaUrl.replace(/\/+$/, '');
  const authHeaders = token ? { Authorization: `token ${token}` } : {};
  const releaseUrl = `${baseUrl}/api/v1/repos/${repoPath}/releases/tags/${tag}`;
  let response;
  try {
    response = await fetch(releaseUrl, {
      headers: { Accept: 'application/json', ...authHeaders },
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    throw new Error(`请求 Release 失败：${err.message}`);
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? '（私有仓库需要 --token 或 GITEA_TOKEN）' : '';
    throw new Error(`拉取 Release 失败：GET ${releaseUrl} → HTTP ${response.status}${hint}`);
  }
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const wanted = assets.filter(
    (asset) =>
      /^Engram Setup .*\.exe$/i.test(asset.name) ||
      /^Engram .*\.apk$/i.test(asset.name) ||
      /\.tar\.gz$/i.test(asset.name) ||
      /^sha256-.*\.txt$/i.test(asset.name),
  );
  if (wanted.length === 0) throw new Error(`Release ${tag} 里没有可归档的附件（exe/apk/sha256/tar.gz）`);

  for (const asset of wanted) {
    let downloaded = false;
    let lastStatus = null;
    for (const candidate of downloadAssetCandidates(baseUrl, repoPath, asset, token)) {
      let result;
      try {
        result = await fetch(candidate.url, {
          headers: { ...authHeaders, ...candidate.headers },
          signal: AbortSignal.timeout(900000),
        });
      } catch (err) {
        lastStatus = err.message;
        continue;
      }
      if (!result.ok) {
        lastStatus = `HTTP ${result.status}`;
        continue;
      }
      const buffer = Buffer.from(await result.arrayBuffer());
      fs.writeFileSync(path.join(outDir, path.basename(asset.name)), buffer);
      downloaded = true;
      break;
    }
    if (!downloaded) throw new Error(`下载 ${asset.name} 失败：${lastStatus || '没有可用下载地址'}`);
  }
  return wanted.map((asset) => asset.name);
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { repoArg: null, tag: null, from: null, download: false, copy: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined) usageFail(`${name} 需要一个参数值`);
      i += 1;
      return value;
    };
    if (arg === '--download') {
      options.download = true;
    } else if (arg === '--copy') {
      options.copy = true;
    } else if (arg === '--repo') {
      options.repoArg = takeValue('--repo');
    } else if (arg.startsWith('--repo=')) {
      options.repoArg = arg.slice('--repo='.length);
      if (!options.repoArg) usageFail('--repo= 后面需要目录参数');
    } else if (arg === '--tag') {
      options.tag = takeValue('--tag');
    } else if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length);
    } else if (arg === '--from') {
      options.from = takeValue('--from');
    } else if (arg.startsWith('--from=')) {
      options.from = arg.slice('--from='.length);
    } else if (arg === '--out') {
      options.out = takeValue('--out');
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length);
    } else if (arg === '--gitea-url') {
      options.giteaUrl = takeValue('--gitea-url');
    } else if (arg.startsWith('--gitea-url=')) {
      options.giteaUrl = arg.slice('--gitea-url='.length);
    } else if (arg === '--repo-path') {
      options.repoPath = takeValue('--repo-path');
    } else if (arg.startsWith('--repo-path=')) {
      options.repoPath = arg.slice('--repo-path='.length);
    } else if (arg === '--token') {
      options.token = takeValue('--token');
    } else if (arg.startsWith('--token=')) {
      options.token = arg.slice('--token='.length);
    } else if (arg === '--commit') {
      options.commit = takeValue('--commit');
    } else if (arg.startsWith('--commit=')) {
      options.commit = arg.slice('--commit='.length);
    } else if (arg === '--image') {
      options.image = takeValue('--image');
    } else if (arg.startsWith('--image=')) {
      options.image = arg.slice('--image='.length);
    } else if (arg === '--image-digest') {
      options.imageDigest = takeValue('--image-digest');
    } else if (arg.startsWith('--image-digest=')) {
      options.imageDigest = arg.slice('--image-digest='.length);
    } else if (arg === '--date') {
      options.date = takeValue('--date');
    } else if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length);
    } else if (arg === '--notes') {
      options.notes = takeValue('--notes');
    } else if (arg.startsWith('--notes=')) {
      options.notes = arg.slice('--notes='.length);
    } else if (arg === '--public-repo') {
      options.publicRepo = takeValue('--public-repo');
    } else if (arg.startsWith('--public-repo=')) {
      options.publicRepo = arg.slice('--public-repo='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      usageFail(`未知参数：${arg}`);
    }
  }

  if (!options.tag) usageFail('需要 --tag v<版本>');
  const tagMatch = TAG_RE.exec(options.tag);
  if (!tagMatch) usageFail(`--tag 必须是 v<主>.<次>.<修订>[-预发布]：${options.tag}`);
  const version = tagMatch[1];
  if (!options.from && !options.download) usageFail('需要 --from <产物目录> 或 --download');
  if (options.from && options.download) usageFail('--from 与 --download 只能选一个');
  if (options.date !== undefined && !isValidDate(options.date)) usageFail(`--date 不是合法日期：${options.date}`);
  if (options.download) {
    if (!options.giteaUrl) usageFail('--download 需要 --gitea-url');
    if (!options.repoPath) usageFail('--download 需要 --repo-path <owner/name>');
  }
  const token = options.token || process.env.GITEA_TOKEN || null;

  let repoDir;
  try {
    repoDir = resolveMainDir(options.repoArg);
  } catch (err) {
    console.log(`[FAIL] ${err.message}`);
    process.exit(err.exitCode === 2 ? 2 : 1);
  }
  const releasesDir = options.out ? path.resolve(options.out) : path.resolve(repoDir, '..', 'releases');

  const warnings = [];
  const tempDirs = [];
  let sourceDir;
  if (options.download) {
    if (!token) warnings.push('未提供 Gitea 令牌（--token / GITEA_TOKEN），按匿名访问尝试');
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-release-dl-'));
    tempDirs.push(sourceDir);
    try {
      const names = await downloadReleaseAssets({
        giteaUrl: options.giteaUrl,
        repoPath: options.repoPath,
        tag: options.tag,
        token,
        outDir: sourceDir,
      });
      console.log(`[OK] 已从 Gitea Release 下载 ${names.length} 个附件（${options.tag}）`);
    } catch (err) {
      console.log(`[FAIL] ${err.message}`);
      for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
      process.exit(1);
    }
  } else {
    sourceDir = path.resolve(options.from);
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      console.log(`[FAIL] 产物目录不存在：${sourceDir}`);
      process.exit(1);
    }
  }

  const { artifacts, shaFile } = collectArtifacts(sourceDir, version);
  if (artifacts.length === 0) {
    console.log(`[FAIL] ${sourceDir} 里找不到 v${version} 的产物（Engram Setup ${version}.exe / Engram ${version}.apk）`);
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  for (const artifact of artifacts) {
    console.log(`[OK] 产物 ${artifact.name}（${artifact.kind}，${artifact.size} 字节）sha256=${artifact.sha256}`);
  }

  const { errors, warnings: shaWarnings } = verifyAgainstShaFile({ artifacts, shaFile, dir: sourceDir });
  warnings.push(...shaWarnings);
  for (const warning of warnings) console.log(`[WARN] ${warning}`);
  if (errors.length > 0) {
    for (const error of errors) console.log(`[FAIL] ${error}`);
    console.log('[FAIL] sha256 校验未通过，未写收据');
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(shaFile ? `[OK] sha256 校验通过（对照 ${shaFile}）` : '[WARN] 无 sha256 校验文件，按实际哈希写收据');

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    version,
    tag: options.tag,
    date: options.date || todayLocal(),
    artifacts: artifacts
      .sort((a, b) => ['exe', 'apk', 'tar.gz'].indexOf(a.kind) - ['exe', 'apk', 'tar.gz'].indexOf(b.kind))
      .map((artifact) => ({ name: artifact.name, kind: artifact.kind, size: artifact.size, sha256: artifact.sha256 })),
  };
  for (const key of ['commit', 'image', 'imageDigest', 'notes']) {
    if (options[key] !== undefined) receipt[key] = options[key];
  }
  if (options.publicRepo) {
    receipt.publicRelease = { repo: options.publicRepo, tag: options.tag, assets: receipt.artifacts.map((artifact) => artifact.name) };
  }

  const validation = validateReceipt(receipt);
  if (!validation.ok) {
    for (const error of validation.errors) console.log(`[FAIL] 收据校验失败：${error}`);
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  const targetDir = path.join(releasesDir, version);
  fs.mkdirSync(targetDir, { recursive: true });
  if (options.copy) {
    let copied = 0;
    for (const artifact of artifacts) {
      const destination = path.join(targetDir, artifact.name);
      if (path.resolve(artifact.filePath) === path.resolve(destination)) continue;
      fs.copyFileSync(artifact.filePath, destination);
      copied += 1;
    }
    if (shaFile) {
      const destination = path.join(targetDir, shaFile);
      const source = path.join(sourceDir, shaFile);
      if (path.resolve(source) !== path.resolve(destination)) {
        fs.copyFileSync(source, destination);
        copied += 1;
      }
    }
    console.log(`[OK] 已复制 ${copied} 个文件到 ${targetDir}`);
  }
  const receiptPath = path.join(targetDir, 'release.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(`[OK] 收据已写入 ${receiptPath}`);
  if (options.download && !options.copy) {
    console.log('[WARN] 未加 --copy：下载的附件只在临时目录，已随本次执行清理；收据已记录但产物未归档到 releases/<版本>/');
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.log(`[FAIL] ${err.stack || err.message}`);
  process.exit(1);
});
