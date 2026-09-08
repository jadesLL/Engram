import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';

import { ensureDirs, PORT, HOST, TLS_DOMAIN, TLS_PORT, TLS_DNS_API_TOKEN, TLS_EMAIL, TLS_ACME_DIRECTORY } from './config.js';
import { migrate, db } from './lib/db.js';
import { registerStaticAssetCache } from './lib/staticAssets.js';
import { ensureJwtSecret, ensureDefaultPassword, authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { pageRoutes } from './routes/pages.js';
import { fileRoutes } from './routes/files.js';
import { searchRoutes } from './routes/search.js';
import { graphRoutes } from './routes/graph.js';
import { settingsRoutes } from './routes/settings.js';
import { updateRoutes } from './routes/update.js';
import { jobRoutes } from './routes/jobs.js';
import { rawRoutes } from './routes/raw.js';
import { guideRoutes } from './routes/guide.js';
import { agentRoutes } from './routes/agent.js';
import { eventRoutes } from './routes/events.js';
import { trashRoutes } from './routes/trash.js';
import { officeRoutes } from './routes/office.js';
import { syncRoutes } from './routes/sync.js';
import { initSync } from './sync/index.js';
import { registerOfficeProxy } from './office/proxy.js';
import { mcpRoutes } from './mcp/server.js';
import { scanVault, readPage, writePage } from './lib/vault.js';
import { heartbeat } from './lib/events.js';
import { ensureSystemFiles, migrateLegacySystemFiles } from './pipeline/indexFile.js';
import { queueMissingDerivedPages } from './pipeline/sourceLedger.js';
import { autoRegisterCliConfig } from './lib/cliAutoRegister.js';

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
import { CertManager, type LoadedCert } from './lib/tls.js';
import { startDdnsScheduler } from './lib/ddns.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 构建应用实例（HTTP 与 HTTPS 监听共用同一套路由）。
 * 注意：数据层/后台任务是进程级单例，只允许 main() 启动一次，本函数只做路由装配。
 */
async function createApp(https?: { key: string; cert: string }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 10 * 1024 * 1024,
    ...(https ? { https } : {}),
  });

  await app.register(cookie);
  await app.register(jwt, { secret: ensureJwtSecret(), cookie: { cookieName: 'token', signed: false } });
  await app.register(multipart, {
    limits: { fileSize: 200 * 1024 * 1024 },
    // 浏览器表单字段无 charset 声明，busboy 默认 latin1 会把中文目录/文件名解码成乱码
    defParamCharset: 'utf8',
  } as any);

  await registerOfficeProxy(app);
  await app.register(authRoutes);
  await app.register(healthRoutes);
  await app.register(pageRoutes);
  await app.register(fileRoutes);
  await app.register(officeRoutes);
  await app.register(searchRoutes);
  await app.register(graphRoutes);
  await app.register(settingsRoutes);
  await app.register(updateRoutes);
  await app.register(jobRoutes);
  await app.register(rawRoutes);
  await app.register(guideRoutes);
  await app.register(agentRoutes);
  await app.register(eventRoutes);
  await app.register(trashRoutes);
  await app.register(syncRoutes);
  await app.register(mcpRoutes);

  // 静态托管前端构建产物 + SPA fallback（HTTP/HTTPS 实例各自缓存一份）
  const webDist = process.env.ENGRAM_WEB_DIST
    ? path.resolve(process.env.ENGRAM_WEB_DIST)
    : path.resolve(__dirname, '../../web/dist');
  const cache = await registerStaticAssetCache(app, webDist);
  if (cache.files) {
    app.log.info(
      { files: cache.files, bytes: cache.totalBytes },
      'Frontend static assets cached in memory',
    );
  }

  return app;
}

async function main() {
  ensureDirs();
  migrate();
  ensureDefaultPassword();
  // CLI 零配置：本机地址+专用 token 登记到 ~/.engram/config.json（手动 login 过则不覆盖）
  autoRegisterCliConfig();

  const app = await createApp();

  // 启动：扫描 vault 同步 DB、迁移历史系统文件进 AIWorks 系统区、清理系统区页面标签、启动任务队列
  // （进程级单例：双监听共享一份，createApp() 只做路由装配不碰数据）
  await scanVault();
  migrateLegacySystemFiles();
  // 预置 AIWorks 系统区页面（操作日志/同步冲突说明等，缺失即建），并重建索引与关系结构
  ensureSystemFiles();
  cleanupSystemPages();
  queueMissingDerivedPages();
  // 清理 30 天前的终态 jobs 行，避免表无限膨胀拖慢 job runner tick 的全表扫描。
  db.prepare(
    `DELETE FROM jobs WHERE status IN ('failed','done','cancelled') AND updated_at < ?`
  ).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '));
  startJobRunner();
  // DDNS 直连域名维护（设置页/env 未配置则完全静默跳过；纯 Node 定时器，无控制台窗口）
  startDdnsScheduler();
  // 多端同步：配置了 hub 连接则启动同步客户端（首次接入自动全量对账）
  await initSync();
  // SSE 心跳：保活长连接、探活死连接（断线 EventSource 自动重连）
  const hb = setInterval(heartbeat, 30_000);
  hb.unref();

  await app.listen({ port: PORT, host: HOST });
  console.log(`Engram 已启动: http://localhost:${PORT}`);

  // HTTPS 直连入口（TLS_DOMAIN 未配置则完全关闭，行为与历史一致）：
  // 证书就绪前 HTTP 照常服务（healthcheck 不受影响），就绪后再起 8443 监听。
  if (TLS_DOMAIN) {
    const tlsManager = await CertManager.create({
      domain: TLS_DOMAIN,
      dnsApiToken: TLS_DNS_API_TOKEN,
      cacheDir: path.join(
        process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data'),
        'tls',
      ),
      email: TLS_EMAIL || undefined,
      acmeDirectoryUrl: TLS_ACME_DIRECTORY || 'https://acme-v02.api.letsencrypt.org/directory',
    });
    let httpsApp: FastifyInstance | null = null;
    const startHttpsListener = async ({ key, cert }: LoadedCert) => {
      if (httpsApp) {
        await httpsApp.close();
        httpsApp = null;
      }
      httpsApp = await createApp({ key, cert });
      await httpsApp.listen({ port: TLS_PORT, host: HOST });
      console.log(`Engram HTTPS 直连已启动: https://localhost:${TLS_PORT}`);
    };
    tlsManager.onRenewal((c) => {
      startHttpsListener(c).catch((e) => console.error('[tls] HTTPS 监听热更换失败:', e));
    });
    tlsManager
      .waitReady()
      .then(startHttpsListener)
      .catch((e) => console.error('[tls] HTTPS 直连入口启动失败（HTTP 不受影响）:', e));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
