// web 构建失败回退护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/web-build-fallback.test.js
//
// 背景（2026-11-27 本机实测）：安全软件偶发抢锁 esbuild 的临时文件时，`vite build` 会在
// renderChunk 阶段报 `remove ...: Access is denied`，整次源码更新因此失败。应用内更新与
// update-from-source.ps1 都要退回「不压缩、不降级语法」的构建（产物可直接运行，体积大一些），
// 保证更新还能完成；这里锁住两处回退参数，避免以后重构时被删掉。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainRoot = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

const mainJs = read('desktop/main.js');
assert.match(
  mainJs,
  /'build',\s*'--minify false',\s*'--target esnext'/,
  'desktop/main.js 缺少应用内更新的 web 构建回退参数',
);

const ps1 = read('scripts/update-from-source.ps1');
assert.match(
  ps1,
  /node \$vite build --minify false --target esnext/,
  'update-from-source.ps1 缺少源码更新的 web 构建回退参数',
);
assert.match(ps1, /默认构建失败/, 'update-from-source.ps1 回退时缺少可读的提示');

console.log('  ✓ 应用内更新与源码更新脚本都保留了 web 构建回退');
