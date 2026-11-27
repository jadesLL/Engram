// web 构建失败回退与失败摘要护栏（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/web-build-fallback.test.js
//
// 背景（2026-11-27 本机实测）：
// 1. 安全软件偶发抢锁 esbuild 的临时文件时，`vite build` 会在 renderChunk 阶段报
//    `remove ...: Access is denied`，应用内更新与 update-from-source.ps1 都要退回
//    「不压缩、不降级语法」的构建；
// 2. child_process.fork 不经 shell 拆词，曾把 '--minify false' 整串当作单个参数导致
//    Vite 报错 `CACError: Unknown option \`--minify false\``，且 forkStep 只截最后 4 行
//    把真正报错行截掉。这里同时锁住参数拆词、源码引用与失败摘要逻辑。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webBuild = require('../../lib/web-build');

const mainRoot = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

// 1. fork 参数必须逐项拆开，任何元素不能含空白（fork 不经 shell 拆词）
assert.deepEqual(webBuild.WEB_BUILD_ARGS, ['build']);
assert.deepEqual(webBuild.WEB_BUILD_FALLBACK_ARGS, ['build', '--minify', 'false', '--target', 'esnext']);
for (const arg of [...webBuild.WEB_BUILD_ARGS, ...webBuild.WEB_BUILD_FALLBACK_ARGS]) {
  assert.ok(!/\s/.test(arg), `forkStep 参数不得含空白字符（避免未拆词被当作单一开关名）：${arg}`);
}

// 2. desktop/main.js 与 update-from-source.ps1 引用检查
const mainJs = read('desktop/main.js');
assert.match(mainJs, /require\(['"]\.\/lib\/web-build['"]\)/, 'desktop/main.js 应引入 ./lib/web-build');
assert.match(mainJs, /webBuildLib\.WEB_BUILD_ARGS/, 'desktop/main.js 应使用 webBuildLib.WEB_BUILD_ARGS');
assert.match(mainJs, /webBuildLib\.WEB_BUILD_FALLBACK_ARGS/, 'desktop/main.js 应使用 webBuildLib.WEB_BUILD_FALLBACK_ARGS');
assert.match(mainJs, /webBuildLib\.summarizeProcessTail/, 'forkStep 应使用 webBuildLib.summarizeProcessTail');
assert.ok(!mainJs.includes("'--minify false'"), 'desktop/main.js 不得再出现未拆分的 --minify false');
assert.ok(!mainJs.includes("'--target esnext'"), 'desktop/main.js 不得再出现未拆分的 --target esnext');

const ps1 = read('scripts/update-from-source.ps1');
assert.match(
  ps1,
  /node \$vite build --minify false --target esnext/,
  'update-from-source.ps1 缺少源码更新的 web 构建回退参数',
);
assert.match(ps1, /默认构建失败/, 'update-from-source.ps1 回退时缺少可读的提示');

// 3. summarizeProcessTail：优先保留错误标题行而非 node:internal 栈尾
const viteArgError = webBuild.summarizeProcessTail([
  'file:///repo/node_modules/vite/dist/node/cli.js:448',
  '          throw new CACError(`Unknown option ...`);',
  '                ^',
  "CACError: Unknown option `--minify false`",
  '    at Command.checkUnknownOptions (file:///repo/cli.js:448:17)',
  '    at CAC.runMatchedCommand (file:///repo/cli.js:646:13)',
  '    at CAC.parse (file:///repo/cli.js:585:12)',
  '    at ModuleJob.run (node:internal/modules/esm/module_job:345:25)',
  '    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:651:26)',
  'Node.js v22.19.0',
]);
assert.ok(viteArgError.startsWith('CACError: Unknown option'), `应从 CACError 行开始：${viteArgError}`);
assert.ok(!viteArgError.includes('ModuleJob.run'), `应过滤 node:internal 栈帧：${viteArgError}`);
assert.ok(!viteArgError.includes('Node.js v22.19.0'), `应过滤末尾 Node 版本行：${viteArgError}`);

const esbuildLockError = webBuild.summarizeProcessTail([
  'vite v6.4.3 building for production...',
  'transforming...',
  'error during build:',
  'Error: remove C:\\tmp\\esbuild.exe: Access is denied',
  '    at failureErrorWithLog (file:///repo/esbuild.js:1472:15)',
  '    at ModuleJob.run (node:internal/modules/esm/module_job:345:25)',
]);
assert.ok(esbuildLockError.includes('Access is denied'), `应保留 Access is denied 行：${esbuildLockError}`);

const tscError = webBuild.summarizeProcessTail([
  'src/foo.ts(12,5): error TS2322: Type "string" is not assignable to type "number".',
  'src/bar.ts(3,1): error TS1005: ";" expected.',
]);
assert.ok(tscError.includes('error TS2322') || tscError.includes('error TS1005'), `应保留 TS 编译错误：${tscError}`);

const plainTail = webBuild.summarizeProcessTail(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
assert.equal(plainTail, 'line 2 | line 3 | line 4 | line 5');

console.log('  ✓ web 构建回退参数拆词、源码引用与失败摘要全部通过');
