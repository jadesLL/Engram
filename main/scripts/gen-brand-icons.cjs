#!/usr/bin/env node
/**
 * Engram 品牌图标「唯一生成器」（一次性开发工具，不参与构建 / CI / 运行时代码）
 *
 * 背景：品牌图形（知识核 + 倾斜轨道环 + 轨道电子）原先在 9+ 处各写一份，颜色与几何
 * 互不一致（电子甚至浮在轨道环外）。本脚本把图形几何与配色收敛为**单一来源**，
 * 由一处常量推导出全部落地产物：
 *
 *   docs/brand/                       人看的品牌资产（README 横幅等）
 *     engram-icon-{light,dark}.svg      盒装图标（透明圆角底 + 品牌图形）
 *     engram-mark-{light,dark}.svg      透明标志（无底，用于大尺寸装饰位）
 *     engram-lockup-{light,dark}.svg    图标 + 字标横排（460×120，README 横幅）
 *     preview.html                      两版对照预览页
 *   web/public/                       运行时静态资源（server 直接托管）
 *     brand/icon-{light,dark}.svg       应用内 logo / favicon（与 docs/brand 同字节）
 *     brand/mark-{light,dark}.svg
 *     favicon.ico                       亮色版 5 尺寸兜底（/favicon.ico 直连）
 *   desktop/build/
 *     icon.png                          512×512 亮色（托盘 / electron-builder / 安装包）
 *     icon.ico                          16/24/32/48/64/128/256 亮色（exe、桌面、开始菜单）
 *     mark-dark.svg                     启动页 / 错误页内联用（data: URL 页面不能走相对路径）
 *   installer/brand/
 *     icon-light.svg                    安装器 GUI（installer/ui.html）用
 *   mobile/android/app/src/main/res/    Android 启动图标 / 启动屏（亮色）
 *
 * 亮暗规则（见 docs/brand/README.md）：
 *   桌面 / 托盘 / 安装包 / Android 启动图标 —— **始终亮色版**；
 *   软件内（网页标签、标题栏、导航 rail、登录页、欢迎页）—— 跟随应用主题切换。
 *
 * 用法（宿主机 Node，非 Docker）：
 *   node main/scripts/gen-brand-icons.cjs
 * 需要 @napi-rs/canvas（生成 PNG/ICO 用）；pnpm 严格布局下根目录 require 不到，
 * 可用环境变量指定包目录：
 *   ENGRAM_CANVAS=<path-to>/node_modules/@napi-rs/canvas node main/scripts/gen-brand-icons.cjs
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.resolve(__dirname, '..');
const REPO = path.resolve(MAIN, '..');

// ---------------------------------------------------------------- 几何（唯一定义）
// 设计坐标系 100 × 100，中心 (50, 50)。所有产物都由这些常量推导。
const G = {
  orbitRx: 34, // 轨道椭圆长半轴
  orbitRy: 13.5, // 轨道椭圆短半轴
  orbitStroke: 9, // 轨道环线宽
  orbitAngle: -28, // 轨道倾角（度）
  coreR: 13, // 知识核半径
  electronR: 8.2, // 电子半径（明显大于环线宽，小尺寸下也看得出是「环上的珠子」）
  electronAngle: -33, // 电子在椭圆上的参数角（度）——保证严格落在环上
  plateR: 22, // 盒装底圆角半径（占 100 的比例）
  plateStroke: 1.6, // 盒装底描边宽
};

// 轨道渐变沿椭圆主轴方向（局部坐标）
const ORBIT_GRAD = { x1: -26, y1: 26, x2: 26, y2: -26 };
// 知识核渐变沿对角线（局部坐标）
const CORE_GRAD = { x1: -9.75, y1: -9.75, x2: 9.75, y2: 9.75 };

/** 电子坐标：椭圆参数点 → 按轨道倾角旋转 → 中心相对坐标 */
function electronPoint() {
  const t = (G.electronAngle * Math.PI) / 180;
  const lx = G.orbitRx * Math.cos(t);
  const ly = G.orbitRy * Math.sin(t);
  const a = (G.orbitAngle * Math.PI) / 180;
  return {
    x: lx * Math.cos(a) - ly * Math.sin(a),
    y: lx * Math.sin(a) + ly * Math.cos(a),
  };
}

