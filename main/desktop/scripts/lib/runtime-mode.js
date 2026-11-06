// 运行形态判定、git 定位与预构建安装识别（主进程与单测共用；纯函数，不依赖 Electron，可在 node 下直接 require）。
//
// 为什么不直接用 app.isPackaged：Electron 是按「可执行文件名」判定的。源码模式为了让
// 资源管理器/任务栏显示 Engram 图标，会把 electron.exe 复制一份改名成 Engram.exe
// （desktop/scripts/ensure-branded-exe.js），而同一个文件只要改了名，app.isPackaged 就从
// false 变 true —— 2026-09-22 实测（同一目录、同一参数、除 exe 名外输入完全相同）：
//   electron.exe = false；Engram.exe / probe-renamed.exe / electron-dev.exe / electron2.exe = true
// 于是从桌面快捷方式（安装器创建的就是 Engram.exe）启动的源码版会把自己当成安装包形态：
// 版本号不显示提交号（用户看到「版本号只显示 1.2.7」）、设置里丢掉源码模式区块与卸载入口、
// 源码自动检查不跑、桌面自动更新反而被启用（配了更新源时会把源码版静默换成安装包）。
// 改看打包产物本身：resources/app.asar 存在才是安装包形态 —— electron-builder（asar: true）
// 与手工 desktop/scripts/pack-asar.js 都会产出它，而源码模式跑的是 node_modules/electron/dist，
// 那里只有 Electron 自带的 default_app.asar。
const fs = require('node:fs');
const path = require('node:path');

/** 打包产物相对 resources 目录的路径（存在即为安装包形态） */
const PACKAGED_ASAR = 'app.asar';

/**
 * 是否为「安装包形态」。
 * @param {string} resourcesPath Electron 的 process.resourcesPath
 * @param {(p: string) => boolean} [exists] 便于单测注入
 */
function isPackagedRuntime(resourcesPath, exists = fs.existsSync) {
  if (!resourcesPath) return false;
  try {
    return Boolean(exists(path.join(resourcesPath, PACKAGED_ASAR)));
  } catch {
    return false; // 探测失败按源码模式处理：源码模式的入口更多、退化更安全
  }
}

/** 便携 MinGit 相对 %LOCALAPPDATA% 的路径（install-engram.ps1 的默认安装根） */
const PORTABLE_GIT_REL = ['engram', 'MinGit', 'cmd', 'git.exe'];

/** 便携 Node 相对 %LOCALAPPDATA% 的路径（install-engram.ps1 的默认安装根，与 server/assistant/agentNode.ts 同一约定） */
const PORTABLE_NODE_REL = ['engram', 'node', 'node.exe'];

/**
 * 预构建环境包安装标记（相对 main/ 根）：pack-prebuilt-bundle.ps1 打进包里、
 * install-engram.ps1 覆盖安装时也会写一份。
 *
 * 这类安装没有 .git、也不带 Git（安装器刻意删掉旧 .git，见 installer/resources/prebuilt/README.md），
 * 所以应用内「检查更新」（git pull + 重建）根本不可用；更新方式是重跑新版安装器覆盖安装。
 * 2026-11-06 客户端实例实测：预构建安装仍按源码模式跑 git 检查，设置页永远挂着
 * 「自动检查失败: spawn git ENOENT」，用户看不出这是安装形态限制。
 */
const PREBUILT_MANIFEST = '.engram-prebuilt.json';

/**
 * 读预构建安装标记。返回 null 表示不是预构建安装；返回对象时带上包清单里的提交号与打包时间
 * （预构建安装没有 .git，版本行只能靠它们说明「装的是哪次打包」）。
 * 标记文件存在但内容坏了也按预构建处理：没有 .git 的事实不会因 JSON 损坏而改变，
 * 误判成源码模式只会让用户又看到一轮 git 报错。
 *
 * @param {string} appRoot main/ 根目录
 * @param {(p: string) => boolean} [exists]
 * @param {(p: string, enc: string) => string} [readFile]
 * @returns {{ commit: string, builtAt: string, mode: string, bundle: string } | null}
 */
