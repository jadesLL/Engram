// 收集箱「渲染后抓取」（桌面端）：用隐藏的 Electron 窗口把页面真正跑起来，再把渲染后的 DOM 抓成 HTML。
//
// 背景：服务端抓网页不执行脚本，正文由 JavaScript 渲染的页面（多数分享页与单页应用）只能拿到空壳，
// 服务端会以 needs-render 明确拒绝（见 server/src/lib/inboxWebFetch.ts）。桌面端自带 Chromium，
// 可以把这页渲染出来——结果与「浏览器另存为 HTML」等价，仍然作为原件存进收集箱。
//
// createWindow 由主进程注入（真正 new BrowserWindow）；本模块只负责：等加载、等正文稳定、取 HTML、
// 收尾。不直接依赖 Electron，这段逻辑才能在无 Electron 的环境里单测。

/** 正文至少要带来这么多可见文字，才算渲染出来了（壳页的导航/页脚一加载就在，实测 238 字符） */
const CONTENT_GROWTH = 200;
/** 基线（壳页自带文字）至少要这么多字符才值得信任；页面还没挂出来时先别把 0 当基线 */
const MIN_BASELINE_TEXT = 50;
/** 等基线的宽限：页面迟迟不吐一个字（异常页面）也照常往下走 */
const BASELINE_GRACE_MS = 3_000;
/** 每轮等正文的上限；这轮没长出来就先重载一轮，还不行再取快照（由服务端如实报「渲染后仍没有正文」） */
const CONTENT_WAIT_MS = 10_000;
const POLL_MS = 400;
const DEFAULT_TIMEOUT_MS = 45_000;

// 在页面里执行的两段取值：可见文字长度（判是否渲染完）与最终快照
const LOAD_STATE_EXPR =
  'document.body ? document.body.innerText.replace(/\\s+/g, "").length : 0';
const SNAPSHOT_EXPR =
  '({ html: document.documentElement ? document.documentElement.outerHTML : "", title: document.title || "", url: location.href })';

function assertRenderableUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw == null ? '' : raw).trim());
  } catch {
    throw new Error('网页地址无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https 网页地址');
  }
  if (parsed.username || parsed.password) {
    throw new Error('网页地址不能携带用户名或密码');
  }
  return parsed.toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 探测可见文字长度；页面正在跳转时 executeJavaScript 会失败，按「还没渲染好」处理 */
async function probeVisibleText(win) {
  try {
    return await win.webContents.executeJavaScript(LOAD_STATE_EXPR);
  } catch {
    return 0;
  }
}

/**
 * 等页面把正文渲染出来：基线 = 页面挂出来之后自带的可见文字（导航/页脚），正文要把它顶起来
 * 一截才算渲染完。不能只看「有没有文字」——壳页的导航/页脚一加载就在（实测 238 字符）；
 * 基线自身也要等页面吐字（loadURL 刚返回时 body 可能还没就绪，0 不能当基线）。
 * @returns 是否等到正文长出来
 */
async function waitForContent(win, { contentWaitMs, contentGrow, pollMs, sleep }) {
  const deadline = Date.now() + contentWaitMs;
  const baselineDeadline = Date.now() + BASELINE_GRACE_MS;
  let baseline = -1;
  for (;;) {
    if (Date.now() >= deadline) return false;
    const length = await probeVisibleText(win);
    const value = typeof length === 'number' ? length : 0;
    if (baseline < 0) {
      if (value >= MIN_BASELINE_TEXT || Date.now() >= baselineDeadline) baseline = value;
    } else if (value - baseline >= contentGrow) {
      return true;
    }
    await sleep(pollMs);
  }
}

/**
 * 渲染一个公网页面并返回渲染后的 HTML。
 * @param {{ createWindow: () => any, url: string, timeoutMs?: number, pollMs?: number, contentWaitMs?: number, contentGrow?: number, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ html: string, title: string, url: string }>}
 */
async function renderInboxUrl(options) {
  const { createWindow, url } = options;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs || POLL_MS;
  const contentGrow = options.contentGrow == null ? CONTENT_GROWTH : options.contentGrow;
  const contentWaitMs = options.contentWaitMs == null ? CONTENT_WAIT_MS : options.contentWaitMs;
  const sleep = options.sleep || delay;
  const target = assertRenderableUrl(url);
  const win = createWindow();
  const deadline = Date.now() + timeoutMs;
  try {
    const load = () =>
      withTimeout(
        win.loadURL(target),
        Math.max(1_000, deadline - Date.now()),
        '页面加载超时（' + Math.round(timeoutMs / 1000) + ' 秒内没有响应）',
      );
    await load();
    let grew = await waitForContent(win, { contentWaitMs, contentGrow, pollMs, sleep });
    if (!grew && Date.now() < deadline) {
      // 有些站点要求「先建立会话」才给正文（实测：全新会话只给壳，同一持久会话第二次访问才出正文）。
      // 渲染窗用的是持久化分区，所以重载一次通常就拿到了。
      await load();
      grew = await waitForContent(win, { contentWaitMs, contentGrow, pollMs, sleep });
    }
    if (Date.now() > deadline) {
      throw new Error('页面渲染超时（' + Math.round(timeoutMs / 1000) + ' 秒内没有等到正文）');
    }
    const page = await win.webContents.executeJavaScript(SNAPSHOT_EXPR);
    if (!page || typeof page.html !== 'string' || !page.html) {
      throw new Error('页面渲染完成但没有拿到 HTML');
    }
    return {
      html: page.html,
      title: typeof page.title === 'string' ? page.title : '',
      url: typeof page.url === 'string' && page.url ? page.url : target,
    };
  } finally {
    try {
      win.destroy();
    } catch {
      /* 窗口可能已经被关掉 */
    }
  }
}

module.exports = { renderInboxUrl, assertRenderableUrl, CONTENT_GROWTH, CONTENT_WAIT_MS, DEFAULT_TIMEOUT_MS };