// ---------------------------------------------------------------- 配色（唯一定义）
const VARIANTS = {
  // 亮色版：浅底深图，用于桌面 / 托盘 / 安装包 / Android 启动图标，以及浅色主题界面
  light: {
    plate: ['#FFFFFF', '#E9EFF8'],
    plateRing: 'rgba(15,23,42,0.10)',
    plateRingCss: 'rgba(15, 23, 42, 0.10)',
    orbit: ['#0EA5E9', '#2563EB'],
    core: ['#2563EB', '#1E3A8A'],
    electron: '#0EA5E9',
    wordmark: '#1F2329',
    tagline: '#6B7280',
  },
  // 暗色版：深底亮图，用于深色主题界面
  dark: {
    plate: ['#16213A', '#0F172A'],
    plateRing: 'rgba(255,255,255,0.10)',
    plateRingCss: 'rgba(255, 255, 255, 0.10)',
    orbit: ['#22D3EE', '#4D8AFF'],
    core: ['#4D8AFF', '#245BDB'],
    electron: '#22D3EE',
    wordmark: '#FFFFFF',
    tagline: '#C9C9C9',
  },
};

const GEN_NOTE = '由 main/scripts/gen-brand-icons.cjs 生成，请勿手改；改样式请改生成器后重跑';

// ---------------------------------------------------------------- SVG 生成
const n = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
};

function svgHeader(title) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${GEN_NOTE} -->\n`;
}

function defsBlock(variant, uid) {
  const v = VARIANTS[variant];
  return `  <defs>
    <linearGradient id="${uid}-orbit" gradientUnits="userSpaceOnUse" x1="${n(50 + ORBIT_GRAD.x1)}" y1="${n(50 + ORBIT_GRAD.y1)}" x2="${n(50 + ORBIT_GRAD.x2)}" y2="${n(50 + ORBIT_GRAD.y2)}">
      <stop offset="0" stop-color="${v.orbit[0]}"/>
      <stop offset="1" stop-color="${v.orbit[1]}"/>
    </linearGradient>
    <linearGradient id="${uid}-core" gradientUnits="userSpaceOnUse" x1="${n(50 + CORE_GRAD.x1)}" y1="${n(50 + CORE_GRAD.y1)}" x2="${n(50 + CORE_GRAD.x2)}" y2="${n(50 + CORE_GRAD.y2)}">
      <stop offset="0" stop-color="${v.core[0]}"/>
      <stop offset="1" stop-color="${v.core[1]}"/>
    </linearGradient>`;
}

function markShapes(variant, uid, indent) {
  const el = electronPoint();
  const pad = indent || '  ';
  return [
    `${pad}<ellipse cx="50" cy="50" rx="${n(G.orbitRx)}" ry="${n(G.orbitRy)}" fill="none" stroke="url(#${uid}-orbit)" stroke-width="${n(G.orbitStroke)}" transform="rotate(${n(G.orbitAngle)} 50 50)"/>`,
    `${pad}<circle cx="${n(50 + el.x)}" cy="${n(50 + el.y)}" r="${n(G.electronR)}" fill="${VARIANTS[variant].electron}"/>`,
    `${pad}<circle cx="50" cy="50" r="${n(G.coreR)}" fill="url(#${uid}-core)"/>`,
  ].join('\n');
}

/** 透明标志（无底） */
function markSvg(variant) {
  const uid = `engram-${variant}`;
  return [
    svgHeader(),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Engram">`,
    '  <title>Engram</title>',
    defsBlock(variant, uid),
    '  </defs>',
    markShapes(variant, uid),
    '</svg>',
    '',
  ].join('\n');
}

