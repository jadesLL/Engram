// 预构建环境包定位（纯函数，不依赖 Electron，可直接在 node 下单测）。
//
// 安装器 exe 里打包了一份「源码 + 运行时依赖 + 已构建产物」的 zip（electron-builder 的
// extraResources 把 main/installer/resources/prebuilt 放到 resources\prebuilt）时，装完即用：
// 客户机不克隆、不装依赖、不构建。开发态（未打包）从 installer/resources/prebuilt 找。
// 产出方式见 main/scripts/pack-prebuilt-bundle.ps1。
const fs = require('node:fs');
const path = require('node:path');

/** 候选目录，按优先级排列：打包后的 resources\prebuilt → 开发态的 installer\resources\prebuilt */
function bundleDirs(resourcesPath, dirname) {
  const dirs = [];
  if (resourcesPath) dirs.push(path.join(resourcesPath, 'prebuilt'));
  if (dirname) dirs.push(path.join(dirname, 'resources', 'prebuilt'));
  return dirs;
}

/**
 * 找内置环境包：返回 zip 绝对路径；多个 zip 时取「最后修改时间最新」的一个（包名带日期/版本，
 * 但改名的文件不一定排得对，时间戳才是可靠信号；时间相同再按文件名兜底）。
 * 目录不存在、读不动都当作「没有内置包」，交给源码模式。
 */
function findBundleZip({
  resourcesPath = '',
  dirname = '',
  exists = fs.existsSync,
  readdir = fs.readdirSync,
  stat = fs.statSync,
} = {}) {
  for (const dir of bundleDirs(resourcesPath, dirname)) {
    try {
      if (!exists(dir)) continue;
      const zips = readdir(dir).filter((f) => f.toLowerCase().endsWith('.zip'));
      if (!zips.length) continue;
      let best = '';
      let bestTime = -1;
      for (const name of zips) {
        const full = path.join(dir, name);
        let mtime = 0;
        try {
          mtime = stat(full).mtimeMs;
        } catch {
          mtime = 0;
        }
        if (mtime > bestTime || (mtime === bestTime && name > path.basename(best))) {
          best = full;
          bestTime = mtime;
        }
      }
      if (best) return best;
    } catch {
      /* 权限/竞争失败：继续找下一个候选 */
    }
  }
  return '';
}

/** 界面用：内置包是否可用、包名与大小（MB） */
function bundleInfo({ resourcesPath = '', dirname = '', exists, readdir, stat = fs.statSync } = {}) {
  const zip = findBundleZip({ resourcesPath, dirname, exists, readdir, stat });
  if (!zip) return { available: false };
  let sizeMB = 0;
  try {
    sizeMB = Math.round(stat(zip).size / 1048576);
  } catch {
    /* 读不到大小不影响安装 */
  }
  return { available: true, name: path.basename(zip), sizeMB };
}

module.exports = { bundleDirs, findBundleZip, bundleInfo };
