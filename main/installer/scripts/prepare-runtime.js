#!/usr/bin/env node
// 安装器「内置运行时」准备器（打包前执行一次；产物是二进制，不进 Git）。
//
//   resources/runtime/node-v<ver>-win-x64.zip        官方便携 Node zip（校验 ZIP 头 + 实际版本）
//   resources/runtime/pnpm/pnpm.cjs + pnpm.cmd + pnpm.ps1   pnpm <ver>（node 直接跑，无需 npm）
//   resources/runtime/manifest.json                  版本、大小与 sha256，便于排查
//
// 版本号唯一事实源是 scripts/install-engram.ps1 里的 $nodeVer / $pnpmVer：这里解析后使用，不另立一份，
// 避免「安装器内置版本」和「脚本期望版本」漂移。pnpm 优先用 main/node_modules/pnpm（仓库共享副本，
// 固定 10.20.0）；缺失或版本不符时才从 npmmirror 下载对应 tarball。
//
// 用法（在 main/ 下）：node installer/scripts/prepare-runtime.js [--force] [--check]
//   --check  只校验现有产物与版本，不下载（发布前/CI 自检用）
// 离线来源（可选）：
//   ENGRAM_RUNTIME_NODE_ZIP   本机 node-v<ver>-win-x64.zip 路径
//   ENGRAM_RUNTIME_PNPM_CJS   本机 pnpm.cjs 路径（例如从 pnpm npm 包解出的 dist/pnpm.cjs）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const INSTALLER_DIR = path.resolve(__dirname, '..');
const MAIN_DIR = path.resolve(INSTALLER_DIR, '..');
// 可被 --ps1 / --out 覆盖：公开安装器从脱敏导出的 install-engram.ps1 打包，产物放导出目录。
let PS1 = path.join(MAIN_DIR, 'scripts', 'install-engram.ps1');
let RUNTIME_DIR = path.join(INSTALLER_DIR, 'resources', 'runtime');
const NPM_MIRROR = 'https://registry.npmmirror.com';
const MIN_NODE_ZIP_BYTES = 20 * 1024 * 1024;

function readPinnedVersions(ps1Path = PS1) {
  const text = fs.readFileSync(ps1Path, 'utf8');
  const read = (name) => {
    const re = new RegExp('^\\s*\\$' + name + "\\s*=\\s*'([^']+)'", 'm');
    const m = re.exec(text);
    if (!m) throw new Error('无法从 ' + ps1Path + ' 读取 $' + name + '（版本号唯一事实源）');
    return m[1];
  };
  return { node: read('nodeVer'), pnpm: read('pnpmVer') };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function nodeZipName(ver) {
  return 'node-v' + ver + '-win-x64.zip';
}

function nodeZipUrls(ver) {
  const zip = nodeZipName(ver);
  return [
    NPM_MIRROR + '/-/binary/node/v' + ver + '/' + zip,
    'https://mirrors.huaweicloud.com/nodejs/v' + ver + '/' + zip,
    'https://nodejs.org/dist/v' + ver + '/' + zip,
  ];
}

async function downloadTo(url, out) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_NODE_ZIP_BYTES) throw new Error('下载体积异常（' + buf.length + ' 字节）：' + url);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('下载内容不是 ZIP（镜像返回错误页？）：' + url);
  fs.writeFileSync(out, buf);
}

// 校验 zip：体积、ZIP 头、包内确实有 node-v<ver>-win-x64/node.exe
function validateNodeZip(file, ver) {
  if (!fs.existsSync(file)) return { ok: false, reason: '文件不存在' };
  const size = fs.statSync(file).size;
  if (size < MIN_NODE_ZIP_BYTES) return { ok: false, reason: '体积过小（' + size + ' 字节）' };
  const buf = fs.readFileSync(file, { encoding: null, flag: 'r' }).subarray(0, 4);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return { ok: false, reason: '不是 ZIP 文件头' };
  const expect = 'node-v' + ver + '-win-x64/node.exe';
  let listing = '';
  try {
    listing = execFileSync('tar', ['-tf', file], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, reason: 'tar 无法读取 zip：' + (e && e.message ? e.message : e) };
  }
  if (listing.indexOf(expect) < 0) return { ok: false, reason: '包内缺少 ' + expect };
  return { ok: true, size };
}

