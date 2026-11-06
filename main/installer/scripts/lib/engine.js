// 安装引擎选择：安装器 exe 自带 install-engram.ps1，已装过的机器在
// %LOCALAPPDATA%\engram\Engram\main\scripts\ 里可能还有一份克隆引擎（随 git pull 更新）。
// 旧逻辑「克隆优先」会让旧克隆里的旧引擎盖掉 exe 里的新修复——2026-11-06 客户机实测：
// 换上新引擎后安装器仍跑旧克隆脚本，继续报同一条 Unknown command: "file"。
// 改为按引擎版本取高者；版本相同仍优先克隆，保留「引擎随 git pull 热更新、不必重打 exe」的好处。
//
// 版本标记写在部署脚本头部注释： # ENGINE_VERSION: 2（没有标记的旧引擎按 1 处理）。
const fs = require('node:fs');

const ENGINE_VERSION_RE = /^\s*#\s*ENGINE_VERSION:\s*(\d+)\s*$/m;
const LEGACY_ENGINE_VERSION = 1;

function parseEngineVersion(text) {
  if (typeof text !== 'string') return null;
  const m = ENGINE_VERSION_RE.exec(text);
  if (!m) return LEGACY_ENGINE_VERSION;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : LEGACY_ENGINE_VERSION;
}

function readEngineVersion(file) {
  if (!file) return null;
  try {
    return parseEngineVersion(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null; // 读不到视为不存在（被锁/权限/已删除）
  }
}

// 返回应执行的引擎路径；两个候选都不存在时返回空串（调用方自行回退到开发态路径）。
// 克隆版本 >= 内置版本时走克隆（版本相同也优先克隆）。
function pickEngine(bundledPath, clonedPath) {
  const bundledVer = readEngineVersion(bundledPath);
  const clonedVer = readEngineVersion(clonedPath);
  if (clonedVer === null) return bundledVer === null ? '' : bundledPath;
  if (bundledVer === null) return clonedPath;
  return clonedVer >= bundledVer ? clonedPath : bundledPath;
}

module.exports = { LEGACY_ENGINE_VERSION, ENGINE_VERSION_RE, parseEngineVersion, readEngineVersion, pickEngine };