/** 盒装图标（圆角底 + 描边 + 品牌图形） */
function iconSvg(variant) {
  const v = VARIANTS[variant];
  const uid = `engram-${variant}`;
  const inset = G.plateStroke / 2;
  return [
    svgHeader(),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="Engram">`,
    '  <title>Engram</title>',
    defsBlock(variant, uid),
    `    <linearGradient id="${uid}-plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${v.plate[0]}"/>
      <stop offset="1" stop-color="${v.plate[1]}"/>
    </linearGradient>`,
    '  </defs>',
    `  <rect width="100" height="100" rx="${n(G.plateR)}" fill="url(#${uid}-plate)"/>`,
    `  <rect x="${n(inset)}" y="${n(inset)}" width="${n(100 - G.plateStroke)}" height="${n(100 - G.plateStroke)}" rx="${n(G.plateR - inset)}" fill="none" stroke="${v.plateRingCss}" stroke-width="${n(G.plateStroke)}"/>`,
    markShapes(variant, uid),
    '</svg>',
    '',
  ].join('\n');
}

/** 图标 + 字标横排（460×120） */
function lockupSvg(variant) {
  const v = VARIANTS[variant];
  const uid = `engram-${variant}-lockup`;
  const el = electronPoint();
  const box = 88;
  const boxX = 16;
  const boxY = 16;
  const scale = box / 100;
  const inset = (G.plateStroke * scale) / 2;
  return [
    svgHeader(),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 120" width="460" height="120" role="img" aria-label="Engram">`,
    '  <title>Engram</title>',
    '  <defs>',
    `    <linearGradient id="${uid}-plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${v.plate[0]}"/>
      <stop offset="1" stop-color="${v.plate[1]}"/>
    </linearGradient>`,
    `    <linearGradient id="${uid}-orbit" gradientUnits="userSpaceOnUse" x1="${n(ORBIT_GRAD.x1)}" y1="${n(ORBIT_GRAD.y1)}" x2="${n(ORBIT_GRAD.x2)}" y2="${n(ORBIT_GRAD.y2)}">
      <stop offset="0" stop-color="${v.orbit[0]}"/>
      <stop offset="1" stop-color="${v.orbit[1]}"/>
    </linearGradient>`,
    `    <linearGradient id="${uid}-core" gradientUnits="userSpaceOnUse" x1="${n(CORE_GRAD.x1)}" y1="${n(CORE_GRAD.y1)}" x2="${n(CORE_GRAD.x2)}" y2="${n(CORE_GRAD.y2)}">
      <stop offset="0" stop-color="${v.core[0]}"/>
      <stop offset="1" stop-color="${v.core[1]}"/>
    </linearGradient>`,
    '  </defs>',
    `  <rect x="${n(boxX)}" y="${n(boxY)}" width="${n(box)}" height="${n(box)}" rx="${n((G.plateR * box) / 100)}" fill="url(#${uid}-plate)"/>`,
    `  <rect x="${n(boxX + inset)}" y="${n(boxY + inset)}" width="${n(box - G.plateStroke * scale)}" height="${n(box - G.plateStroke * scale)}" rx="${n((G.plateR * box) / 100 - inset)}" fill="none" stroke="${v.plateRingCss}" stroke-width="${n(G.plateStroke * scale)}"/>`,
    `  <g transform="translate(${n(boxX + box / 2)} ${n(boxY + box / 2)}) scale(${n(scale)})">`,
    `    <ellipse cx="0" cy="0" rx="${n(G.orbitRx)}" ry="${n(G.orbitRy)}" fill="none" stroke="url(#${uid}-orbit)" stroke-width="${n(G.orbitStroke)}" transform="rotate(${n(G.orbitAngle)})"/>`,
    `    <circle cx="${n(el.x)}" cy="${n(el.y)}" r="${n(G.electronR)}" fill="${v.electron}"/>`,
    `    <circle cx="0" cy="0" r="${n(G.coreR)}" fill="url(#${uid}-core)"/>`,
    '  </g>',
    `  <text x="126" y="66" font-family="Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="46" font-weight="700" letter-spacing="-0.6" fill="${v.wordmark}">Engram</text>`,
    `  <text x="128" y="94" font-family="Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif" font-size="15" letter-spacing="0.2" fill="${v.tagline}">LLM 原生个人知识库</text>`,
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- canvas 渲染
function loadCanvas() {
  const candidates = [];
  if (process.env.ENGRAM_CANVAS) candidates.push(process.env.ENGRAM_CANVAS);
  candidates.push('@napi-rs/canvas');
  // pnpm 布局：<main>/node_modules/.pnpm/@napi-rs+canvas@<ver>/node_modules/@napi-rs/canvas
  for (const root of [MAIN, REPO]) {
    const store = path.join(root, 'node_modules', '.pnpm');
    if (!fs.existsSync(store)) continue;
    for (const entry of fs.readdirSync(store)) {
      if (!entry.startsWith('@napi-rs+canvas@')) continue;
      candidates.push(path.join(store, entry, 'node_modules', '@napi-rs', 'canvas'));
    }
  }
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.message.split('\n')[0]}`);
    }
  }
  console.error('未能加载 @napi-rs/canvas，PNG/ICO 产物无法生成。候选：');
  for (const line of errors) console.error('  - ' + line);
  process.exit(1);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** 画盒装底（圆角 + 渐变 + 描边） */
function paintPlate(ctx, size, variant) {
  const v = VARIANTS[variant];
  const r = (size * G.plateR) / 100;
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, v.plate[0]);
  gradient.addColorStop(1, v.plate[1]);
  roundRectPath(ctx, 0, 0, size, size, r);
  ctx.fillStyle = gradient;
  ctx.fill();

  const strokeWidth = Math.max(1, (size * G.plateStroke) / 100);
  roundRectPath(ctx, strokeWidth / 2, strokeWidth / 2, size - strokeWidth, size - strokeWidth, Math.max(0, r - strokeWidth / 2));
  ctx.strokeStyle = v.plateRing;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}

/** 画品牌图形；unit = 每个设计单位的像素数 */
function paintMark(ctx, unit, variant) {
  const v = VARIANTS[variant];
  const el = electronPoint();
  ctx.save();
  ctx.scale(unit, unit);

  const orbitGradient = ctx.createLinearGradient(ORBIT_GRAD.x1, ORBIT_GRAD.y1, ORBIT_GRAD.x2, ORBIT_GRAD.y2);
  orbitGradient.addColorStop(0, v.orbit[0]);
  orbitGradient.addColorStop(1, v.orbit[1]);
  ctx.beginPath();
  ctx.ellipse(0, 0, G.orbitRx, G.orbitRy, (G.orbitAngle * Math.PI) / 180, 0, Math.PI * 2);
  ctx.strokeStyle = orbitGradient;
  ctx.lineWidth = G.orbitStroke;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(el.x, el.y, G.electronR, 0, Math.PI * 2);
  ctx.fillStyle = v.electron;
  ctx.fill();

  const coreGradient = ctx.createLinearGradient(CORE_GRAD.x1, CORE_GRAD.y1, CORE_GRAD.x2, CORE_GRAD.y2);
  coreGradient.addColorStop(0, v.core[0]);
  coreGradient.addColorStop(1, v.core[1]);
  ctx.beginPath();
  ctx.arc(0, 0, G.coreR, 0, Math.PI * 2);
  ctx.fillStyle = coreGradient;
  ctx.fill();

  ctx.restore();
}

function renderIcon(canvasLib, size, variant) {
  const canvas = canvasLib.createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  paintPlate(ctx, size, variant);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  paintMark(ctx, size / 100, variant);
  ctx.restore();
  return canvas;
}

function renderMark(canvasLib, size, variant, scale) {
  const canvas = canvasLib.createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  paintMark(ctx, (size * (scale === undefined ? 1 : scale)) / 100, variant);
  ctx.restore();
  return canvas;
}

// ---------------------------------------------------------------- ICO 编码
function encodeBmpEntry(rgba, width, height) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // 高度含 AND 掩码
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(width * height * 4, 20);

  const pixels = Buffer.alloc(width * height * 4);
  const maskRow = Math.ceil(width / 32) * 4;
  const mask = Buffer.alloc(maskRow * height);
  for (let y = 0; y < height; y++) {
    const flipped = height - 1 - y; // DIB 自下而上
    for (let x = 0; x < width; x++) {
      const s = (flipped * width + x) * 4;
      const d = (y * width + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      if (rgba[s + 3] < 128) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

/** payloads: [{ width, height, data: Buffer }]，256 用 PNG（与历史 ico 一致），其余 BMP */
function encodeIco(payloads) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(payloads.length, 4);
  const directory = Buffer.alloc(16 * payloads.length);
  let offset = 6 + 16 * payloads.length;
  payloads.forEach((payload, index) => {
    const base = index * 16;
    directory.writeUInt8(payload.width >= 256 ? 0 : payload.width, base);
    directory.writeUInt8(payload.height >= 256 ? 0 : payload.height, base + 1);
    directory.writeUInt8(0, base + 2);
    directory.writeUInt8(0, base + 3);
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(payload.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += payload.data.length;
  });
  return Buffer.concat([header, directory, ...payloads.map((payload) => payload.data)]);
}

function buildIco(canvasLib, sizes, variant) {
  const payloads = sizes.map((size) => {
    const canvas = renderIcon(canvasLib, size, variant);
    const data = size >= 256
      ? canvas.toBuffer('image/png')
      : encodeBmpEntry(canvas.getContext('2d').getImageData(0, 0, size, size).data, size, size);
    return { width: size, height: size, data };
  });
  return encodeIco(payloads);
}

// ---------------------------------------------------------------- 落盘
const written = [];
function writeFile(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  written.push([path.relative(REPO, target).split(path.sep).join('/'), Buffer.byteLength(content)]);
}

const LEGACY = [
  'docs/brand/engram-icon.svg',
  'docs/brand/engram-mark.svg',
  'docs/brand/engram-favicon.svg',
  'docs/brand/logo-lockup.svg',
  'docs/brand/brand-preview3.png',
  'mobile/scripts/gen-icons.cjs',
  'mobile/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml', // Capacitor 默认安卓机器人，无任何引用
];

function pruneLegacy() {
  for (const rel of LEGACY) {
    const target = path.join(MAIN, ...rel.split('/'));
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target);
    console.log('prune', rel);
  }
}

// ---------------------------- Android 资源（尺寸沿用 gen-icons.cjs 的历史规格）
const ANDROID_LAUNCHER = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};
const ANDROID_FOREGROUND = {
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};
const ADAPTIVE_FOREGROUND_SCALE = 0.72;

/** 读 PNG 的 IHDR 尺寸（不依赖 canvas） */
function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** 现有 splash.png 全量（drawable/ 与 drawable-{port,land}-{density}/），原地按原尺寸重绘 */
function splashTargets(res) {
  return fs
    .readdirSync(res)
    .filter((name) => name === 'drawable' || name.startsWith('drawable-'))
    .map((name) => path.join(res, name, 'splash.png'))
    .filter((file) => fs.existsSync(file));
}

function renderSplash(canvasLib, width, height, variant) {
  const canvas = canvasLib.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const unit = Math.min(width, height);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width / 2, height / 2 - unit * 0.08);
  paintMark(ctx, (unit * 0.3) / 100, variant);
  ctx.restore();

  ctx.fillStyle = VARIANTS.light.wordmark;
  ctx.font = `600 ${unit * 0.075}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Engram', width / 2, height / 2 + unit * 0.16);
  return canvas;
}

function buildAndroidResources(canvasLib) {
  const res = path.join(MAIN, 'mobile/android/app/src/main/res');
  for (const [density, size] of Object.entries(ANDROID_LAUNCHER)) {
    const dir = path.join(res, `mipmap-${density}`);
    writeFile(path.join(dir, 'ic_launcher.png'), renderIcon(canvasLib, size, 'light').toBuffer('image/png'));
    writeFile(path.join(dir, 'ic_launcher_round.png'), renderRoundIcon(canvasLib, size, 'light').toBuffer('image/png'));
    writeFile(
      path.join(dir, 'ic_launcher_foreground.png'),
      renderMark(canvasLib, ANDROID_FOREGROUND[density], 'light', ADAPTIVE_FOREGROUND_SCALE).toBuffer('image/png'),
    );
  }
  for (const file of splashTargets(res)) {
    const { width, height } = pngSize(file);
    writeFile(file, renderSplash(canvasLib, width, height, 'light').toBuffer('image/png'));
  }

  writeFile(
    path.join(res, 'drawable', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GEN_NOTE} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="${VARIANTS.light.plate[1]}" android:pathData="M0,0h108v108h-108z" />
</vector>
`,
  );
  writeFile(
    path.join(res, 'values', 'ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<!-- ${GEN_NOTE} -->
<resources>
    <color name="ic_launcher_background">${VARIANTS.light.plate[1]}</color>
</resources>
`,
  );
}

function renderRoundIcon(canvasLib, size, variant) {
  const canvas = canvasLib.createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const v = VARIANTS[variant];
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, v.plate[0]);
  gradient.addColorStop(1, v.plate[1]);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.save();
  ctx.translate(size / 2, size / 2);
  paintMark(ctx, size / 100, variant);
  ctx.restore();
  return canvas;
}

