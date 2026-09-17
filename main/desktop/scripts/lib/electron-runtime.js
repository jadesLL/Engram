// Electron 运行时的兜底补齐：不依赖 electron 自带 install.js 的语义，自己下载 → 解压 → 逐项校验。
//
// 背景（2026-09-18 客户机实测）：install.js 退出码 0、没有任何输出，可 dist 里只剩 locales/
// （zip 条目本身是乱序的，所以既不像"顺序解压到一半"，也不像杀软只删可执行文件）。install.js
// 内部用 @electron/get + extract-zip，失败细节被吞掉，客户机上连查两轮都拿不到原因。
// 这条兜底路径把每一步都做成可校验、可报错的：
//   1) 优先复用 @electron/get 的缓存 zip（大小可疑就当没有），否则自己从 npmmirror 下载；
//   2) 用系统自带 tar.exe 解压到临时目录（bsdtar 能解 zip；先落地再复制，不污染 dist）；
//   3) 逐项校验必要文件，缺谁报谁 —— 缺文件基本就是安全软件在拦，提示加白名单。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const MIRROR = 'https://npmmirror.com/mirrors/electron/';
const MIN_ZIP_BYTES = 50 * 1024 * 1024; // 完整包约 110-120MB，明显更小就是残包

/** 运行时 zip 的下载地址（平台/架构按当前进程） */
function runtimeZipUrl(version, platform = process.platform, arch = process.arch) {
  return `${MIRROR}v${version}/electron-v${version}-${platform}-${arch}.zip`;
}

/** 运行时必须存在的文件（缺任一项都不算装好） */
function requiredRuntimeFiles(platform = process.platform) {
  const exe = platform === 'win32' ? 'electron.exe' : 'electron';
  return [exe, 'icudtl.dat', 'resources.pak', 'version', 'locales'];
}

/** 目录里缺哪些必要文件（返回缺失清单，空数组=完整） */
function missingRuntimeFiles(dir, platform = process.platform) {
  return requiredRuntimeFiles(platform).filter((name) => !fs.existsSync(path.join(dir, name)));
}

/** 在 @electron/get 的缓存里找可用的 zip（多个候选取最大的，太小的当残包跳过） */
function findCachedZip(version, { platform = process.platform, arch = process.arch, cacheRoot } = {}) {
  const root = cacheRoot || path.join(process.env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache');
  const want = `electron-v${version}-${platform}-${arch}.zip`;
  let best = null;
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry, want);
    try {
      const size = fs.statSync(candidate).size;
      if (size >= MIN_ZIP_BYTES && (!best || size > best.size)) best = { file: candidate, size };
    } catch {
      /* 不是这个缓存条目 */
    }
  }
  return best;
}

/** 下载到本地文件；只允许 https 且 host 限镜像自身（含其 CDN） */
function downloadFile(url, dest, { redirects = 5 } = {}) {
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
    https
      .get(parsed, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('重定向次数过多'));
          return resolve(downloadFile(new URL(res.headers.location, parsed).toString(), dest, { redirects: redirects - 1 }));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`下载失败：HTTP ${status}`));
        }
        pipeline(res, fs.createWriteStream(dest)).then(resolve, reject);
      })
      .on('error', reject);
  });
}

/** Windows 上优先用 System32 的 bsdtar：装了 Git for Windows 的机器 PATH 里 GNU tar 排在前面，
 *  而 GNU tar 解不了 zip（实测报 "Cannot connect to C: resolve failed"）。 */
function defaultTarExe() {
  if (process.platform !== 'win32') return 'tar';
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(system32) ? system32 : 'tar.exe';
}

/** 用系统自带 tar 解压 zip 到目标目录（bsdtar 能解 zip） */
function extractZip(zipFile, destDir, { tarExe = defaultTarExe() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarExe, ['-xf', zipFile, '-C', destDir], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => reject(new Error(`无法启动 tar.exe：${e && e.message ? e.message : e}`)));
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`解压失败（tar 退出码 ${code}）：${stderr.trim().split('\n').filter(Boolean).pop() || '无输出'}`));
    });
  });
}

/**
 * 兜底补齐：下载（或复用缓存）→ 解压到临时目录 → 校验 → 复制进 dist。
 * say 用于把进度写进安装日志；失败时抛出的错误带可判断的细节。
 */
async function repairElectronRuntime(electronDir, version, { say = () => {}, platform = process.platform, arch = process.arch } = {}) {
  let zip = findCachedZip(version, { platform, arch });
  if (zip) {
    say(`复用已下载的压缩包（${(zip.size / 1048576).toFixed(1)}MB）`);
  } else {
    const url = runtimeZipUrl(version, platform, arch);
    const dest = path.join(os.tmpdir(), `engram-electron-v${version}-${platform}-${arch}.zip`);
    say(`从镜像下载 electron 运行时：${url}`);
    await downloadFile(url, dest);
    const size = fs.statSync(dest).size;
    if (size < MIN_ZIP_BYTES) throw new Error(`下载的压缩包只有 ${(size / 1048576).toFixed(1)}MB，明显不完整（镜像或网络问题）`);
    zip = { file: dest, size };
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-electron-dist-'));
  try {
    say('解压到临时目录并逐项校验');
    await extractZip(zip.file, staging);
    const missing = missingRuntimeFiles(staging, platform);
    if (missing.length) {
      throw new Error(`解压结果缺少 ${missing.join('、')}（压缩包 ${(zip.size / 1048576).toFixed(1)}MB）——多为安全软件在拦，请把 ${electronDir} 加入杀软白名单后重试`);
    }
    const dist = path.join(electronDir, 'dist');
    fs.rmSync(dist, { recursive: true, force: true });
    fs.cpSync(staging, dist, { recursive: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const stillMissing = missingRuntimeFiles(path.join(electronDir, 'dist'), platform);
  if (stillMissing.length) {
    throw new Error(`复制到 dist 后仍缺 ${stillMissing.join('、')}：多为安全软件在拦，请把 ${electronDir} 加入杀软白名单后重试`);
  }
  say('Electron 运行时已就绪（安装器自带流程）');
}

module.exports = {
  MIRROR,
  MIN_ZIP_BYTES,
  runtimeZipUrl,
  requiredRuntimeFiles,
  missingRuntimeFiles,
  findCachedZip,
  downloadFile,
  extractZip,
  defaultTarExe,
  repairElectronRuntime,
};