function readPrebuiltManifest(appRoot, exists = fs.existsSync, readFile = fs.readFileSync) {
  if (!appRoot) return null;
  const file = path.join(appRoot, PREBUILT_MANIFEST);
  try {
    if (!exists(file)) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(readFile(file, 'utf8'));
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    return {
      commit: text(data.commit),
      builtAt: text(data.builtAt),
      mode: text(data.mode) || 'prebuilt',
      bundle: text(data.bundle),
    };
  } catch {
    return { commit: '', builtAt: '', mode: 'prebuilt', bundle: '' };
  }
}

/**
 * 当前安装目录是否在 git 检出里：.git 可能在 main/ 本身（单目录检出）或它的上一级
 * （源码版默认布局 %LOCALAPPDATA%\\engram\\Engram\\main，仓库根在上一级）。
 * 只拷了 main/ 或手工删了 .git 的安装没有可比对远端的仓库，应用内源码更新同样不可用；
 * 主进程据此给出「用安装器覆盖安装」的说明，而不是让 git 反复报 not a git repository。
 *
 * @param {string} appRoot main/ 根目录
 * @param {(p: string) => boolean} [exists]
 */
function isGitCheckout(appRoot, exists = fs.existsSync) {
  if (!appRoot) return false;
  for (const candidate of [path.join(appRoot, '.git'), path.join(path.dirname(appRoot), '.git')]) {
    try {
      if (exists(candidate)) return true;
    } catch {
      /* 探测失败按非检出处理：后续会给出安装器更新说明 */
    }
  }
  return false;
}

/** git 可执行文件名（Windows 上是 git.exe，源码模式安装目录里的是 MinGit 的 cmd\git.exe） */
function gitBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'git.exe' : 'git';
}

/**
 * 在 PATH 里找 git，返回绝对路径（找不到返回空串）。
 * 裸 spawn('git') 依赖操作系统自己搜 PATH：找不到时只回一个 ENOENT（日志/界面里就是
 * 「spawn git ENOENT」），既看不出找过哪些目录，也无法给用户可执行的建议。
 */
function findGitInPath(env = process.env, exists = fs.existsSync, platform = process.platform) {
  const pathValue = env.PATH || env.Path || '';
  const binary = gitBinaryName(platform);
  for (const raw of String(pathValue).split(path.delimiter)) {
    const dir = String(raw).trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (exists(candidate)) return candidate;
    } catch {
      /* 单个 PATH 条目探测失败不影响其余条目 */
    }
  }
  return '';
}

/**
 * Git for Windows 的常见安装位置。PATH 没继承到 git 的场景不少（装完 Git 没重启资源管理器、
 * 从开机自启/计划任务拉起、用户级 PATH 被工具覆盖），这些位置兜底，
 * 避免「机器上明明装了 Git，应用却报 spawn git ENOENT」。
 */
function commonGitCandidates(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return [];
  const candidates = [];
  for (const dir of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(dir, 'Git', 'bin', 'git.exe'));
  }
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || '';
  if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'));
  return candidates;
}

/**
 * 解析 git：返回可执行文件与来源，供 spawn 与错误提示共用。
 *
 * 顺序：便携 MinGit（安装器装在 %LOCALAPPDATA%\engram\MinGit，固定版本）→ PATH →
 * Windows 常见安装目录 → 'git' 兜底（交给系统解析，命中 PATHEXT 包装等仍可成功）。
 * 每次调用都重新解析（而非模块加载时定死）：全新机先装应用、后补 Git 的场景也能自愈。
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {(p: string) => boolean} [exists]
 * @param {NodeJS.Platform} [platform]
 * @returns {{ command: string, source: 'portable'|'path'|'common'|'fallback', searched: string[] }}
 */
function resolveGit(env = process.env, exists = fs.existsSync, platform = process.platform) {
  const searched = [];
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || '';
  if (localAppData) {
    const portable = path.join(localAppData, ...PORTABLE_GIT_REL);
    searched.push(portable);
    try {
      if (exists(portable)) return { command: portable, source: 'portable', searched };
    } catch {
      /* 探测失败退回后续候选 */
    }
  }
  const fromPath = findGitInPath(env, exists, platform);
  if (fromPath) {
    searched.push(fromPath);
    return { command: fromPath, source: 'path', searched };
  }
  for (const candidate of commonGitCandidates(env, platform)) {
    searched.push(candidate);
    try {
      if (exists(candidate)) return { command: candidate, source: 'common', searched };
    } catch {
      /* 单个候选探测失败不影响其余候选 */
    }
  }
  // 兜底仍交给系统搜索（'git' 在 Windows 上也由创建进程按 PATH/PATHEXT 解析），
  // 保留旧语义，避免把 'git.exe' 写死进 spawn 参数。
  return { command: 'git', source: 'fallback', searched };
}

