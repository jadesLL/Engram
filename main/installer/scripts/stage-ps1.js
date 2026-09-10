// 打包前把 install-engram.ps1 里的仓库地址占位符替换为本仓库真实远端地址。
// 占位符留在 Git 里（开源清洗约定），真实地址只出现在构建产物中。
// 地址取自构建用的检出目录 origin，公开 / 私有克隆各自指向自己。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const mainDir = path.resolve(__dirname, '..', '..');
const srcFile = path.join(mainDir, 'scripts', 'install-engram.ps1');
const outFile = path.resolve(__dirname, '..', 'build', 'install-engram.ps1');

function repoUrl() {
  if (process.env.ENGRAM_REPO_URL) return process.env.ENGRAM_REPO_URL;
  const raw = execFileSync('git', ['-C', mainDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  return raw.replace(/\/\/[^/@]*@/, '//'); // 去掉内嵌凭据
}

const text = fs.readFileSync(srcFile, 'utf8');
const re = /(\[string\]\$RepoUrl = ')([^']*)(')/;
if (!re.test(text)) throw new Error('install-engram.ps1 中未找到 $RepoUrl 默认值');

const url = repoUrl();
if (!url || url.includes('xxx.com')) {
  throw new Error(`仓库地址无效：${url}（设置 ENGRAM_REPO_URL，或确认 git remote origin）`);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, text.replace(re, `$1${url}$3`));
console.log(`[stage] 安装器内置克隆地址：${url}`);
