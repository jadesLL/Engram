import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import { ensureDirs, PORT, HOST } from './config.js';
import { migrate, db } from './lib/db.js';
import { ensureJwtSecret, ensureDefaultPassword, authRoutes } from './routes/auth.js';
import { pageRoutes } from './routes/pages.js';
import { fileRoutes } from './routes/files.js';
import { searchRoutes } from './routes/search.js';
import { aiRoutes } from './routes/ai.js';
import { graphRoutes } from './routes/graph.js';
import { dreamRoutes } from './routes/dream.js';
import { settingsRoutes } from './routes/settings.js';
import { jobRoutes } from './routes/jobs.js';
import { rawRoutes } from './routes/raw.js';
import { mcpRoutes } from './mcp/server.js';
import { scanVault, readPage, writePage } from './lib/vault.js';
import { migrateAiLogsToOperationLog } from './pipeline/indexFile.js';

/** AIWorks 系统区页面不参与整理、不打标签 */
function cleanupSystemPages() {
  const rows = db
    .prepare(`SELECT path, tags FROM pages WHERE path LIKE 'AIWorks/%' AND tags != '[]' AND deleted = 0`)
    .all() as any[];
  for (const r of rows) {
    const rd = readPage(r.path);
    if (rd) writePage(r.path, rd.content, { tags: [] });
  }
}
import { startJobRunner } from './jobs.js';
import { scheduleDreamCycle } from './dream/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  ensureDirs();
  migrate();
  ensureDefaultPassword();

  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });

  await app.register(cookie);
  await app.register(jwt, { secret: ensureJwtSecret(), cookie: { cookieName: 'token', signed: false } });
  await app.register(multipart, {
    limits: { fileSize: 200 * 1024 * 1024 },
    // 浏览器表单字段无 charset 声明，busboy 默认 latin1 会把中文目录/文件名解码成乱码
    defParamCharset: 'utf8',
  } as any);

  await app.register(authRoutes);
  await app.register(pageRoutes);
  await app.register(fileRoutes);
  await app.register(searchRoutes);
  await app.register(aiRoutes);
  await app.register(graphRoutes);
  await app.register(dreamRoutes);
  await app.register(settingsRoutes);
  await app.register(jobRoutes);
  await app.register(rawRoutes);
  await app.register(mcpRoutes);

  // 静态托管前端构建产物 + SPA fallback
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/mcp')) {
        reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
      } else {
        reply.code(404).send({ error: 'not found' });
      }
    });
  }

  // 启动：扫描 vault 同步 DB、迁移历史 AI 日志进操作日志、清理系统区页面标签、启动任务队列与 Dream Cycle
  await scanVault();
  migrateAiLogsToOperationLog();
  cleanupSystemPages();
  startJobRunner();
  scheduleDreamCycle();

  await app.listen({ port: PORT, host: HOST });
  console.log(`LLM Wiki 已启动: http://localhost:${PORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