/**
 * 解析 git 可执行文件路径（兼容旧调用点；需要来源与查找线索时用 resolveGit）。
 *
 * 全新机没有系统 Git 时，安装器把便携 MinGit 放在 %LOCALAPPDATA%\engram\MinGit，并且
 * **刻意不写系统环境变量**（install-engram.ps1：便携目录只存在于安装器进程的 PATH 里），
 * 而主进程是用户双击快捷方式启动的、继承不到那段 PATH。裸 spawn('git') 因此直接 ENOENT：
 * 提交号不显示、设置里的「检查更新」与「更新并重启」全报 git 不可用（2026-09-22 定位）。
 * 更新脚本（scripts/update-from-source.ps1）自己会前置便携目录，主进程照做即可。
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {(p: string) => boolean} [exists]
 * @param {NodeJS.Platform} [platform]
 */
function resolveGitCommand(env = process.env, exists = fs.existsSync, platform = process.platform) {
  return resolveGit(env, exists, platform).command;
}

/** 当前平台的 Node 可执行文件名 */
function nodeBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * 解析内置 Agent（dsh）要用的「真实 Node.js」。
 *
 * 为什么主进程要管这个：桌面端内嵌 server 跑在 Electron 的纯 Node 模式里
 * （ELECTRON_RUN_AS_NODE=1，process.execPath 是 Engram.exe），而 dsh 的原生模块不认
 * Electron 36 的 V8 指纹（详见 server/src/assistant/agentNode.ts 顶部注释）。必须把真实
 * Node 的路径传给 server（环境变量 ENGRAM_NODE_BIN），控制台与聊天才能拉起 dsh。
 *
 * 解析顺序（与 server 侧一致，但主进程先做一轮，避免 server 只认一个 PATH 环境）：
 *  1. ENGRAM_NODE_BIN：显式覆盖（测试 / 特殊部署）；
 *  2. 安装包随包 Node：<resources>/node/node.exe（desktop/package.json extraResources）；
 *  3. 源码模式便携 Node：%LOCALAPPDATA%\engram\node\node.exe（install-engram.ps1 装的）；
 *  4. PATH 里的 node（源码模式机器通常有）。
 * 返回 null 表示没有可用 Node：内置 Agent 会给出明确提示（而不是 Electron 指纹崩溃）。
 *
 * @param {{
 *   resourcesPath?: string,
 *   env?: Record<string, string | undefined>,
 *   exists?: (p: string) => boolean,
 *   platform?: NodeJS.Platform,
 *   execPath?: string,
 * }} [options]
 * @returns {{ path: string, source: 'env'|'bundled'|'portable'|'path' } | null}
 */
function resolveNodeRuntime(options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const platform = options.platform || process.platform;
  const execPath = options.execPath || process.execPath;
  const binary = nodeBinaryName(platform);
  const seen = new Set();
  const candidates = [];
  const push = (file, source) => {
    if (!file) return;
    const normalized = path.resolve(file);
    if (seen.has(normalized)) return;
    if (execPath && path.resolve(execPath) === normalized) return; // 进程自身（Electron）不能当 Node
    try {
      if (!exists(normalized)) return;
    } catch {
      return;
    }
    seen.add(normalized);
    candidates.push({ path: normalized, source });
  };

  push(env.ENGRAM_NODE_BIN, 'env');
  if (options.resourcesPath) push(path.join(options.resourcesPath, 'node', binary), 'bundled');
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || '';
  if (localAppData) push(path.join(localAppData, ...PORTABLE_NODE_REL), 'portable');
  const pathValue = env.PATH || env.Path || '';
  for (const raw of pathValue.split(path.delimiter)) {
    const dir = String(raw).trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    push(path.join(dir, binary), 'path');
  }
  return candidates[0] || null;
}

module.exports = {
  PACKAGED_ASAR,
  PORTABLE_GIT_REL,
  PORTABLE_NODE_REL,
  PREBUILT_MANIFEST,
  isPackagedRuntime,
  readPrebuiltManifest,
  isGitCheckout,
  gitBinaryName,
  findGitInPath,
  commonGitCandidates,
  resolveGit,
  resolveGitCommand,
  resolveNodeRuntime,
};
