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
