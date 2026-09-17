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

console.log('install-mirrors: 通过（electron / better-sqlite3 镜像键均在位）');