// 从 zip 里取出 node.exe 实际跑一次 -v，确认版本号与文件名一致（镜像/zIP 被换过时挡在打包前）
function extractNodeVersion(file, ver) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-nodecheck-'));
  try {
    execFileSync('tar', ['-xf', file, '-C', tmp, 'node-v' + ver + '-win-x64/node.exe'], { stdio: 'ignore' });
    const exe = path.join(tmp, 'node-v' + ver + '-win-x64', 'node.exe');
    if (!fs.existsSync(exe)) return '';
    return execFileSync(exe, ['-v'], { encoding: 'utf8' }).trim().replace(/^v/, '');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { /* 忽略 */ }
  }
}

function pnpmVersionOf(cjsPath) {
  try {
    return execFileSync(process.execPath, [cjsPath, '-v'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

// 优先用仓库共享副本（main/node_modules/pnpm，版本必须与 pin 一致），否则下载 pnpm tarball 取 dist/pnpm.cjs
function preparePnpmCjs(ver, force) {
  const outDir = path.join(RUNTIME_DIR, 'pnpm');
  const target = path.join(outDir, 'pnpm.cjs');
  if (fs.existsSync(target) && !force && pnpmVersionOf(target) === ver) return { source: 'existing' };
  let source = '';
  const envCjs = process.env.ENGRAM_RUNTIME_PNPM_CJS;
  if (envCjs && fs.existsSync(envCjs) && pnpmVersionOf(envCjs) === ver) {
    source = 'env:' + envCjs;
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(envCjs, target);
  } else {
    const localPkgDir = path.join(MAIN_DIR, 'node_modules', 'pnpm');
    const localCjs = path.join(localPkgDir, 'dist', 'pnpm.cjs');
    if (fs.existsSync(localCjs) && fs.existsSync(path.join(localPkgDir, 'package.json'))) {
      let localVer = '';
      try { localVer = JSON.parse(fs.readFileSync(path.join(localPkgDir, 'package.json'), 'utf8')).version || ''; } catch (e) { localVer = ''; }
      if (localVer === ver) {
        source = 'main/node_modules/pnpm@' + localVer;
        fs.mkdirSync(outDir, { recursive: true });
        fs.copyFileSync(localCjs, target);
      }
    }
  }
  if (!source) {
    // 下载 pnpm tarball：https://registry.npmmirror.com/pnpm/-/pnpm-<ver>.tgz
    const tgz = path.join(os.tmpdir(), 'engram-pnpm-' + ver + '-' + process.pid + '.tgz');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-pnpm-pkg-'));
    try {
      console.log('下载 pnpm@' + ver + '（' + NPM_MIRROR + '）');
      execFileSync(process.execPath, ['-e', [
        "const fs=require('fs');",
        "fetch('" + NPM_MIRROR + "/pnpm/-/pnpm-" + ver + ".tgz').then(async r=>{if(!r.ok)throw new Error('HTTP '+r.status);fs.writeFileSync(process.argv[1],Buffer.from(await r.arrayBuffer()));}).catch(e=>{console.error(e.message);process.exit(1)});",
      ].join(''), tgz], { stdio: 'inherit' });
      execFileSync('tar', ['-xzf', tgz, '-C', tmp, 'package/dist/pnpm.cjs'], { stdio: 'inherit' });
      const extracted = path.join(tmp, 'package', 'dist', 'pnpm.cjs');
      if (!fs.existsSync(extracted)) throw new Error('pnpm tarball 内缺少 package/dist/pnpm.cjs');
      if (pnpmVersionOf(extracted) !== ver) throw new Error('下载到的 pnpm.cjs 版本不是 ' + ver);
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(extracted, target);
      source = 'download';
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) { /* 忽略 */ }
      try { fs.rmSync(tgz, { force: true }); } catch (e) { /* 忽略 */ }
    }
  }
  if (!fs.existsSync(target)) throw new Error('pnpm.cjs 准备失败');
  const got = pnpmVersionOf(target);
  if (got !== ver) throw new Error('内置 pnpm.cjs 版本不符：期望 ' + ver + '，实际 ' + (got || '无法运行'));
  return { source };
}

function writePnpmLaunchers() {
  const outDir = path.join(RUNTIME_DIR, 'pnpm');
  fs.mkdirSync(outDir, { recursive: true });
  const cmd = [
    '@ECHO OFF',
    'SETLOCAL',
    'SET "NODE_EXE=%~dp0..\\node\\node.exe"',
    'IF NOT EXIST "%NODE_EXE%" SET "NODE_EXE=node"',
    '"%NODE_EXE%" "%~dp0pnpm.cjs" %*',
    '',
  ].join('\r\n');
  const ps1 = [
    '$nodeExe = Join-Path $PSScriptRoot \'..\\node\\node.exe\'',
    "if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }",
    '& $nodeExe (Join-Path $PSScriptRoot \'pnpm.cjs\') $args',
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(outDir, 'pnpm.cmd'), cmd);
  fs.writeFileSync(path.join(outDir, 'pnpm.ps1'), ps1);
}

async function prepareNodeZip(ver, force) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const target = path.join(RUNTIME_DIR, nodeZipName(ver));
  if (fs.existsSync(target) && !force) {
    const v = validateNodeZip(target, ver);
    if (v.ok) return { source: 'existing', size: v.size };
    console.log('现有 Node zip 不可用（' + v.reason + '），重新准备');
  }
  const envZip = process.env.ENGRAM_RUNTIME_NODE_ZIP;
  if (envZip) {
    if (!fs.existsSync(envZip)) throw new Error('ENGRAM_RUNTIME_NODE_ZIP 不存在：' + envZip);
    fs.copyFileSync(envZip, target);
  } else {
    let lastErr = null;
    for (const url of nodeZipUrls(ver)) {
      try {
        console.log('下载 Node v' + ver + '：' + url);
        await downloadTo(url, target);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        console.log('  失败：' + (e && e.message ? e.message : e));
      }
    }
    if (lastErr) throw lastErr;
  }
  const v = validateNodeZip(target, ver);
  if (!v.ok) throw new Error('Node zip 校验失败：' + v.reason);
  const got = extractNodeVersion(target, ver);
  if (got !== ver) throw new Error('Node zip 里的 node.exe 版本不符：期望 ' + ver + '，实际 ' + (got || '无法运行'));
  return { source: envZip ? 'env' : 'download', size: v.size };
}

function writeManifest(meta) {
  fs.writeFileSync(path.join(RUNTIME_DIR, 'manifest.json'),
    JSON.stringify(meta, null, 2) + '\n');
}

function checkRuntime() {
  const { node, pnpm } = readPinnedVersions();
  const problems = [];
  const zip = path.join(RUNTIME_DIR, nodeZipName(node));
  const zv = validateNodeZip(zip, node);
  if (!zv.ok) problems.push('node zip：' + zv.reason);
  else if (extractNodeVersion(zip, node) !== node) problems.push('node zip 版本不符');
  const cjs = path.join(RUNTIME_DIR, 'pnpm', 'pnpm.cjs');
  if (!fs.existsSync(cjs)) problems.push('缺少 pnpm/pnpm.cjs');
  else if (pnpmVersionOf(cjs) !== pnpm) problems.push('pnpm.cjs 版本不符（期望 ' + pnpm + '）');
  for (const f of ['pnpm.cmd', 'pnpm.ps1']) {
    if (!fs.existsSync(path.join(RUNTIME_DIR, 'pnpm', f))) problems.push('缺少 pnpm/' + f);
  }
  if (problems.length) {
    console.error('内置运行时校验失败：\n  - ' + problems.join('\n  - '));
    return false;
  }
  console.log('内置运行时校验通过：Node v' + node + ' + pnpm ' + pnpm + '（' + RUNTIME_DIR + '）');
  return true;
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? path.resolve(args[i + 1]) : '';
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = argValue(args, '--out');
  const ps1Arg = argValue(args, '--ps1');
  if (outDir) RUNTIME_DIR = outDir;
  if (ps1Arg) PS1 = ps1Arg;
  if (args.indexOf('--check') >= 0) {
    process.exit(checkRuntime() ? 0 : 1);
    return;
  }
  const force = args.indexOf('--force') >= 0;
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const { node, pnpm } = readPinnedVersions();
  console.log('内置运行时目标：Node v' + node + ' + pnpm ' + pnpm);
  const nodeInfo = await prepareNodeZip(node, force);
  writePnpmLaunchers();
  const pnpmInfo = preparePnpmCjs(pnpm, force);
  const zip = path.join(RUNTIME_DIR, nodeZipName(node));
  const cjs = path.join(RUNTIME_DIR, 'pnpm', 'pnpm.cjs');
  const manifest = {
    generatedAt: new Date().toISOString(),
    node: { version: node, file: nodeZipName(node), size: fs.statSync(zip).size, sha256: sha256(zip), source: nodeInfo.source },
    pnpm: { version: pnpm, file: 'pnpm/pnpm.cjs', size: fs.statSync(cjs).size, sha256: sha256(cjs), source: pnpmInfo.source },
  };
  writeManifest(manifest);
  if (!checkRuntime()) process.exit(1);
  console.log('运行时已就绪：' + RUNTIME_DIR);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[prepare-runtime] ' + (e && e.message ? e.message : e));
    process.exit(1);
  });
}

module.exports = { readPinnedVersions, validateNodeZip, extractNodeVersion, RUNTIME_DIR };
