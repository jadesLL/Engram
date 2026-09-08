// 依赖同步判定（应用内更新与 scripts/update-from-source.ps1 共用同一套判断）
//
// 背景：源码模式更新 = git pull + 重建。依赖清单变了就得先装依赖，但「清单文件被改动」
// 不等于「依赖变了」——appId / scripts / build 之类的元信息改动同样会改到 package.json。
// 2026-09-09 的开源改名提交把 desktop/package.json 的 appId 从 com.llmwiki.app 改成
// com.engram.app，应用内更新却按「文件被改」判定依赖变化并要求用户去终端跑脚本；
// 而那次终端脚本又因为 ORIG_HEAD 已被应用内 pull 重置，判定「无清单变化」直接跳过了安装。
//
// 这里改成两件事：
//   1. 依赖指纹：只哈希 pnpm-lock.yaml / pnpm-workspace.yaml 原文 + 各 package.json 的
//      依赖字段（dependencies/devDependencies/optionalDependencies/peerDependencies/
//      packageManager），元信息改动不再触发安装。
//   2. 安装记录：安装成功后把指纹写进 node_modules/.engram-deps.json，之后拿当前指纹与
//      记录比对，不依赖 ORIG_HEAD，应用内 pull 过再跑脚本也不会漏装。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 参与指纹的原文文件（lockfile 与 workspace 配置本身即依赖声明） */
const RAW_MANIFESTS = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];
/** 参与指纹的 package.json（只取依赖字段） */
const PACKAGE_MANIFESTS = ['package.json', 'server/package.json', 'web/package.json', 'desktop/package.json'];
/** 影响安装结果的 package.json 字段 */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'packageManager'];
/** 安装记录文件名（位于 node_modules 内，不入 Git） */
const RECORD_NAME = '.engram-deps.json';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sortObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

/** 取 package.json 中影响安装的字段（键排序，避免书写顺序造成假差异） */
function pickDepFields(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const out = {};
  for (const field of DEP_FIELDS) {
    const value = pkg[field];
    if (typeof value === 'string' && value) out[field] = value;
    else if (value && typeof value === 'object' && Object.keys(value).length) out[field] = sortObject(value);
  }
  return out;
}

/** 工作区依赖指纹：lockfile/workspace 原文 + 四个 package.json 的依赖字段 */
function workspaceFingerprint(appRoot) {
  const parts = {};
  for (const rel of RAW_MANIFESTS) parts[rel] = readText(path.join(appRoot, rel));
  for (const rel of PACKAGE_MANIFESTS) parts[rel] = pickDepFields(readJson(path.join(appRoot, rel)));
  return { fingerprint: sha256(JSON.stringify(parts)), parts };
}

function recordFile(dir) {
  return path.join(dir, RECORD_NAME);
}

function readRecord(dir) {
  return readJson(recordFile(dir));
}

/** 写安装记录：只在安装成功后调用，指纹按安装后的实际状态重新计算 */
function writeRecord(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordFile(dir), JSON.stringify(data, null, 2) + '\n');
}

function electronVersion(appRoot) {
  return readJson(path.join(appRoot, 'desktop', 'node_modules', 'electron', 'package.json'))?.version || '';
}

function betterSqlite3Version(appRoot) {
  return readJson(path.join(appRoot, 'desktop', 'server', 'node_modules', 'better-sqlite3', 'package.json'))?.version || '';
}

/** desktop/server 运行时依赖指纹：prepare-desktop 生成的 package.json 依赖字段 + 原生模块 ABI 相关版本 */
function serverFingerprint(appRoot) {
  const pkg = readJson(path.join(appRoot, 'desktop', 'server', 'package.json'));
  const parts = {
    deps: pickDepFields(pkg),
    electronVersion: electronVersion(appRoot),
    betterSqlite3Version: betterSqlite3Version(appRoot),
  };
  return { fingerprint: sha256(JSON.stringify(parts)), parts };
}

/** 工作区依赖是否需要安装（node_modules 缺失、无记录、指纹变化三者之一） */
function workspaceInstallState(appRoot) {
  const { fingerprint } = workspaceFingerprint(appRoot);
  const nodeModules = path.join(appRoot, 'node_modules');
  const record = readRecord(nodeModules);
  if (!fs.existsSync(nodeModules)) return { needed: true, reason: 'node_modules 缺失', fingerprint };
  if (!record || !record.fingerprint) return { needed: true, reason: '没有上次安装记录', fingerprint };
  if (record.fingerprint !== fingerprint) return { needed: true, reason: '依赖指纹变化', fingerprint };
  return { needed: false, reason: '依赖无变化', fingerprint };
}

/**
 * desktop/server 运行时依赖状态。
 *  - needsInstall：prod 依赖需要（重）装
 *  - needsNative：better-sqlite3 的 Electron ABI binding 需要（重）取——文件缺失，
 *    或 Electron / better-sqlite3 版本变了（pnpm 的 install 脚本可能装成系统 Node 的 ABI）
 *  - needsElectronRuntime：Electron 运行时缺失（pnpm 升级 electron 包后 dist 可能没落盘）
 */
function serverInstallState(appRoot) {
  const serverDir = path.join(appRoot, 'desktop', 'server');
  const nodeModules = path.join(serverDir, 'node_modules');
  const { fingerprint } = serverFingerprint(appRoot);
  const record = readRecord(nodeModules);
  const binding = path.join(nodeModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const electronExe = path.join(appRoot, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
  const hasNodeModules = fs.existsSync(nodeModules);

  let installReason = '';
  if (!hasNodeModules) installReason = 'desktop/server/node_modules 缺失';
  else if (!record || !record.fingerprint) installReason = '没有上次安装记录';
  else if (record.fingerprint !== fingerprint) installReason = '运行时依赖指纹变化';

  let nativeReason = '';
  if (!fs.existsSync(binding)) nativeReason = 'better-sqlite3 native binding 缺失';
  else if (!record) nativeReason = '没有安装记录，无法确认 binding 的 Electron ABI';
  else if (record.electronVersion !== electronVersion(appRoot)) nativeReason = 'Electron 版本变化，需重取 prebuild';
  else if (record.betterSqlite3Version !== betterSqlite3Version(appRoot)) nativeReason = 'better-sqlite3 版本变化，需重取 prebuild';

  return {
    fingerprint,
    needsInstall: Boolean(installReason),
    installReason,
    needsNative: Boolean(nativeReason),
    nativeReason,
    needsElectronRuntime: !fs.existsSync(electronExe),
    electronVersion: electronVersion(appRoot),
    betterSqlite3Version: betterSqlite3Version(appRoot),
  };
}

/**
 * 解析 pnpm 的 JS 入口：优先仓库内共享副本（WORKTREES.md 约定的 main/node_modules/pnpm），
 * 其次 pnpm 作为依赖被装进 .pnpm 存储的路径。找不到时调用方回退到 PATH 上的 pnpm。
 */
function resolvePnpmEntry(appRoot) {
  const candidates = [path.join(appRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')];
  const store = path.join(appRoot, 'node_modules', '.pnpm');
  try {
    for (const name of fs.readdirSync(store)) {
      if (/^pnpm@/.test(name)) candidates.push(path.join(store, name, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
    }
  } catch {
    /* 无 .pnpm 存储 */
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

module.exports = {
  RAW_MANIFESTS,
  PACKAGE_MANIFESTS,
  DEP_FIELDS,
  RECORD_NAME,
  pickDepFields,
  workspaceFingerprint,
  serverFingerprint,
  workspaceInstallState,
  serverInstallState,
  resolvePnpmEntry,
  readRecord,
  writeRecord,
  recordFile,
};
