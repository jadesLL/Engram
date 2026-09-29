/**
 * 更新源「仓库地址」解析：服务器/桌面端的「更新源配置」与安卓端的「安卓端更新」共用一份。
 *
 * 用户习惯直接粘贴浏览器地址栏，所以地址里可能带 Release 页、分支页后缀、`.git` 后缀或末尾斜杠；
 * 只粘站点首页（缺 owner/repo）时给出明确提示，而不是保存一个查不出 Release 的地址。
 */

export interface ParsedRepoSource {
  url: string;
  repo: string;
}

export function parseRepoUrl(input: string): ParsedRepoSource | { error: string } {
  const raw = input.trim();
  if (!raw) return { url: '', repo: '' };
  let u: URL;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { error: '地址格式无法识别，请粘贴浏览器地址栏的完整仓库地址' };
  }
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) {
    return { error: '这是站点首页地址，缺少仓库路径；请先打开仓库页面再复制，例如 https://gitea.xxx.com/username/Engram' };
  }
  const owner = decodeURIComponent(segs[0]);
  const name = decodeURIComponent(segs[1]).replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { error: '仓库路径包含无法识别的字符，请确认复制的是仓库首页地址' };
  }
  return { url: u.origin, repo: `${owner}/${name}` };
}