// ---------------------------------------------------------------- 预览页
function previewHtml() {
  const chip = (variant, size, label) => `      <figure class="chip-${variant}">
        <img src="engram-icon-${variant}.svg" width="${size}" height="${size}" alt="${label}">
        <figcaption>${label}</figcaption>
      </figure>`;
  const sizes = [16, 24, 32, 48, 64, 128];
  return `<!DOCTYPE html>
<!-- ${GEN_NOTE} -->
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Engram 品牌图标预览</title>
  <style>
    body { margin: 0; padding: 32px; font: 14px/1.6 "Segoe UI", system-ui, sans-serif; background: #f7f6f4; color: #1f2329; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 32px 0 12px; color: #0f6cbd; }
    .hint { color: #6b7280; margin: 0 0 8px; }
    .row { display: flex; align-items: flex-end; gap: 24px; flex-wrap: wrap; }
    figure { margin: 0; text-align: center; }
    figcaption { font-size: 11px; color: #6b7280; margin-top: 6px; }
    .panel { padding: 20px; border-radius: 12px; display: flex; align-items: flex-end; gap: 24px; flex-wrap: wrap; }
    .light { background: #f7f6f4; border: 1px solid #e3e0dc; }
    .dark { background: #1e1d1c; border: 1px solid #33302d; }
    .dark h2, .dark figcaption { color: #c9c9c9; }
    .card { background: #fff; border: 1px solid #e3e0dc; border-radius: 12px; padding: 20px; }
    code { background: #ecebe8; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
    table { border-collapse: collapse; margin-top: 8px; }
    td, th { border: 1px solid #e3e0dc; padding: 6px 12px; text-align: left; font-size: 13px; }
    th { background: #f0efec; }
    img { display: block; }
  </style>
</head>
<body>
  <h1>Engram 品牌图标</h1>
  <p class="hint">全部产物由 <code>main/scripts/gen-brand-icons.cjs</code> 生成；几何与配色只有这一份定义。</p>

  <h2>小尺寸可读性（亮色版盒装图标）</h2>
  <div class="panel light">
${sizes.map((size) => chip('light', size, `${size}px`)).join('\n')}
  </div>

  <h2>亮色版 / 暗色版盒装图标</h2>
  <div class="panel light">
${[64, 48, 32, 16].map((size) => chip('light', size, `light ${size}`)).join('\n')}
${[64, 48, 32, 16].map((size) => chip('dark', size, `dark ${size}`)).join('\n')}
  </div>
  <div class="panel dark">
${[64, 48, 32, 16].map((size) => chip('dark', size, `dark ${size}`)).join('\n')}
${[64, 48, 32, 16].map((size) => chip('light', size, `light ${size}`)).join('\n')}
  </div>

  <h2>透明标志（大尺寸装饰位 / 登录页、欢迎页）</h2>
  <div class="row">
    <div class="panel light">
      <img src="engram-mark-light.svg" width="72" height="72" alt="light mark">
    </div>
    <div class="panel dark">
      <img src="engram-mark-dark.svg" width="72" height="72" alt="dark mark">
    </div>
  </div>

  <h2>软件内 chip 模拟（导航 rail 30px / 标题栏 20px）</h2>
  <div class="row">
    ${['light', 'dark'].map((variant) => `<div class="panel ${variant}">
      <img src="engram-icon-${variant}.svg" width="30" height="30" alt="rail">
      <img src="engram-icon-${variant}.svg" width="20" height="20" alt="titlebar">
      <img src="engram-mark-${variant}.svg" width="40" height="40" alt="welcome">
      <img src="engram-icon-${variant}.svg" width="52" height="52" alt="login">
    </div>`).join('\n    ')}
  </div>

  <h2>字标横排（README 横幅）</h2>
  <div class="row">
    <div class="panel light"><img src="engram-lockup-light.svg" width="440" height="115" alt="Engram"></div>
    <div class="panel dark"><img src="engram-lockup-dark.svg" width="440" height="115" alt="Engram"></div>
  </div>

  <h2>落地方位与版本规则</h2>
  <table>
    <tr><th>位置</th><th>版本</th></tr>
    <tr><td>Windows exe / 桌面快捷方式 / 开始菜单 / 托盘 / 安装包</td><td>始终亮色</td></tr>
    <tr><td>Android 启动图标（含自适应前景、圆形图标）</td><td>始终亮色</td></tr>
    <tr><td>网页标签 favicon、应用内 logo（标题栏 / rail / 登录 / 欢迎）</td><td>跟随软件主题切换</td></tr>
    <tr><td>Android 启动屏（白底，当前不随系统暗色）</td><td>亮色图形</td></tr>
  </table>
</body>
</html>
`;
}

