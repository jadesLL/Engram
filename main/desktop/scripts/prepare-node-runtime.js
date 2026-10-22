// 准备随包 Node 运行时（main/desktop/node/node.exe），供 electron-builder 的 extraResources
// 搬进安装包 resources/node/node.exe。桌面端内置 Agent（dsh）必须用真实 Node 跑，
// 原因见 server/src/assistant/agentNode.ts 顶部注释。
//
// 用法：
//   node desktop/scripts/prepare-node-runtime.js                  # Windows 打包机：复制本机 node.exe
//   node desktop/scripts/prepare-node-runtime.js --from <node.exe># 指定一份 node.exe
//   node desktop/scripts/prepare-node-runtime.js --download       # CI（Linux 容器）：按固定版本下载 win32-x64 node.exe
//   node desktop/scripts/prepare-node-runtime.js --verify-only    # 只校验现有产物（打包前守门）
//
// 参数：
//   --version <x.y.z>  下载/期望版本（默认与 install-engram.ps1 对齐的固定版本）
//   --force            已有产物也重新生成
//
// 产物不入 Git（main/.gitignore 里 desktop/node/），每次打包现生成；CI 与本地手动打包共用本脚本。
const fs = require('node:fs');
const path = require('node:path');
const rt = require('./lib/node-runtime');

const desktopRoot = path.resolve(__dirname, '..');
const target = rt.bundledNodePath(desktopRoot);

function parseArgs(argv) {
  const args = { download: false, verifyOnly: false, force: false, from: '', version: rt.NODE_VERSION };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--download') args.download = true;
    else if (arg === '--verify-only') args.verifyOnly = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--from') args.from = argv[++i] || '';
    else if (arg === '--version') args.version = argv[++i] || rt.NODE_VERSION;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function usage() {
  console.log(
    [
      '用法：node desktop/scripts/prepare-node-runtime.js [--download] [--from <node.exe>] [--version <x.y.z>] [--verify-only] [--force]',
      '',
      '  （默认）Windows 打包机：复制本机 node.exe 到 desktop/node/node.exe',
      '  --download  从镜像下载固定版本的 win32-x64 node.exe（CI 用）',
      '  --verify-only  只校验 desktop/node/node.exe 是否就绪（不生成）',
    ].join('\n'),
  );
}

function describe(validation) {
  return `${(validation.size / 1048576).toFixed(1)}MB sha256=${validation.sha256.slice(0, 12)}…`;
}

function existingIsReusable(version) {
  const validation = rt.validateNodeExeFile(target);
  if (!validation.ok) return { ok: false, validation };
  const record = rt.readBundleRecord(desktopRoot);
  const sameFile = record && record.sha256 === validation.sha256 && record.bytes === validation.size;
  // 下载模式要同一个固定版本；本地复制模式只要求同一份文件（版本可能随打包机 Node 变化）
  const sameVersion = !version || !record || record.version === version;
  return { ok: Boolean(sameFile && sameVersion), validation, record };
}

async function fetchToFile(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(file, data);
  return data.length;
}

async function download(version) {
  const urls = rt.nodeExeUrls(version);
  const temp = target + '.download';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const failures = [];
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        console.log(`[prepare-node] 下载 ${url}（第 ${attempt} 次）`);
        const bytes = await fetchToFile(url, temp);
        const validation = rt.validateNodeExeFile(temp);
        if (!validation.ok) throw new Error(validation.error);
        fs.rmSync(target, { force: true });
        fs.renameSync(temp, target);
        console.log(`[prepare-node] ✓ 下载完成 v${version}（${describe(validation)}）`);
        return { version, source: url, validation };
      } catch (error) {
        failures.push(`${url} #${attempt}: ${error.message}`);
        fs.rmSync(temp, { force: true });
      }
    }
  }
  throw new Error('所有镜像都下载失败：\n  ' + failures.join('\n  '));
}

/** 从本机 Node 复制：脚本本身就是 node 起的，默认取 process.execPath（Windows 打包机即本机 node.exe） */
function copyLocal(from) {
  const source = from || process.execPath;
  if (!source) throw new Error('没有可用的本机 node.exe（请用 --from 指定，或 --download）');
  const current = process.versions.node;
  if (!current || Number(current.split('.')[0]) < 20) {
    throw new Error(`本机 Node 版本过低（v${current}），桌面端内置 Agent 需要 20+`);
  }
  console.log(`[prepare-node] 复制本机 Node v${current}：${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const validation = rt.validateNodeExeFile(target);
  if (!validation.ok) throw new Error(`复制后的 node.exe 校验失败：${validation.error}`);
  console.log(`[prepare-node] ✓ ${describe(validation)}`);
  return { version: current, source, validation };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  if (args.verifyOnly) {
    const validation = rt.validateNodeExeFile(target);
    if (!validation.ok) throw new Error(`随包 Node 运行时未就绪：${validation.error}（先运行 node desktop/scripts/prepare-node-runtime.js）`);
    const record = rt.readBundleRecord(desktopRoot);
    console.log(`[prepare-node] ✓ 就绪：node v${record && record.version ? record.version : '?'}（${describe(validation)}）`);
    return;
  }

  if (!args.force) {
    const reusable = existingIsReusable(args.download ? args.version : '');
    if (reusable.ok) {
      console.log(`[prepare-node] ✓ 已就绪，跳过（${describe(reusable.validation)}）`);
      return;
    }
  }

  const made = args.download ? await download(args.version) : copyLocal(args.from);
  rt.writeBundleRecord(desktopRoot, {
    version: made.version,
    source: made.source,
    bytes: made.validation.size,
    sha256: made.validation.sha256,
    electron: false,
    note: '桌面端内置 Agent（dsh）必须用真实 Node 启动，不能用 Electron 的纯 Node 模式',
  });
  console.log(`[prepare-node] 记录：${rt.bundleRecordPath(desktopRoot)}`);
}

main().catch((error) => {
  console.error('[prepare-node] ✗ ' + (error && error.message ? error.message : error));
  process.exit(1);
});
