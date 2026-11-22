// 源码模式更新小窗的卡片页（紧凑深色卡片：应用图标 + 标题 + 当前步骤 + 细进度线）。
//
// 设计基准取自 DeepSeek Harness 的更新提示（深色圆角卡、左上图标、粗标题、一行说明），
// 但补上它没有的最小化：无边框窗口没有系统标题栏，卡片整块是拖拽区，右上角自绘最小化按钮
// 必须声明 no-drag 才点得动。最小化经专用 preload（desktop/update-preload.js）发 IPC，
// 不复用主窗的完整 wikiDesktop 桥。
//
// 主进程只负责窗口选项与数据（图标 data URL），页面 HTML 在这里生成，便于单测与静态截图。

/** 窗口外框尺寸（DIP）：10px 透明留白给卡片投影，卡片本体 480×96 / 失败态加高 */
const WINDOW = { width: 500, height: 116, failedHeight: 160 };

const STYLE = `
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: transparent; overflow: hidden; }
  body {
    display: flex; padding: 10px; user-select: none;
    font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    position: relative; flex: 1; min-width: 0;
    display: flex; align-items: center; gap: 14px;
    padding: 17px 44px 19px 20px;
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 12px;
    background: #202020;
    /* 投影必须落在窗口 10px 透明留白内：更大的 blur 会被窗口边界裁成一块方形暗影 */
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
    -webkit-app-region: drag;
  }
  .app-icon {
    width: 44px; height: 44px; flex: none; display: block;
    border-radius: 10px; object-fit: contain;
  }
  .app-icon-fallback { background: #f4efe4; }
  .body { min-width: 0; padding-right: 12px; }
  .app-name { font-size: 15px; font-weight: 600; line-height: 1.25; color: #ffffff; letter-spacing: 0.2px; }
  .step {
    margin-top: 4px; font-size: 13px; line-height: 1.45; color: #cfcfcf;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
    border-radius: 0 0 11px 11px; overflow: hidden;
    background: rgba(255, 255, 255, 0.07);
  }
  .bar i {
    display: block; width: 34%; height: 100%;
    background: linear-gradient(90deg, #22d3ee, #4d8aff);
    animation: slide 1.4s ease-in-out infinite;
  }
  .failed .bar i { animation: none; width: 100%; background: #f87171; }
  .failed .step {
    color: #f87171; white-space: normal;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .win-min {
    position: absolute; top: 7px; right: 7px; width: 26px; height: 22px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    border: 0; border-radius: 6px; background: transparent; color: #8a8a8a;
    cursor: pointer; -webkit-app-region: no-drag;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .win-min:hover { background: rgba(255, 255, 255, 0.09); color: #efefef; }
  .win-min:active { background: rgba(255, 255, 255, 0.15); }
  .win-min:focus-visible { outline: 1px solid #4d8aff; outline-offset: 1px; }
  @keyframes slide { from { transform: translateX(-110%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) {
    .bar i { animation-duration: 3.4s; }
  }
`;

/** 只接受本进程读出的 PNG data URL，避免把任意字符串拼进页面属性 */
function safeIcon(iconDataUrl) {
  const s = String(iconDataUrl || '');
  return /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
}

function page({ iconDataUrl = '' } = {}) {
  const icon = safeIcon(iconDataUrl);
  const iconTag = icon
    ? `<img class="app-icon" src="${icon}" alt="">`
    : '<span class="app-icon app-icon-fallback" aria-hidden="true"></span>';
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>' +
    STYLE +
    '</style></head><body>' +
    '<div class="card">' +
    '<button class="win-min" id="win-min" type="button" title="最小化" aria-label="最小化">' +
    '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M2.5 6h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '</svg></button>' +
    iconTag +
    '<div class="body">' +
    '<div class="app-name">Engram</div>' +
    '<div class="step" id="step">正在更新，完成后将自动重启应用。</div>' +
    '</div>' +
    '<div class="bar"><i></i></div>' +
    '</div>' +
    '<pre id="log" hidden></pre>' +
    '<script>document.getElementById("win-min").addEventListener("click", function () {' +
    'if (window.engramUpdateWindow) window.engramUpdateWindow.minimize();});</script>' +
    '</body></html>'
  );
}

module.exports = { WINDOW, page };