// ---------------------------------------------------------------- 对照图（评审用 PNG）
const SHEET_FONT = '13px "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';

/** 把两版图标铺到浅色/深色背景上，出一张可放大检查的对照图 */
function renderContactSheet(canvasLib) {
  const width = 1000;
  const bandHeight = 186;
  const bands = [
    { bg: '#f7f6f4', fg: '#6b7280', label: '浅色界面 —— 亮色版（16 / 24 / 32 / 48 / 64 / 128）', variant: 'light', sizes: [16, 24, 32, 48, 64, 128] },
    { bg: '#1e1d1c', fg: '#c9c9c9', label: '深色界面 —— 暗色版', variant: 'dark', sizes: [16, 24, 32, 48, 64, 128] },
    { bg: '#f7f6f4', fg: '#6b7280', label: '交叉验证：浅色界面放暗色版（不采用，仅看对比）', variant: 'dark', sizes: [64, 48, 32] },
    { bg: '#1e1d1c', fg: '#c9c9c9', label: '交叉验证：深色界面放亮色版（不采用，仅看对比）', variant: 'light', sizes: [64, 48, 32] },
    { bg: '#f7f6f4', fg: '#6b7280', label: '软件内位置：导航 rail 30 / 标题栏 20 / 登录页 52 / 欢迎页透明标 72', variant: 'light', chips: true },
    { bg: '#1e1d1c', fg: '#c9c9c9', label: '软件内位置（深色）', variant: 'dark', chips: true },
  ];
  const height = bands.length * bandHeight;
  const canvas = canvasLib.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  bands.forEach((band, index) => {
    const top = index * bandHeight;
    ctx.fillStyle = band.bg;
    ctx.fillRect(0, top, width, bandHeight);
    ctx.fillStyle = band.fg;
    ctx.font = SHEET_FONT;
    ctx.textAlign = 'left';
    ctx.fillText(band.label, 32, top + 38);

    let x = 32;
    if (band.chips) {
      const middle = top + bandHeight / 2 + 30;
      for (const size of [30, 20, 52]) {
        ctx.drawImage(renderIcon(canvasLib, size, band.variant), x, middle - size / 2);
        x += size + 28;
      }
      ctx.drawImage(renderMark(canvasLib, 72, band.variant), x, middle - 36);
      return;
    }

    const baseline = top + bandHeight - 40;
    for (const size of band.sizes) {
      ctx.drawImage(renderIcon(canvasLib, size, band.variant), x, baseline - size);
      ctx.fillStyle = band.fg;
      ctx.font = '11px "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
      ctx.fillText(`${size}px`, x, top + bandHeight - 20);
      x += size + 28;
    }
  });
  return canvas;
}

