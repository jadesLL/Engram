// 桌面端打包准备：把 server/web 构建产物复制到 desktop/ 下，
// 并生成 desktop/server/package.json（仅生产依赖），供 pnpm install --prod 装出 server 运行时依赖。
// 在 main/ 根目录下执行：node desktop/scripts/prepare-desktop.js
const fs = require('node:fs');
const path = require('node:path');

const mainRoot = path.resolve(__dirname, '..', '..'); // main/
const desktopRoot = path.resolve(__dirname, '..');    // desktop/

function copyDir(src, dst) {
  if (!fs.existsSync(src)) {
    throw new Error(`源目录不存在：${src}（请先 build server 与 web）`);
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

// 1. 复制 server 构建产物
copyDir(path.join(mainRoot, 'server', 'dist'), path.join(desktopRoot, 'server', 'dist'));
// 2. 复制 web 构建产物
copyDir(path.join(mainRoot, 'web', 'dist'), path.join(desktopRoot, 'web', 'dist'));
// 3. 生成 desktop/server/package.json：仅运行时依赖，--prod 安装可得到精简 node_modules
const serverPkg = JSON.parse(fs.readFileSync(path.join(mainRoot, 'server', 'package.json'), 'utf8'));
const deps = { ...serverPkg.dependencies };
// 固定 zod 版本：server/package.json 约束 ^3.24.1，但 @modelcontextprotocol/sdk@1.30 的 zod-compat
// import 'zod/v3'，zod 3.24.1 无 ./v3 exports 致 ESM 崩溃；锁文件解析到 3.25.76，这里对齐。
if (deps.zod) deps.zod = '^3.25.76';
fs.writeFileSync(
  path.join(desktopRoot, 'server', 'package.json'),
  JSON.stringify(
    {
      name: '@example-wiki/desktop-server-runtime',
      version: serverPkg.version,
      private: true,
      type: serverPkg.type || 'commonjs',
      dependencies: deps,
    },
    null,
    2
  )
);

console.log('[prepare-desktop] 已复制 server/dist、web/dist，并生成 desktop/server/package.json');
console.log('[prepare-desktop] 下一步：pnpm -C desktop/server install --prod --shamefully-hoist（需联网，届时申请 --allow-downloads）');
