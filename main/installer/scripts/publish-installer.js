#!/usr/bin/env node
// 把源码版安装器发布到 Gitea generic 包的固定版本 latest —— 稳定下载链接，不随发版走。
// 安装器是「引导器」：永远指向最新，故与 v* 版本 Release 解耦，单独发布。
//
// 用法（在 main/ 下）：
//   ENGRAM_GITEA_TOKEN=<令牌> node installer/scripts/publish-installer.js [exe路径]
// 可选环境变量：ENGRAM_GITEA_HOST / ENGRAM_GITEA_OWNER（默认取自 git remote origin）
// 令牌需具备 package 写权限。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PKG = 'engram-installer';
const VER = 'latest';
const FILE = 'Engram-source-setup.exe';

const mainDir = path.resolve(__dirname, '..', '..');
const exe = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(mainDir, 'installer', 'dist', FILE);

function parseRemote(url) {
  const m = url.match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`无法解析远端地址：${url}`);
  return { host: m[1], owner: m[2] };
}

async function main() {
  if (!fs.existsSync(exe)) {
    throw new Error(`未找到安装器：${exe}（先 pnpm -C installer dist）`);
  }
  const token = process.env.ENGRAM_GITEA_TOKEN;
  const user = process.env.ENGRAM_GITEA_USER;
  const pass = process.env.ENGRAM_GITEA_PASS;
  if (!token && !(user && pass)) {
    throw new Error(
      '需要凭据：ENGRAM_GITEA_TOKEN（推荐，Gitea 访问令牌含 package 写权限）' +
        '，或 ENGRAM_GITEA_USER + ENGRAM_GITEA_PASS（账号密码 basic auth）',
    );
  }
  const authHeader = token
    ? `token ${token}`
    : `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  const remote = parseRemote(
    execFileSync('git', ['-C', mainDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(),
  );
  const host = process.env.ENGRAM_GITEA_HOST || remote.host;
  const owner = process.env.ENGRAM_GITEA_OWNER || remote.owner;

  const url = `${host}/api/packages/${owner}/generic/${PKG}/${VER}/${FILE}`;
  const size = fs.statSync(exe).size;
  console.log(`上传 ${exe}（${size} 字节）-> ${url}`);

  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: authHeader, 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(exe),
  });
  if (!res.ok) {
    throw new Error(`上传失败：HTTP ${res.status} ${await res.text()}`);
  }
  console.log(`完成。固定下载链接（始终是最新引导器）：\n  ${url}`);
}

// 仅作为脚本直接运行时执行上传（被 require 时只导出 parseRemote 供测试）
if (require.main === module) {
  main().catch((e) => {
    console.error(`[publish] ${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}

module.exports = { parseRemote };