// ---------------------------------------------------------------- 主流程
function main() {
  const canvasLib = loadCanvas();

  // 1) 人看的品牌资产
  const docs = path.join(MAIN, 'docs/brand');
  writeFile(path.join(docs, 'engram-mark-light.svg'), markSvg('light'));
  writeFile(path.join(docs, 'engram-mark-dark.svg'), markSvg('dark'));
  writeFile(path.join(docs, 'engram-icon-light.svg'), iconSvg('light'));
  writeFile(path.join(docs, 'engram-icon-dark.svg'), iconSvg('dark'));
  writeFile(path.join(docs, 'engram-lockup-light.svg'), lockupSvg('light'));
  writeFile(path.join(docs, 'engram-lockup-dark.svg'), lockupSvg('dark'));
  writeFile(path.join(docs, 'preview.html'), previewHtml());
  writeFile(path.join(docs, 'brand-preview.png'), renderContactSheet(canvasLib).toBuffer('image/png'));

  // 2) 运行时资源（与 docs/brand 同字节）
  const publicBrand = path.join(MAIN, 'web/public/brand');
  writeFile(path.join(publicBrand, 'icon-light.svg'), iconSvg('light'));
  writeFile(path.join(publicBrand, 'icon-dark.svg'), iconSvg('dark'));
  writeFile(path.join(publicBrand, 'mark-light.svg'), markSvg('light'));
  writeFile(path.join(publicBrand, 'mark-dark.svg'), markSvg('dark'));
  writeFile(
    path.join(MAIN, 'web/public/favicon.ico'),
    buildIco(canvasLib, [16, 24, 32, 48, 64], 'light'),
  );

  // 3) 桌面端（始终亮色）
  const desktopBuild = path.join(MAIN, 'desktop/build');
  writeFile(path.join(desktopBuild, 'icon.png'), renderIcon(canvasLib, 512, 'light').toBuffer('image/png'));
  writeFile(path.join(desktopBuild, 'icon.ico'), buildIco(canvasLib, [16, 24, 32, 48, 64, 128, 256], 'light'));
  // 启动页/错误页是 data: URL 页面（相对路径不可用），main.js 直接读这份 SVG 源码内联；
  // 启动页底色 #0d1424 与暗色贴片太接近，故用透明标志而不是盒装图标。
  writeFile(path.join(desktopBuild, 'mark-dark.svg'), markSvg('dark'));

  // 3b) 安装器 GUI（installer/ui.html 为 file:// 页面，用相对路径引用亮色版）
  writeFile(path.join(MAIN, 'installer/brand/icon-light.svg'), iconSvg('light'));

  // 4) Android（始终亮色）
  buildAndroidResources(canvasLib);

  // 5) 清理被本生成器取代/无引用的历史文件
  pruneLegacy();

  let total = 0;
  for (const [rel, bytes] of written) {
    total += bytes;
    console.log('write', rel.padEnd(58), `${bytes} B`);
  }
  console.log(`\n完成：${written.length} 个文件，共 ${total} 字节`);
}

main();
