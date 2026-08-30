/**
 * 生成 ExampleProject 安卓应用图标与启动屏（一次性开发工具，不参与构建/CI）。
 *
 * 依赖 @napi-rs/canvas：默认从主检出目录的共享 node_modules 加载；
 * 其他机器可先 `pnpm add -D @napi-rs/canvas` 到 mobile/ 再运行。
 *
 * 用法：node scripts/gen-icons.cjs
 * 读取 res 下现有 PNG 的尺寸，按同尺寸重新渲染：
 *   - mipmap 各密度 ic_launcher.png        圆角方块图标（蓝底 + 🧠）
 *   - mipmap 各密度 ic_launcher_round.png  圆形图标
 *   - mipmap 各密度 ic_launcher_foreground.png 自适应图标前景（透明底，emoji 居中 50%）
 *   - drawable 各密度 splash.png           启动屏（浅底 + 🧠 + 产品名）
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

const { createCanvas, GlobalFonts } = loadCanvas();
const resDir = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

const BG_TOP = '#3D7BFF';
const BG_BOTTOM = '#245BDB';
const EMOJI = '\u{1F9E0}'; // 🧠 与 web favicon 品牌一致

// 检查 emoji 字体是否可用，不可用时回退为 W 字母标志
function hasEmojiFont() {
  return GlobalFonts.families.some((f) => /emoji/i.test(f.family || ''));
}
const USE_EMOJI = hasEmojiFont();

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

function drawBrand(ctx, w, h, scale) {
  const size = Math.min(w, h) * scale;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (USE_EMOJI) {
    ctx.font = `${size}px "Segoe UI Emoji"`;
    ctx.fillText(EMOJI, w / 2, h / 2 + size * 0.04);
  } else {
    // 回退：白色 W 标志
    ctx.font = `900 ${size * 0.8}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText('W', w / 2, h / 2);
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
  drawBrand(ctx, w, h, 0.62);
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  console.log('ok', path.relative(resDir, file), `${w}x${h}`);
}

function renderForeground(file) {
  const { w, h } = pngSize(file);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  // 自适应图标前景需留安全区（内容约 44%）
  drawBrand(ctx, w, h, 0.44);
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
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const emojiSize = unit * 0.22;
  const cx = w / 2;
  const cy = h / 2;
  if (USE_EMOJI) {
    ctx.font = `${emojiSize}px "Segoe UI Emoji"`;
    ctx.fillText(EMOJI, cx, cy - unit * 0.06);
  } else {
    ctx.font = `900 ${unit * 0.16}px "Segoe UI", sans-serif`;
    ctx.fillStyle = '#3D7BFF';
    ctx.fillText('W', cx, cy - unit * 0.06);
  }
  ctx.fillStyle = '#1f2329';
  ctx.font = `600 ${unit * 0.075}px "Segoe UI", sans-serif`;
  ctx.fillText('LLM Wiki', cx, cy + unit * 0.12);
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

console.log('emoji font used:', USE_EMOJI);
console.log('DONE');
