/**
 * 生成 Engram 安卓应用图标、启动屏与桌面端图标（一次性开发工具，不参与构建/CI）。
 *
 * 依赖 @napi-rs/canvas：默认从主检出目录的共享 node_modules 加载；
 * 其他机器可先 `pnpm add -D @napi-rs/canvas` 到 mobile/ 再运行。
 *
 * 用法：node scripts/gen-icons.cjs
 * 读取 res 下现有 PNG 的尺寸，按同尺寸重新渲染：
 *   - mipmap 各密度 ic_launcher.png        圆角方块图标（蓝底 + Engram 痕迹标志）
 *   - mipmap 各密度 ic_launcher_round.png  圆形图标
 *   - mipmap 各密度 ic_launcher_foreground.png 自适应图标前景（透明底，标志居中）
 *   - drawable 各密度 splash.png           启动屏（浅底 + 标志 + 产品名）
 *   - desktop/build/icon.png               桌面端/安装包图标（512×512，蓝底 + 标志）
 */
const fs = require('fs');
const path = require('path');

function loadCanvas() {
  const candidates = [
    '@napi-rs/canvas',
    'C:/Workspace/ExampleProject/main/node_modules/.pnpm/@napi-rs+canvas@1.0.5/node_modules/@napi-rs/canvas',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  throw new Error('找不到 @napi-rs/canvas，请先安装');
}

const { createCanvas } = loadCanvas();
const resDir = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

const BG_TOP = '#3D7BFF';
const BG_BOTTOM = '#245BDB';
const BRAND = '#3D7BFF';

function pngSize(file) {
  const buf = fs.readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBackground(ctx, w, h, radius) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, BG_TOP);
  g.addColorStop(1, BG_BOTTOM);
  ctx.fillStyle = g;
  if (radius > 0) {
    roundRectPath(ctx, 0, 0, w, h, radius);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, w, h);
  }
}

// Engram 痕迹标志：字母 E 由三条圆角「记忆痕迹」构成，末端各带一枚发光触点
// （engram = 记忆痕迹；触点呼应知识图谱的节点）。
// cyOffset：整体垂直偏移（splash 里给下方的产品名让位）。
function drawMark(ctx, w, h, scale, color, cyOffset = 0) {
  const unit = Math.min(w, h) * scale;
  const cx = w / 2;
  const cy = h / 2 + cyOffset;
  const barH = unit * 0.16;   // 痕迹粗细
  const barW = unit * 0.68;   // 标志总宽
  const gap = unit * 0.15;    // 行距
  const dotR = barH * 0.52;   // 触点半径
  const dotGap = dotR * 1.5;  // 痕迹与触点的间隙
  const spineW = barH;
  const totalH = barH * 3 + gap * 2;
  const left = cx - barW / 2;
  const top = cy - totalH / 2;
  const traceLen = barW - dotGap - dotR * 2;
  ctx.fillStyle = color;
  roundRectPath(ctx, left, top, spineW, totalH, spineW / 2);
  ctx.fill();
  const rows = [0, 1, 2].map((i) => ({
    y: top + (barH + gap) * i,
    len: i === 1 ? traceLen * 0.78 : traceLen,
  }));
  for (const row of rows) {
    roundRectPath(ctx, left, row.y, row.len, barH, barH / 2);
    ctx.fill();
    const dx = left + row.len + dotGap + dotR;
    const dy = row.y + barH / 2;
    ctx.beginPath();
    ctx.arc(dx, dy, dotR * 2.2, 0, Math.PI * 2);
    ctx.globalAlpha = 0.22;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderLauncher(file, { round }) {
  const { w, h } = pngSize(file);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const radius = round ? 0 : Math.min(w, h) * 0.22;
  if (round) {
    // 圆形裁剪
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
    ctx.clip();
  }
  drawBackground(ctx, w, h, radius);
  drawMark(ctx, w, h, 0.62, '#ffffff');
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  console.log('ok', path.relative(resDir, file), `${w}x${h}`);
}

function renderForeground(file) {
  const { w, h } = pngSize(file);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  // 自适应图标前景需留安全区（内容约 50%）
  drawMark(ctx, w, h, 0.5, '#ffffff');
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  console.log('ok', path.relative(resDir, file), `${w}x${h}`);
}

function renderSplash(file) {
  const { w, h } = pngSize(file);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const unit = Math.min(w, h);
  drawMark(ctx, w, h, 0.2, BRAND, -unit * 0.08);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1f2329';
  ctx.font = `600 ${unit * 0.075}px "Segoe UI", sans-serif`;
  ctx.fillText('Engram', w / 2, h / 2 + unit * 0.16);
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  console.log('ok', path.relative(resDir, file), `${w}x${h}`);
}

const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
for (const d of densities) {
  const dir = path.join(resDir, `mipmap-${d}`);
  if (!fs.existsSync(dir)) continue;
  renderLauncher(path.join(dir, 'ic_launcher.png'), { round: false });
  renderLauncher(path.join(dir, 'ic_launcher_round.png'), { round: true });
  renderForeground(path.join(dir, 'ic_launcher_foreground.png'));
}

// 自适应图标背景：纯色矢量（替换 Capacitor 默认绿色）
fs.writeFileSync(
  path.join(resDir, 'drawable', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="#3D7BFF" android:pathData="M0,0h108v108h-108z" />
</vector>
`
);
console.log('ok drawable/ic_launcher_background.xml');

const splashFiles = fs
  .readdirSync(resDir)
  .filter((n) => n === 'drawable' || n.startsWith('drawable-'))
  .map((n) => path.join(resDir, n, 'splash.png'))
  .filter((f) => fs.existsSync(f));
for (const f of splashFiles) renderSplash(f);

// 桌面端/安装包图标（electron-builder 从 build/icon.png 生成 ico/exe 资源）
const desktopIconPath = path.join(__dirname, '..', '..', 'desktop', 'build', 'icon.png');
{
  const size = 512;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  drawBackground(ctx, size, size, size * 0.22);
  drawMark(ctx, size, size, 0.62, '#ffffff');
  fs.writeFileSync(desktopIconPath, canvas.toBuffer('image/png'));
  console.log('ok', path.relative(path.join(__dirname, '..'), desktopIconPath), `${size}x${size}`);
}

console.log('DONE');
