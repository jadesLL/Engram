// 安装引擎选择回归测试（node 原生，无第三方依赖）：
//   node installer/scripts/tests/installer-engine-select.test.js
//
// 防 2026-11-06 客户机事故重演：安装器 exe 里已带新引擎，但 GUI 过去「克隆优先」，
// 旧克隆里的旧引擎（无 ENGINE_VERSION 标记）照样被选中，新修复等于没打——同一句
// Unknown command: "file" 又出现一次。现在按 ENGINE_VERSION 取高者，旧克隆不能盖新 exe。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const installerDir = path.join(__dirname, '..', '..');
const engine = require(path.join(installerDir, 'scripts', 'lib', 'engine.js'));
const ps1 = path.join(installerDir, '..', 'scripts', 'install-engram.ps1');
const ps1Text = fs.readFileSync(ps1, 'utf8');

const cases = [];
const check = (name, ok, detail) => cases.push({ name, ok: Boolean(ok), detail });

// ---------- 1) 版本标记解析 ----------
check('无标记的旧引擎按 1 处理', engine.parseEngineVersion('Write-Host hi\n') === 1);
check('识别 # ENGINE_VERSION: 2', engine.parseEngineVersion('# ENGINE_VERSION: 2\n') === 2);
check('容忍缩进与 CRLF', engine.parseEngineVersion('\r\n  # ENGINE_VERSION: 12\r\n') === 12);
check('错误值按 1 兜底', engine.parseEngineVersion('# ENGINE_VERSION: abc\n') === 1);
check('null 输入返回 null', engine.parseEngineVersion(null) === null);
check('部署脚本声明了 ENGINE_VERSION 2',
  engine.parseEngineVersion(ps1Text) === 2,
  'got ' + engine.parseEngineVersion(ps1Text));
check('部署脚本的引擎版本高于旧引擎', engine.parseEngineVersion(ps1Text) > engine.LEGACY_ENGINE_VERSION);

// ---------- 2) 选择逻辑（真实文件读写） ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-engine-'));
const bundled = path.join(tmp, 'bundled.ps1');
const cloned = path.join(tmp, 'cloned.ps1');
const write = (file, version) => fs.writeFileSync(file,
  version === null ? 'Write-Host old\n' : '# ENGINE_VERSION: ' + version + '\nWrite-Host new\n');

write(bundled, 2);
write(cloned, null);
check('旧克隆不覆盖新 exe（核心修复）', engine.pickEngine(bundled, cloned) === bundled);

write(cloned, 1);
check('克隆版本低时用 exe', engine.pickEngine(bundled, cloned) === bundled);

write(cloned, 2);
check('版本相同时优先克隆（保留热更新）', engine.pickEngine(bundled, cloned) === cloned);

write(cloned, 3);
check('克隆版本更高时用克隆（旧 exe 不挡新引擎）', engine.pickEngine(bundled, cloned) === cloned);

fs.rmSync(cloned);
check('克隆不存在时用 exe', engine.pickEngine(bundled, cloned) === bundled);
fs.rmSync(bundled);
check('两份都不存在返回空串', engine.pickEngine(bundled, cloned) === '');
check('只给克隆时用克隆', engine.pickEngine('', cloned) === '');

// ---------- 3) GUI / 打包接线 ----------
const mainText = fs.readFileSync(path.join(installerDir, 'main.js'), 'utf8');
check('main.js 引入 engine.js', mainText.includes("require('./scripts/lib/engine.js')"));
check('main.js 用 pickEngine 选择引擎', /pickEngine\s*\(/.test(mainText));
check('main.js 不再无条件返回克隆引擎', !/if \(fs\.existsSync\(cloned\)\) return cloned;/.test(mainText));
check('GUI 会读取打包态 resources 里的引擎',
  /app\.isPackaged[^\n]*process\.resourcesPath[^\n]*install-engram\.ps1/.test(mainText) ||
  mainText.includes("const bundled = app.isPackaged ? path.join(process.resourcesPath, 'install-engram.ps1') : '';"));

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { /* 忽略 */ }

let failed = 0;
for (const c of cases) {
  if (!c.ok) failed += 1;
  console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.ok ? '' : '  (' + (c.detail || '不满足') + ')'));
}
console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
if (failed) process.exit(1);
