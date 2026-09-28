// Electron 版本 → 原生模块 ABI（NODE_MODULE_VERSION）解析，以及打包产物里 .node 的 ABI 校验。
//
// 为什么必须集中解析、不能写死（2026-09-28 v1.3.0 事故根因）：
// CI 打包脚本把 better-sqlite3 的 Electron 预编译文件名写死成 `electron-v133`（写死时的 Electron 是 35），
// 而 desktop/package.json 已于 2026-09-16 升到 Electron 36（ABI 135）。没人同步，CI 照旧全绿，
// 发布出去的 1.3.0 exe 里 better_sqlite3.node 与打包的 Electron ABI 不符 —— 内嵌 server 一启动就
// `ERR_DLOPEN_FAILED`（NODE_MODULE_VERSION 133 vs 135）退出，桌面端只显示
// 「本地服务启动失败：启动超时或内嵌服务异常」，所有装了 1.3.0 的机器都进不去。
// 故：ABI 一律由「本次实际打包的 Electron 版本」推导，并在打包完成后静态校验产物里的 .node。
//
// ABI 表来源：node-abi 的 abi_registry.json（Electron 主版本内稳定版的 ABI 恒定；
// 30 → 123、31 → 125、35 → 133、36 → 135 …）。表是兜底，能 require 到 node-abi 时以它为权威。
const fs = require('node:fs');
const path = require('node:path');

/** Electron 主版本 → ABI（取自 node-abi abi_registry.json，同一主版本取最终稳定版的 ABI） */
const ELECTRON_ABI_BY_MAJOR = {
  '20': 107,
  '21': 109,
  '22': 110,
  '23': 113,
  '24': 114,
  '25': 116,
  '26': 116,
  '27': 118,
  '28': 119,
  '29': 121,
  '30': 123,
  '31': 125,
  '32': 128,
  '33': 130,
  '34': 132,
  '35': 133,
  '36': 135,
  '37': 136,
  '38': 139,
  '39': 140,
  '40': 143,
  '41': 145,
  '42': 146,
  '43': 148,
  '44': 149,
};

/** 版本串归一化：去掉前导 v/-、prerelease 与构建号，只留 x.y.z */
function normalizeElectronVersion(version) {
  const m = String(version || '').match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] || 0), patch: Number(m[3] || 0), text: `${m[1]}.${m[2] || 0}.${m[3] || 0}` };
}

/** 取主版本号（'36.9.5' → 36） */
function electronMajor(version) {
  const parsed = normalizeElectronVersion(version);
  if (!parsed) throw new Error(`无法解析 Electron 版本号：${version}`);
  return parsed.major;
}

/**
 * 从 node-abi 注册表查 ABI（**只给测试做交叉校验用，打包路径不依赖它**）。
 *
 * 为什么打包路径不拿它当权威：node-abi 的 `getAbi()` 第一行就是
 * `if (target === String(Number(target))) return target;` —— 纯数字 target 会原样返回（它借此支持
 * 「直接把 ABI 传进来」）。拿 `String(major)` 之类的字符串去问，未知版本会被当成 ABI 回显，
 * 静默给出错误答案 —— 正是 v1.3.0 那类事故的翻版。故内置表是权威，node-abi 只用来验证表没落后。
 */
function lookupAbiFromRegistry(version) {
  const parsed = normalizeElectronVersion(version);
  if (!parsed) return null;
  let nodeAbi;
  try {
    // eslint-disable-next-line global-require
    nodeAbi = require('node-abi');
  } catch {
    return null;
  }
  try {
    // 只传完整 x.y.z；纯数字会被原样回显（见函数注释）
    const abi = nodeAbi.getAbi(parsed.text, 'electron');
    return /^\d+$/.test(String(abi)) ? Number(abi) : null;
  } catch {
    return null; // 注册表里没有这个版本
  }
}

/**
 * Electron 版本 → 原生模块 ABI。
 * 解析不出来（未知主版本、预发布版本）直接抛错：宁可打包失败，也不能再拿错 ABI 的预编译发出去。
 */
