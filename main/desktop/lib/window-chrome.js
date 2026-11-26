// 桌面窗口外观的能力协商（纯逻辑，不依赖 Electron，便于单测）。
//
// 背景（2026-11-26 用户报「最小化、关闭按钮没了」）：标题栏窗口按钮从 Windows 原生
// titleBarOverlay 改为网页自绘后，旧前端产物（没有自绘按钮、右侧仍给原生按钮留 152px）
// 碰上只认自绘按钮的新壳，就会出现「一个按钮都没有」的窗口——用户无法最小化/关闭。
// 这种壳与前端产物的版本错位在源码模式更新中断（git pull 成功、build 失败）时必然出现。
//
// 约定：web 构建把能力声明放进 dist/desktop-shell.json（web/public 下的静态文件，vite build
// 原样复制）。壳在创建窗口前读这份声明：
//   self-drawn → 隐藏原生标题栏，按钮由网页标题栏绘制；
//   缺失/旧产物 → 回退 Windows 原生 titleBarOverlay 按钮（旧前端本来就为它留了 152px）。
// 这样新壳能兼容任意旧前端产物，更新半途失败也不会出现「没有窗口按钮」的窗口。
const fs = require('node:fs');
const path = require('node:path');

/** 能力声明文件名（web/public → web/dist，prepare-desktop 随产物复制） */
const CAPABILITY_FILE = 'desktop-shell.json';

/**
 * 解析 web 产物声明的窗口控制方式。
 * @param {string} webDistDir desktop/web/dist 或 web/dist
 * @param {{ readFile?: (file: string, enc: string) => string }} [io]
 * @returns {'self-drawn' | 'native'} native = 旧产物，调用方应启用原生 titleBarOverlay
 */
function resolveWindowControlsMode(webDistDir, io = {}) {
  const readFile = io.readFile || ((file, enc) => fs.readFileSync(file, enc));
  try {
    const raw = readFile(path.join(webDistDir, CAPABILITY_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.windowControls === 'self-drawn') return 'self-drawn';
  } catch {
    /* 旧产物没有声明 / 声明损坏：按旧产物处理 */
  }
  return 'native';
}

module.exports = { CAPABILITY_FILE, resolveWindowControlsMode };
