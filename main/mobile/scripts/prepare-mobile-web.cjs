const fs = require('node:fs');
const path = require('node:path');

const mobileRoot = path.resolve(__dirname, '..');
const source = path.resolve(mobileRoot, '../web/dist');
const destination = path.join(mobileRoot, 'web-dist');

if (!fs.existsSync(path.join(source, 'index.html'))) {
  throw new Error('缺少 web/dist；请先执行 pnpm --filter @engram/web build');
}
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
console.log(`Android Web 资产已准备：${destination}`);
