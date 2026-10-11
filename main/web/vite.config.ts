import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const vditorDist = path.join(path.dirname(require.resolve('vditor/package.json')), 'dist');
const vditorRoot = path.resolve(vditorDist);

function contentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  }[extension] || 'application/octet-stream';
}

function localVditorAssets(): Plugin {
  let resolvedConfig: ResolvedConfig;
  return {
    name: 'local-vditor-assets',
    configResolved(config) {
      resolvedConfig = config;
    },
    configureServer(server) {
      server.middlewares.use('/vendor/vditor/dist', (req, res, next) => {
        let relative = '';
        try {
          relative = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
        } catch {
          res.statusCode = 400;
          res.end('Bad request');
          return;
        }
        const target = path.resolve(vditorRoot, relative);
        if ((target !== vditorRoot && !target.startsWith(vditorRoot + path.sep)) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', contentType(target));
        fs.createReadStream(target).pipe(res);
      });
    },
    closeBundle() {
      const destination = path.resolve(
        __dirname,
        resolvedConfig.build.outDir,
        'vendor/vditor/dist',
      );
      /* 整份 dist 原样拷贝（约 23MB/产物），这是刻意保留的：
       *   - 运行时稳定加载的是 js/lute（Lute 解析器）、js/highlight.js（代码高亮 + 样式）、
       *     js/i18n/zh_CN.js、js/icons/ant.js、css/content-theme（light/dark）与 images/emoji；
       *   - 但预览/编辑器还会按「笔记里出现的语法」按需加载 js/mermaid、js/katex|mathjax、
       *     js/echarts、js/graphviz、js/flowchart.js、js/abcjs 等（CDN 前缀就是这里的
       *     /vendor/vditor）；只拷贝白名单会在离线桌面/安卓端让含图表、公式的页面静默坏掉。
       *   - 本 worktree 没有 node_modules、也无法跑构建来枚举真实请求，不做猜测定点裁剪；
       *     2026-10 审计提出的「只拷子路径」待能在真实构建里核对请求清单后再做。 */
      fs.cpSync(vditorDist, destination, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [vue(), localVditorAssets()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/mcp': 'http://localhost:8080',
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});