function abiForElectronVersion(version) {
  const raw = String(version == null ? '' : version).trim();
  const parsed = normalizeElectronVersion(raw);
  if (!parsed) throw new Error(`无法解析 Electron 版本号：${version}`);
  if (/^\d+(\.\d+)*[-+]/.test(raw.replace(/^v/, ''))) {
    throw new Error(
      `Electron ${raw} 是预发布版本，ABI 可能与稳定版不同（例如 31 的 alpha 是 123、稳定版是 125）：` +
        '请用稳定版打包；确要用预发布版就人工确认后往 ELECTRON_ABI_BY_MAJOR 里补一条',
    );
  }
  const known = ELECTRON_ABI_BY_MAJOR[String(parsed.major)];
  if (known !== undefined) return known;
  throw new Error(
    `Electron ${parsed.text} 的 ABI 不在内置表里（表只覆盖到主版本 ${Object.keys(ELECTRON_ABI_BY_MAJOR).pop()}）：` +
      '请从 node-abi 的 abi_registry.json 补表，或在能跑该 Electron 的环境里读 process.versions.modules',
  );
}

/**
 * 读原生模块里内嵌的 ABI 标记（纯静态读文件，不需要运行它）：
 * node-gyp/NAPI 生成的原生模块导出符号里带着 ABI，例如 `node_register_module_v135`。
 * 返回 { kind: 'module', abi } / { kind: 'napi' }（NAPI 模块跨 ABI 稳定，无需比对）/ null（读不出）。
 */
function readBindingAbi(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const text = buf.toString('latin1');
  const moduleSymbol = text.match(/node_register_module_v(\d+)/);
  if (moduleSymbol) return { kind: 'module', abi: Number(moduleSymbol[1]) };
  if (/napi_register_module_v\d+/.test(text)) return { kind: 'napi' };
  return null;
}

/**
 * 校验一个原生模块的 ABI 是否与目标 Electron 一致；不一致就抛出可直接定位问题的错误。
 * 返回 { bindingFile, abi, expectedAbi, electronVersion }。
 */
function assertBindingAbi({ bindingFile, electronVersion, label = 'better_sqlite3.node' }) {
  if (!fs.existsSync(bindingFile)) throw new Error(`找不到原生模块：${bindingFile}`);
  const expectedAbi = abiForElectronVersion(electronVersion);
  const found = readBindingAbi(bindingFile);
  if (!found) {
    throw new Error(
      `${label} 读不出 ABI 标记（既不是 node-gyp 模块也不是 NAPI 模块？）：${bindingFile}\n` +
        `  期望：Electron ${electronVersion} → ABI ${expectedAbi}`,
    );
  }
  if (found.kind === 'napi') return { bindingFile, abi: null, expectedAbi, electronVersion, napi: true };
  if (found.abi !== expectedAbi) {
    throw new Error(
      `${label} 的 ABI 与打包的 Electron 不匹配：模块是 ABI ${found.abi}，打包的 Electron ${electronVersion} 需要 ABI ${expectedAbi}。\n` +
        `  文件：${bindingFile}\n` +
        '  后果：内嵌 server 一启动就 ERR_DLOPEN_FAILED 退出，桌面端只显示「本地服务启动失败」。\n' +
        '  修法：按打包的 Electron 版本重新取 prebuild（见 scripts/build-desktop-ci.sh 的 ABI 推导段）。',
    );
  }
  return { bindingFile, abi: found.abi, expectedAbi, electronVersion, napi: false };
}

/** 在目录里递归找 better_sqlite3.node（asar 解包后的布局层级不固定，hoisted/嵌套都要能找到） */
function findBetterSqlite3Binding(root) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name === 'better_sqlite3.node' && /[\\/]build[\\/]Release[\\/]better_sqlite3\.node$/.test(p)) hits.push(p);
    }
  };
  walk(root, 0);
  if (!hits.length) {
    const legacy = path.join(root, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    return fs.existsSync(legacy) ? legacy : null;
  }
  // 多个候选时优先 server/node_modules 下的那份（打包清单里就是它）
  hits.sort((a, b) => Number(b.includes(`server${path.sep}node_modules`)) - Number(a.includes(`server${path.sep}node_modules`)));
  return hits[0];
}

module.exports = {
  ELECTRON_ABI_BY_MAJOR,
  abiForElectronVersion,
  lookupAbiFromRegistry,
  electronMajor,
  normalizeElectronVersion,
  readBindingAbi,
  assertBindingAbi,
  findBetterSqlite3Binding,
};
