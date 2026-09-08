/**
 * 生成 Engram 安卓应用图标、启动屏与桌面端图标（一次性开发工具，不参与构建/CI）。
 *
 * 依赖 @napi-rs/canvas：默认从主检出目录的共享 node_modules 加载；
 * 其他机器可先 `pnpm add -D @napi-rs/canvas` 到 mobile/ 再运行。
 *
 * 用法：node scripts/gen-icons.cjs
 * 读取 res 下现有 PNG 的尺寸，按同尺寸重新渲染：
 *   - mipmap 各密度 ic_launcher.png        圆角方块图标（深蓝黑底 + 原子轨道标志）
 *   - mipmap 各密度 ic_launcher_round.png  圆形图标
 *   - mipmap 各密度 ic_launcher_foreground.png 自适应图标前景（透明底，标志居中）
 *   - drawable 各密度 splash.png           启动屏（白底 + 彩色标志 + 产品名）
 *   - desktop/build/icon.png               桌面端/安装包图标（512×512）
 *
 * 品牌标志「原子轨道」：中心知识核 + 倾斜轨道环（青→蓝渐变）+ 轨道电子，
 * 设计坐标 100×100、中心 (50,50)，见 docs/brand/engram-mark.svg。
 */
const fs = require('fs');
const path = require('path');

function loadCanvas() {
  const candidates = [
    '@napi-rs/canvas',
    'C:/Workspace/Engram/main/node_modules/.pnpm/@napi-rs+canvas@1.0.5/node_modules/@napi-rs/canvas',
  ];
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  throw new Error('找不到 @napi-rs/canvas，请先安装');
}

const { createCanvas } = loadCanvas();
const resDir = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

const BRAND_BG = '#0F172A'; // 图标底色：深蓝黑
const ELECTRON = '#22D3EE'; // 轨道电子：青

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

// 原子轨道标志（彩色，透明底）：轨道环 + 电子 + 知识核。
// cyOffset：整体垂直偏移（splash 里给下方的产品名让位）。
function drawMark(ctx, w, h, scale, cyOffset = 0) {
  const s = Math.min(w, h) * scale;
  ctx.save();
  ctx.translate(w / 2, h / 2 + cyOffset);
  ctx.scale(s / 100, s / 100);
  // 轨道环（青→蓝渐变）
  const orbit = ctx.createLinearGradient(-26, 26, 26, -26);
  orbit.addColorStop(0, '#22D3EE');
  orbit.addColorStop(1, '#4D8AFF');
  ctx.strokeStyle = orbit;
  ctx.lineWidth = 8.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, 36, 15.5, -28 * Math.PI / 180, 0, Math.PI * 2);
  ctx.stroke();
  // 轨道电子
  ctx.fillStyle = ELECTRON;
  ctx.beginPath();
  ctx.arc(24, -21.5, 5, 0, Math.PI * 2);
  ctx.fill();
  // 知识核（蓝→深蓝渐变）
  const core = ctx.createLinearGradient(-11, -11, 11, 11);
  core.addColorStop(0, '#4D8AFF');
  core.addColorStop(1, '#245BDB');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBackground(ctx, w, h, radius) {
  ctx.fillStyle = BRAND_BG;
  if (radius > 0) {
    roundRectPath(ctx, 0, 0, w, h, radius);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, w, h);
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
  drawMark(ctx, w, h, 1.0);
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  console.log('ok', path.relative(resDir, file), `${w}x${h}`);
}

function renderForeground(file) {
  const { w, h } = pngSize(file);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  // 自适应图标前景需留安全区（内容约 50%）
  drawMark(ctx, w, h, 0.72);
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
  drawMark(ctx, w, h, 0.3, -unit * 0.08);
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

// 自适应图标背景：纯色矢量（深蓝黑，与 PNG 图标底一致）
fs.writeFileSync(
  path.join(resDir, 'drawable', 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="#0F172A" android:pathData="M0,0h108v108h-108z" />
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
  drawMark(ctx, size, size, 1.0);
  fs.writeFileSync(desktopIconPath, canvas.toBuffer('image/png'));
  console.log('ok', path.relative(path.join(__dirname, '..'), desktopIconPath), `${size}x${size}`);
}

console.log('DONE');
