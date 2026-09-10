// 数据仓库（DATA_DIR）路径判定：纯函数，供主进程与单测共用。
// 切换仓库不迁移数据，只校验目标目录合法性与是否已有仓库。
const path = require('node:path');
const fs = require('node:fs');

// Windows 路径大小写不敏感（C:\Data 与 c:\data 是同一目录），比较前统一归一
function normalize(dir) {
  const abs = path.resolve(String(dir));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function samePath(a, b) {
  return normalize(a) === normalize(b);
}

/** child 是否位于 parent 内部（含盘根边界；parent 自身不算内部） */
function isInside(parent, child) {
  const p = normalize(parent);
  const c = normalize(child);
  if (p === c) return false;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

/** 目标目录是否已是一个 Engram 仓库：以 wiki.db 为准（brain/ 可能只是同名普通目录） */
function hasRepo(dir) {
  return fs.existsSync(path.join(dir, 'wiki.db'));
}

/**
 * 校验能否切换到 target。返回 null 表示可以切换，否则返回
 * { same: true } 或 { error }。两个方向的嵌套都要拦：选到子目录会自我嵌套，
 * 选到父目录则旧仓库会被新仓库包住（Obsidian 同样禁止）。
 */
function validateSwitch(current, target) {
  if (samePath(current, target)) return { same: true };
  if (isInside(current, target)) return { error: '新位置不能在当前数据目录内部' };
  if (isInside(target, current)) return { error: '新位置不能是当前数据目录的上级目录' };
  return null;
}

module.exports = { normalize, samePath, isInside, hasRepo, validateSwitch };
