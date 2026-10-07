const fs = require('node:fs');
const path = require('node:path');

/** IPC 只接收知识库相对路径；真实路径检查同时阻止符号链接越界。 */
function resolveBrainPath(dataDir, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)
      || /^[a-z]:/i.test(relative) || relative.startsWith('\\')) throw new Error('只能打开知识库内的路径');
  const root = fs.realpathSync(path.join(dataDir, 'brain'));
  const abs = path.resolve(root, relative.replace(/\\/g, '/'));
  const within = (target) => target === root || target.startsWith(root + path.sep);
  if (!within(abs)) throw new Error('路径越界');
  if (!fs.existsSync(abs)) throw new Error('本地文件或目录不存在，请先完成同步');
  const real = fs.realpathSync(abs);
  if (!within(real)) throw new Error('路径越界');
  if (!fs.statSync(real).isFile() && !fs.statSync(real).isDirectory()) throw new Error('不支持此文件类型');
  return real;
}
module.exports = { resolveBrainPath };
