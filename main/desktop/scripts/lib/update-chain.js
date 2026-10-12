// 应用内更新链的纯逻辑：落盘文件名净化、sha256 校验、安装结果判定。
// 抽成纯函数是给单测用的——main.js 要 Electron 才能真正跑起来，这几处判定必须能离线验证。
//
// 来历（2026-10-12 审计）：更新包文件名原来直接取 URL 末段 decodeURIComponent 后拼进
// path.join，`%2e%2e%2fconfig.json` 这类 URL 能把文件写到 downloads 目录之外；下载完也没有
// 任何完整性校验就静默执行，且下载源配置由渲染进程给。现在三道收口：文件名净化 + 与
// Release 的 sha256 资产比对 + 下载源只能来自主进程持有的配置。
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

/** 从资产 URL 推导落盘文件名：解码后必须是纯文件名（不含任何路径成分），且是 exe。 */
function installerFileName(url) {
  const raw = String(url).split('#')[0].split('?')[0];
  const last = raw.split('/').filter(Boolean).pop() || '';
  if (!last) throw new Error('下载地址缺少文件名');
  let decoded;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    throw new Error('更新包文件名不合法');
  }
  // '../x'、'..%5Cx'、绝对路径等在解码后都会与 basename 不等，一律拒绝
  if (decoded !== path.basename(decoded)) throw new Error('更新包文件名不合法');
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) throw new Error('更新包文件名不合法');
  if (decoded === '.' || decoded === '..') throw new Error('更新包文件名不合法');
  if (!/\.exe$/i.test(decoded)) throw new Error('更新包不是 exe 安装包');
  return decoded;
}

/**
 * 目标路径必须落在允许目录内（与 validateInstallerFile 同口径，这里是落盘前的前置校验）。
 *
 * 显式拒绝分隔符与 `..` 段，不靠平台路径语义：更新链只在 Windows 跑（反斜杠是分隔符），
 * 而 CI 的 verify 跑在 Linux 容器里（反斜杠只是普通字符）——靠 path.resolve 判越界会在
 * 两个平台上得出不同结论，护栏与测试都必须与平台无关。
 */
function resolveInsideDir(dir, name) {
  const raw = String(name || '');
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('\0')) throw new Error('更新包落盘路径越界');
  if (raw.split(/[\\/]+/).some((part) => part === '..' || part === '.')) throw new Error('更新包落盘路径越界');
  const file = path.resolve(path.join(dir, raw));
  const root = path.resolve(dir);
  if (!file.startsWith(root + path.sep)) throw new Error('更新包落盘路径越界');
  return file;
}

/** 解析 sha256sum 产物（`<hash>  ./<name>` 或 `<hash> *<name>`），取指定文件名对应的哈希。 */
function parseSha256File(text, fileName) {
  const want = String(fileName);
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})[ \t]+\*?(.+?)[ \t]*$/i);
    if (!m) continue;
    if (m[2].replace(/^\.\//, '') === want) return m[1].toLowerCase();
  }
  return null;
}

/** 在 Release 资产里找校验文件：优先 `sha256-<版本>.txt`，否则退回任意 sha256-*.txt。 */
function findSha256Asset(assets, version) {
  const list = Array.isArray(assets) ? assets : [];
  const exact = list.find((a) => a && a.name === `sha256-${version}.txt`);
  if (exact) return exact;
  return list.find((a) => a && /^sha256-.*\.txt$/i.test(a.name)) || null;
}

/** 边读边算 sha256（安装包几十 MB，不用整份读进内存）。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 判定上一次「退出安装」是否真的生效：退出前把目标版本记进 pendingUpdate，重启后比对
 * 实际版本号。装失败、安装包被杀软拦下、UAC 被拒、半装卡住——从这里都能看出来，
 * 不需要去读安装器退出码（静默链是脱离父进程的 cmd 链，退出码拿不回来）。
 */
function installOutcome({ pendingVersion, currentVersion }) {
  if (!pendingVersion) return { status: 'none' };
  if (!currentVersion) return { status: 'unknown', pendingVersion };
  const cmp = compareVersions(currentVersion, pendingVersion);
  if (cmp < 0) return { status: 'failed', pendingVersion, currentVersion };
  return { status: 'ok', pendingVersion, currentVersion };
}

/** 版本号比较（与 main.js 的 cmpVersions 同口径：逐段取数字比较）。 */
function compareVersions(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((s) => Number((s.match(/\d+/) || [0])[0]));
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((s) => Number((s.match(/\d+/) || [0])[0]));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

module.exports = {
  installerFileName,
  resolveInsideDir,
  parseSha256File,
  findSha256Asset,
  sha256File,
  installOutcome,
  compareVersions,
};
