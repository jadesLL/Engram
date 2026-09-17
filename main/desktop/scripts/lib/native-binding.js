// better-sqlite3 的 Electron ABI 预编译二进制兜底：prebuild-install 在客户机上静默失败
// （2026-09-18 实测：只打印一条 DEP0176 弃用警告、零错误输出、非零退出），而同一台机器上
// curl + bsdtar 这条路已被证实可用（用户手动 curl 下载 electron zip 116MB 成功）。
// 故这里不再依赖 prebuild-install：自己拼镜像地址、用 curl 下、用 tar 解、挑出 .node 文件。
// 命令一律字面量（curl.exe / System32\tar.exe），不经过 shell。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BINARY_MIRROR = 'https://registry.npmmirror.com/-/binary/better-sqlite3';

/** 官方 prebuild 的下载地址（镜像目录结构与 GitHub releases 一致） */
function prebuildUrl(version, abi, platform = process.platform, arch = process.arch) {
  return `${BINARY_MIRROR}/v${version}/better-sqlite3-v${version}-electron-v${abi}-${platform}-${arch}.tar.gz`;
}

/** 用系统 curl 下载（只允许 https，host 限镜像本身） */
function downloadWithCurl(url, dest) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`地址不合法：${url}`));
    }
    if (parsed.protocol !== 'https:') return reject(new Error(`只允许 https 下载：${url}`));
    if (!/(^|\.)npmmirror\.(com|cn)$/.test(parsed.host)) {
      return reject(new Error(`镜像 host 不在白名单：${parsed.host}`));
    }
    const curlArgs = ['--fail', '-L', '--retry', '2', '-o', dest, url];
    const child = process.platform === 'win32'
      ? spawn('curl.exe', curlArgs, { windowsHide: true })
      : spawn('curl', curlArgs, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => reject(new Error(`无法启动 curl：${e && e.message ? e.message : e}`)));
    child.on('exit', (code) => {
      if (code === 0 && fs.existsSync(dest)) return resolve();
      reject(new Error(`curl 下载失败（退出码 ${code}）：${stderr.trim().split('\n').filter(Boolean).pop() || '无输出'}`));
    });
  });
}

/** 用系统 bsdtar 解 tar.gz（GNU tar 也行；Windows 优先 System32 的 bsdtar） */
function extractTar(tarFile, destDir) {
  const args = ['-xf', tarFile, '-C', destDir];
  const child = process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\tar.exe')
    ? spawn('C:\\Windows\\System32\\tar.exe', args, { windowsHide: true })
    : spawn('tar', args, { windowsHide: true });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => reject(new Error(`无法启动 tar：${e && e.message ? e.message : e}`)));
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`解压失败（tar 退出码 ${code}）：${stderr.trim().split('\n').filter(Boolean).pop() || '无输出'}`));
    });
  });
}

/** 在解压结果里找 better_sqlite3.node（prebuild 包内的固定相对路径） */
function findBinding(root) {
  const direct = path.join(root, 'build', 'Release', 'better_sqlite3.node');
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hit = findBinding(path.join(root, entry.name));
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 兜底取 binding：下载 prebuild → 解压到临时目录 → 复制到目标目录。
 * abi 由调用方提供（sync-deps 里跑 electron 运行时问出来），这里只负责下载/解压/校验。
 */
async function fetchNativeBinding({ version, abi, targetDir, say = () => {} }) {
  const url = prebuildUrl(version, abi);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-binding-'));
  const tarFile = path.join(staging, 'prebuild.tar.gz');
  try {
    say(`从镜像下载 better-sqlite3 prebuild（electron ABI ${abi}）`);
    await downloadWithCurl(url, tarFile);
    const size = fs.statSync(tarFile).size;
    if (size < 1024) throw new Error(`下载的 prebuild 只有 ${size} 字节，不像有效包`);
    await extractTar(tarFile, staging);
    const found = findBinding(staging);
    if (!found) throw new Error('解压结果里没有 better_sqlite3.node');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(found, path.join(targetDir, 'better_sqlite3.node'));
    return { file: path.join(targetDir, 'better_sqlite3.node'), abi, url, size };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { BINARY_MIRROR, prebuildUrl, downloadWithCurl, extractTar, findBinding, fetchNativeBinding };
