// 安装器内置环境包定位（installer/scripts/lib/bundle-zip.js）的回归测试：
//   node installer/scripts/tests/bundle-zip.test.js
//
// 锁住：开发态（installer/resources/prebuilt）与打包态（resources/prebuilt）都能命中、
// 打包态优先、多包取最新的一个、出错（目录缺失/读不动）时安静退回源码模式而不是抛异常。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundleDirs, findBundleZip, bundleInfo } = require('../lib/bundle-zip.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bundle-zip-'));
const devDir = path.join(tmp, 'dev');           // 开发态：<dirname>\resources\prebuilt
const resDir = path.join(tmp, 'resources');     // 打包态：<resourcesPath>\prebuilt

function put(prebuiltDir, name, bytes) {
  fs.mkdirSync(prebuiltDir, { recursive: true });
  const file = path.join(prebuiltDir, name);
  fs.writeFileSync(file, 'x'.repeat(bytes));
  return file;
}

const cases = [];
function check(name, ok, extra = '') {
  cases.push({ name, ok, extra });
}

// 1) 开发态命中
const devZip = put(path.join(devDir, 'resources', 'prebuilt'), 'engram-prebuilt-win-x64.zip', 3 * 1048576);
check('开发态命中 installer/resources/prebuilt', findBundleZip({ dirname: devDir }) === devZip, findBundleZip({ dirname: devDir }));

// 2) 打包态（resources\prebuilt）命中
const resZip = put(path.join(resDir, 'prebuilt'), 'engram-prebuilt-win-x64.zip', 3 * 1048576);
check('打包态命中 resources\\prebuilt', findBundleZip({ resourcesPath: resDir }) === resZip);

// 3) 两者都在时以打包态为准（客户机上只有打包态；开发机同时存在时不能装错包）
check(
  '打包态优先于开发态',
  findBundleZip({ resourcesPath: resDir, dirname: devDir }) === resZip,
  findBundleZip({ resourcesPath: resDir, dirname: devDir }),
);

// 4) 多个包取「最后修改时间最新」的一个（与文件名顺序无关）
const newer = put(path.join(resDir, 'prebuilt'), 'engram-prebuilt-win-x64-20261009.zip', 3 * 1048576);
const future = new Date(Date.now() + 60_000);
fs.utimesSync(newer, future, future);
check('多个包取最新的一个（按修改时间）', findBundleZip({ resourcesPath: resDir }) === newer, findBundleZip({ resourcesPath: resDir }));
fs.rmSync(newer, { force: true });

// 5) 非 zip 文件不算内置包
const otherDir = path.join(tmp, 'other');
put(path.join(otherDir, 'prebuilt'), 'README.md', 0);
check('目录里只有非 zip 文件时不算内置包', findBundleZip({ dirname: otherDir }) === '');

// 6) 目录不存在：安静返回空（退回源码模式）
check('目录不存在时返回空', findBundleZip({ dirname: path.join(tmp, 'missing') }) === '');
check('resourcesPath 为空也不炸', findBundleZip({ resourcesPath: '', dirname: '' }) === '');

// 7) readdir 抛错（权限等）：安静返回空
check(
  '读不动目录时安静返回空',
  findBundleZip({
    dirname: devDir,
    readdir: () => {
      throw new Error('EPERM');
    },
  }) === '',
);

// 8) bundleInfo：界面拿到的包名与大小
const info = bundleInfo({ resourcesPath: resDir });
check('bundleInfo 报可用的包名', info.available === true && info.name === 'engram-prebuilt-win-x64.zip', JSON.stringify(info));
check('bundleInfo 报大小（MB，四舍五入）', info.sizeMB === 3, String(info.sizeMB));
check('无内置包时 available=false', bundleInfo({ dirname: path.join(tmp, 'missing') }).available === false);

// 9) 候选目录顺序：打包态在开发态之前
const dirs = bundleDirs(resDir, devDir);
check('候选目录顺序为 打包态 → 开发态', dirs[0] === path.join(resDir, 'prebuilt') && dirs[1] === path.join(devDir, 'resources', 'prebuilt'), dirs.join(' | '));
check('没有 resourcesPath 时只剩开发态候选', bundleDirs('', devDir).length === 1);

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : ` (${c.extra})`}`);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* 清理失败不影响用例结果 */
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
assert.equal(failed, 0);
