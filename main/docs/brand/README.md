# Engram 品牌资产

本目录下的 `*.svg` / `preview.html` / `brand-preview.png` **全部由 `main/scripts/gen-brand-icons.cjs` 生成，请勿手改**——改了下次生成就被覆盖。要调整图形先改生成器里的几何/配色常量。

在动手之前先看 `brand-preview.png`（两版在所有尺寸、两种界面底色上的实际效果），改完重新生成再看一遍。

## 唯一来源

品牌图形（**知识核 + 倾斜轨道环 + 轨道电子**，100×100 设计坐标、中心 (50,50)）原先在 9 处各写一份：网页 favicon 的 data-URI、标题栏 / 导航 rail / 登录页 / 欢迎页的内联 SVG、桌面启动页内联 SVG、安装器 GUI 内联 SVG、Android 资源、docs 下的 SVG……颜色与几何互不一致（电子甚至浮在轨道环外）。

现在几何与配色只在 `gen-brand-icons.cjs` 里写一份，由它推导出全部落地文件：

```powershell
# 需要 @napi-rs/canvas（pnpm 严格布局下根目录 require 不到，用环境变量指定）
$env:ENGRAM_CANVAS='<repo>/main/node_modules/.pnpm/@napi-rs+canvas@1.0.5/node_modules/@napi-rs/canvas'
node main/scripts/gen-brand-icons.cjs    # 工作目录：main/
```

生成的 SVG 里带一行「由 main/scripts/gen-brand-icons.cjs 生成，请勿手改」注释，方便日后辨认。

## 两种呈现

| 呈现 | 文件 | 用在哪 |
| --- | --- | --- |
| **盒装图标** | `engram-icon-{light,dark}.svg` | 圆角贴片 + 品牌图形。有底色、有描边，任何背景上都立得住——favicon、标题栏、导航 rail、登录页、桌面/托盘/安装包图标、Android 启动图标 |
| **透明标志** | `engram-mark-{light,dark}.svg` | 无底色，只有图形。留给有干净底色的位置——欢迎页大 logo、桌面启动页 |
| **横排字标** | `engram-lockup-{light,dark}.svg` | 图标 + `Engram` 字标 + 一行说明，460×120，用于 README 横幅 |

## 亮暗规则

**桌面永远用亮色版**：exe 图标、桌面快捷方式、开始菜单、托盘、安装包、Android 启动图标——这些出现在用户的桌面/任务栏上，不受应用主题控制，浅色贴片在任何壁纸上都看得清。

**软件内部跟随主题**：网页标签页 favicon、标题栏 logo、导航 rail、登录页、欢迎页——由 `web/src/components/BrandMark.vue` 按 `app.dark` 在两份 SVG 之间切换（标签页图标由 `stores/app.ts` 的 `applyTheme()` 换 `href`）。

例外：桌面端启动页/错误页底色是固定深色 `#0d1424`，固定用 `mark-dark.svg`；安装器 GUI 是蓝色渐变底，固定用亮色盒装图标。

## 文件去向

| 文件 | 谁用 |
| --- | --- |
| `docs/brand/*` | 人看的品牌资产（README 横幅、预览页、本文档） |
| `web/public/brand/icon-{light,dark}.svg` | 应用内所有 logo 位（`BrandMark.vue` 按主题选） |
| `web/public/brand/mark-{light,dark}.svg` | 欢迎页透明 logo |
| `web/public/favicon.ico` | 亮色 5 尺寸兜底（老浏览器自动请求 `/favicon.ico`） |
| `desktop/build/icon.png`、`icon.ico` | 托盘、exe、桌面/开始菜单快捷方式、electron-builder / 安装包 |
| `desktop/build/mark-dark.svg` | 桌面启动页（data: URL 页面，`main.js` 直接读源码内联） |
| `installer/brand/icon-light.svg` | 安装器 GUI（`installer/ui.html`） |
| `mobile/android/app/src/main/res/**` | Android 启动图标（含自适应前景）、启动屏 |

## 加新位置时

不要在 HTML/Vue 里再写一遍 `<ellipse>`/`<circle>`。按位置选呈现方式：

- 网页/应用内 → 用 `<BrandMark :size="..." :plated="true|false" />`；
- 需要文件路径（`<img src>`、data: URL、非本仓库前端）→ 让生成器多写一个落点（见脚本里「3b) 安装器 GUI」一段），再引用生成的文件。
