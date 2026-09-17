// 仓库可达性探测（安装器两步流程的第二步）：`git ls-remote` 且关掉一切交互式询问，
// 免得凭据管理器弹窗或卡住等待输入。分类逻辑单独拆出来（classifyProbe）便于单测。
//
// 关键：探测必须显式清空凭据助手（`-c credential.helper=`）。否则本机凭据管理器（Windows 的
// GCM、macOS 的 osxkeychain 等）会把已保存的凭据悄悄喂给 git，私有仓库也能拉成功，于是被误判成
// 「公开仓库」——2026-09-18 实测：用户自建 Gitea 的私有库在装有凭据的机器上被判成公开并直接开装。
// GIT_TERMINAL_PROMPT 只挡「弹窗询问」，挡不住「自动取用已存凭据」。
const { spawn } = require('node:child_process');
const { normalizeRepoUrl } = require('./repo-url.js');

/** 认证类失败的特征（GitHub 对私有库返回 "Repository not found"，故 not found 也算要凭据） */
const AUTH_PATTERN = /authentication|could not read username|terminal prompts|invalid username|permission denied|403|401|not found|repository not found/;

/** 把 `git ls-remote` 的结果归类；stderr 大小写不敏感 */
function classifyProbe(code, stderr) {
  if (code === 0) return { status: 'public', message: '该地址可匿名读取（公开仓库）' };
  const text = String(stderr || '').toLowerCase();
  if (AUTH_PATTERN.test(text)) {
    return { status: 'private', message: '该地址需要凭据（私有仓库，或地址不存在）' };
  }
  const last = String(stderr || '').trim().split('\n').filter(Boolean).pop();
  return { status: 'unreachable', message: last || '连接失败' };
}

/**
 * 探测仓库；resolve 的对象 status ∈ public | private | unreachable | unknown。
 * unknown = 本机还没有可用的 git，无法预检（照常开始安装，真需要凭据时引擎会再报）。
 */
function probeRepo(rawUrl, { gitExe = 'git', timeoutMs = 20000, env } = {}) {
  return new Promise((resolve) => {
    const info = normalizeRepoUrl(rawUrl);
    if (!info.ok) return resolve({ status: 'unreachable', message: info.message });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const probeEnv = {
      ...(env || process.env),
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: 'echo',
    };
    const git = spawn(gitExe, ['-c', 'credential.helper=', 'ls-remote', '--heads', info.url], {
      env: probeEnv,
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      try { git.kill(); } catch { /* 已退出 */ }
      finish({ status: 'unreachable', message: `连接超时（${Math.round(timeoutMs / 1000)} 秒），检查地址与网络后重试` });
    }, timeoutMs);
    git.stderr.on('data', (d) => { stderr += d; });
    git.on('error', () => {
      clearTimeout(timer);
      finish({ status: 'unknown', message: '本机还没有可用的 Git，跳过预检直接开始安装' });
    });
    git.on('exit', (code) => {
      clearTimeout(timer);
      finish(classifyProbe(code, stderr));
    });
  });
}

module.exports = { probeRepo, classifyProbe, AUTH_PATTERN };
