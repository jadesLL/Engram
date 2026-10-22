// 随包 Node 运行时（桌面安装包内置 resources/node/node.exe）的版本、地址与校验。
//
// 为什么桌面安装包要带一份真实 Node：内置 Agent（dsh）的原生模块只认 Electron 43/44/45 的
// V8 指纹，Electron 36 的纯 Node 模式直接拒绝启动（详见 server/src/assistant/agentNode.ts）。
// 所以安装包必须自带一份 node.exe，由 desktop/scripts/prepare-node-runtime.js 放进
// main/desktop/node/node.exe，再由 electron-builder 的 extraResources 搬到 resources/node。
//
// 这个模块只做纯逻辑（URL / PE 校验 / 记录读写），网络下载在 prepare 脚本里，便于单测。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 与 install-engram.ps1 的 $nodeVer 对齐：Node 20+ 即满足 dsh engines，22 与 Dockerfile/CI 同大版本 */
const NODE_VERSION = '22.20.0';

/** 随包文件相对 desktop/ 的路径（electron-builder extraResources: node/node.exe → resources/node/node.exe） */
const BUNDLED_NODE_REL = ['node', 'node.exe'];

/** 版本记录文件（相对 desktop/node/），用于避免每次打包重复下载、也方便排查包内 Node 版本 */
const BUNDLE_RECORD = 'runtime.json';

/** 体积下限：真实 win32-x64 node.exe 约 83MB；低于阈值基本是下载到错误页 / 残包 */
const MIN_NODE_EXE_BYTES = 40 * 1024 * 1024;

/** nodejs.org dist 的目录名：win32 → win-x64（不是 win32-x64） */
function distPlatform(platform, arch) {
  const name = platform === 'win32' ? 'win' : platform;
  return `${name}-${arch}`;
}

/** 镜像源（镜像优先、官方兜底；与 install-engram.ps1 的 Node 下载策略一致） */
function nodeExeUrls(version = NODE_VERSION, platform = 'win32', arch = 'x64') {
  const file = `v${version}/${distPlatform(platform, arch)}/node.exe`;
  return [
    `https://registry.npmmirror.com/-/binary/node/${file}`,
    `https://mirrors.huaweicloud.com/nodejs/${file}`,
    `https://nodejs.org/dist/${file}`,
  ];
}

/** desktop/node/node.exe 的绝对路径 */
function bundledNodePath(desktopRoot) {
  return path.join(desktopRoot, ...BUNDLED_NODE_REL);
}

/** 版本记录文件绝对路径 */
function bundleRecordPath(desktopRoot) {
  return path.join(desktopRoot, 'node', BUNDLE_RECORD);
}

/**
 * 校验一个 Windows node.exe 的头部是否是 PE 可执行文件。
 * 只读头部 + 体积（不加载整份 83MB 进内存），用于下载/复制后立刻判断产物是不是真 exe。
 * @param {Buffer} head 文件前若干字节（至少 64）
 * @param {number} size 文件字节数
 */
function windowsNodeExeLooksValid(head, size, { minBytes = MIN_NODE_EXE_BYTES } = {}) {
  if (!Buffer.isBuffer(head) || head.length < 64) return false;
  if (!Number.isFinite(size) || size < minBytes) return false;
  if (head.readUInt16LE(0) !== 0x5a4d) return false; // "MZ"
  const peOffset = head.readUInt32LE(0x3c);
  if (peOffset < 64 || peOffset + 4 > head.length) return false;
  return head.readUInt32LE(peOffset) === 0x00004550; // "PE\0\0"
}

/** 读取文件头 + 大小做 PE 校验；返回 { ok, size, sha256, error } */
function validateNodeExeFile(file, options = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, size: 0, sha256: '', error: `文件不存在：${file}` };
  }
  if (!stat.isFile()) return { ok: false, size: 0, sha256: '', error: `不是普通文件：${file}` };
  // PE 头偏移（e_lfanew）通常在 0xE8 附近，读 4KB 足够覆盖
  const head = Buffer.alloc(4096);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, head.length, 0);
  } catch (error) {
    return { ok: false, size: stat.size, sha256: '', error: `读取失败：${error.message}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (!windowsNodeExeLooksValid(head, stat.size, options)) {
    return {
      ok: false,
      size: stat.size,
      sha256: '',
      error: `不是有效的 Windows node.exe（size=${stat.size}；可能下载到错误页或被截断）`,
    };
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { ok: true, size: stat.size, sha256, error: '' };
}

/** 读随包 Node 的版本记录（损坏/缺失返回 null） */
function readBundleRecord(desktopRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(bundleRecordPath(desktopRoot), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 写随包 Node 的版本记录（内容 = 实际放进包里的那一份的指纹） */
function writeBundleRecord(desktopRoot, record) {
  fs.mkdirSync(path.join(desktopRoot, 'node'), { recursive: true });
  fs.writeFileSync(bundleRecordPath(desktopRoot), JSON.stringify(record, null, 2) + '\n');
}

module.exports = {
  NODE_VERSION,
  BUNDLED_NODE_REL,
  BUNDLE_RECORD,
  MIN_NODE_EXE_BYTES,
  nodeExeUrls,
  bundledNodePath,
  bundleRecordPath,
  windowsNodeExeLooksValid,
  validateNodeExeFile,
  readBundleRecord,
  writeBundleRecord,
};
