// 安装镜像配置回归测试（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/install-mirrors.test.js
// 事故背景（2026-09-17 客户机）：全新安装的「安装依赖」步以退出码 1 失败，日志里
// `node_modules/electron postinstall: RequestError: read ECONNRESET` —— pnpm 装依赖会跑
// electron / better-sqlite3 的 postinstall，两者默认都去 GitHub 拉二进制，国内直连必崩。
// 修法：仓库根 .npmrc 给出两个镜像键（pnpm 会把键名转成 npm_config_<键名> 交给生命周期脚本，
// @electron/get 读 npm_config_electron_mirror、prebuild-install 读
// npm_config_better_sqlite3_binary_host_mirror）。本测试守住这两行，删掉任何一行都会重演事故。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const npmrcPath = path.resolve(__dirname, '..', '..', '..', '.npmrc');
assert.ok(fs.existsSync(npmrcPath), `.npmrc 缺失（${npmrcPath}）：国内网络下 pnpm install 会去 GitHub 拉二进制并 ECONNRESET`);
const npmrc = fs.readFileSync(npmrcPath, 'utf8');

function readKey(key) {
  const line = npmrc.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`${key}=`));
  assert.ok(line, `.npmrc 缺 ${key}（键名即 pnpm 注入的 npm_config_${key} 环境变量名）`);
  return line.slice(key.length + 1).trim();
}

// 末尾斜杠不能少：@electron/get 直接拼 `${mirror}${version}/${file}`
assert.equal(
  readKey('electron_mirror'),
  'https://npmmirror.com/mirrors/electron/',
  'electron_mirror 必须指向 npmmirror 的 electron 镜像（末尾斜杠不可省）',
);
assert.equal(
  readKey('better_sqlite3_binary_host_mirror'),
  'https://registry.npmmirror.com/-/binary/better-sqlite3',
  'better_sqlite3_binary_host_mirror 必须指向 npmmirror 的 better-sqlite3 镜像',
);

// Docker 构建的系统依赖源也必须显式指定 HTTPS；仅换域名会继承基础镜像的 HTTP。
const dockerfile = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'Dockerfile'), 'utf8');
const depsStage = dockerfile.split('FROM node:22-slim AS deps')[1].split('FROM build AS test')[0];
for (const host of ['deb.debian.org', 'security.debian.org']) {
  const escapedHost = host.replaceAll('.', '\\.');
  assert.ok(
    depsStage.includes(`-e 's|https\\?://${escapedHost}|https://mirrors.tuna.tsinghua.edu.cn|g'`),
    `Docker Debian 源 ${host} 必须把 HTTP/HTTPS 都规范为 HTTPS 镜像地址`,
  );
}
assert.doesNotMatch(depsStage, /Verify-(?:Peer|Host)\s*[=:]?\s*["']?false|trusted\s*=\s*yes|--allow-unauthenticated/i,
  '不得通过关闭 TLS 或软件包签名校验绕过源下载错误');
assert.match(depsStage, /require\('node:tls'\)\.rootCertificates/,
  'node:slim 没有系统 CA，必须先用 Node 自带的可信根证书引导 APT');
assert.equal((depsStage.match(/Acquire::https::CaInfo=\/tmp\/engram-node-ca\.pem/g) || []).length, 2,
  'APT 更新索引与安装系统 CA 两步都需要有效的引导证书');
assert.ok(depsStage.indexOf('rootCertificates') < depsStage.indexOf('apt-get'),
  '引导证书必须在首次 APT 请求之前准备好');
assert.match(depsStage, /APT::Update::Error-Mode=any update/,
  '任何源索引下载失败都应立即让构建失败，不得仅警告后继续使用不完整索引');
assert.match(depsStage, /install -y --no-install-recommends ca-certificates python3 make g\+\+/,
  '必须安装 Debian 管理的系统 CA，而非永久依赖临时引导证书');
assert.match(depsStage, /rm -f \/tmp\/engram-node-ca\.pem/,
  '系统 CA 安装完成后必须删除临时引导证书');

console.log('install-mirrors: 通过（electron / better-sqlite3 镜像键与 Docker HTTPS 源均在位）');
