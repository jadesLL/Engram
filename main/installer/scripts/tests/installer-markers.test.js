// 安装器进度标记协议一致性测试（node 原生，无第三方依赖）：
//   node installer/scripts/tests/installer-markers.test.js
//
// 2026-09-11 事故：install-engram.ps1 发 [[STEP]/[[DONE]/[[FAIL]，GUI 只认 ##STEP:/##DONE:/##FAIL，
// 三个标记全部落进 log 分支 —— 8 个步骤能列出来但永远不动，跑完直接跳「安装完成」。
// 本测试读两侧真实文件，断言「脚本发射的标记」与「GUI 解析的标记」逐一对应，防止再次漂移。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const installerDir = path.resolve(__dirname, '..', '..'); // main/installer
const ps1File = path.resolve(installerDir, '..', 'scripts', 'install-engram.ps1');
const guiFile = path.join(installerDir, 'main.js');

for (const f of [ps1File, guiFile]) {
  assert.ok(fs.existsSync(f), `找不到文件：${f}`);
}

// 协议标记 -> 该标记是否带固定偏移载荷（GUI 用 line.slice(N) 截取）
const PROTOCOL = [
  { marker: '##STEPS:', hasOffset: true },
  { marker: '##STEP:', hasOffset: true },
  { marker: '##DONE:', hasOffset: true },
  { marker: '##FAIL:', hasOffset: false }, // GUI 用 indexOf('|') 取消息
  { marker: '##AUTH:', hasOffset: true }, // 私有仓库要凭据：GUI 据此亮出账号/令牌表单
  { marker: '##ALLDONE', hasOffset: false }, // 无载荷
];

const ps1Text = fs.readFileSync(ps1File, 'utf8');
const guiText = fs.readFileSync(guiFile, 'utf8');

// GUI 某标记分支里实际写的 slice 偏移
function guiSliceOffset(marker) {
  const i = guiText.indexOf(`startsWith('${marker}')`);
  if (i < 0) return null;
  const m = guiText.slice(i, i + 240).match(/slice\((\d+)\)/);
  return m ? Number(m[1]) : null;
}

const cases = [];
const check = (name, ok, detail) => cases.push({ name, ok, detail });

// 1) 脚本不得再用旧的 [[X] 标记
const legacy = ps1Text.match(/\[\[(STEP|DONE|FAIL)\]/g);
check('脚本不再发 [[STEP]/[[DONE]/[[FAIL] 旧标记', legacy === null, legacy && legacy.join(','));

for (const { marker, hasOffset } of PROTOCOL) {
  // 2) 脚本必须发这个标记
  check(`脚本发射 ${marker}`, ps1Text.includes(marker));
  // 3) GUI 必须认这个标记
  const parsed = guiText.includes(`startsWith('${marker}')`);
  check(`GUI 解析 ${marker}`, parsed, parsed ? '' : 'GUI 的 handleLine 里没有对应分支');
  // 4) 带载荷的标记：GUI 的 slice 偏移必须等于前缀长度，否则会截出残缺 id
  if (hasOffset && parsed) {
    const off = guiSliceOffset(marker);
    check(`GUI ${marker} 的 slice(${off}) 等于前缀长度 ${marker.length}`, off === marker.length, `offset=${off} len=${marker.length}`);
  }
}

// 5) 反向：GUI 里出现的每个 startsWith('##...') 都应有脚本侧发射方
for (const m of guiText.matchAll(/startsWith\('(##[A-Z]+:?)'\)/g)) {
  check(`GUI 的 ${m[1]} 有脚本侧对应`, ps1Text.includes(m[1]));
}

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : `  (${c.detail || '不一致'})`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
if (failed) process.exit(1);
