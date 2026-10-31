import { retireLegacyDockerOffice } from './lib/officeRuntime.js';
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
import { ideaRoutes } from './routes/ideas.js';
import { inboxRoutes } from './routes/inbox.js';
import { searchRoutes } from './routes/search.js';
import { graphRoutes } from './routes/graph.js';
import { settingsRoutes } from './routes/settings.js';
import { videoConfigRoutes } from './routes/videoConfig.js';
import { updateRoutes } from './routes/update.js';
import { jobRoutes } from './routes/jobs.js';
import { rawRoutes } from './routes/raw.js';
import { guideRoutes } from './routes/guide.js';
import { agentRoutes } from './routes/agent.js';
import { entityNameRoutes } from './routes/entityNames.js';
import { assistantRoutes } from './routes/assistant.js';
import { agentConsoleRoutes } from './routes/agentConsole.js';
import { taskRoutes } from './routes/tasks.js';
import { customerResearchRoutes } from './routes/customerResearch.js';
import { eventRoutes } from './routes/events.js';
import { trashRoutes } from './routes/trash.js';
import { officeRoutes } from './routes/office.js';
import { syncRoutes } from './routes/sync.js';
import { hubUpdateRoutes } from './routes/syncHubUpdate.js';
import { runtimeRoutes } from './routes/runtime.js';
import { applyEnvSyncRole, initSync } from './sync/index.js';
import { migrateConflictBackupDir } from './sync/hub.js';
import { registerOfficeProxy } from './office/proxy.js';
import { registerAgentConsoleProxy } from './assistant/agentConsoleProxy.js';
import { mcpRoutes } from './mcp/server.js';
import { assetRoutes } from './routes/assets.js';
import { mediaRoutes } from './routes/media.js';
import { scanVaultPages, scanVaultDeferred, readPage, writePage } from './lib/vault.js';
import { startVaultWatch } from './lib/vaultWatch.js';
import { heartbeat } from './lib/events.js';
import { ensureSystemFiles, migrateLegacySystemFiles } from './pipeline/indexFile.js';
import { queueMissingDerivedPages } from './pipeline/sourceLedger.js';
import { autoRegisterCliConfig } from './lib/cliAutoRegister.js';

/**
 * 启动分段计时：累计值从进程启动（performance.timeOrigin）算起，与 desktop 主进程的
 * `[startup] <phase> +Nms` 格式对齐（main.js 会给 server 行加 `[server] ` 前缀）。
 *
 * 默认只在 listen 完成时输出一行 `[startup] server-ready +Nms`（附 compact 分段摘要），
 * ENGRAM_STARTUP_PROFILE=1 时每个阶段再逐段输出 `[startup] <phase> +Nms`，供启动测量使用。
 * 阶段名用小写连字符，勿改（桌面端与测量台按它解析）。
 */
const STARTUP_PROFILE = process.env.ENGRAM_STARTUP_PROFILE === '1';
const startupMarks: Array<{ phase: string; at: number }> = [];
/** 旧版收集箱入库迁移的最早开跑延迟：避开首屏渲染/首屏接口的 CPU 峰值 */
const LEGACY_INBOX_MIGRATION_MIN_DELAY_MS = 2500;

function markStartup(phase: string): void {
  const at = Math.round(performance.now());
  startupMarks.push({ phase, at });
  if (STARTUP_PROFILE) console.log(`[startup] ${phase} +${at}ms`);
}

/** listen 完成时输出就绪摘要（默认唯一一行启动日志） */
function logServerReady(): void {
  const readyAt = Math.round(performance.now());
  if (STARTUP_PROFILE) {
    console.log(`[startup] server-ready +${readyAt}ms`);
    return;
  }
  // compact 摘要：imports 是首个阶段（累计值=模块图加载耗时），其余阶段显示相对上一阶段的耗时；
  // 只列 >=20ms 的阶段，避免一行日志被十几个 0ms 阶段撑爆。
  const segments: string[] = [];
  let previousAt = 0;
  for (const mark of startupMarks) {
    const delta = mark.at - previousAt;
    previousAt = mark.at;
    if (mark.phase === 'imports') segments.push(`imports=${mark.at}ms`);
    else if (delta >= 20) segments.push(`${mark.phase}=${delta}ms`);
  }
  console.log(
    `[startup] server-ready +${readyAt}ms` + (segments.length ? ` (${segments.join(' ')})` : ''),
  );
}

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

/** 清理 30 天前的终态 jobs 行，避免表无限膨胀拖慢 job runner tick 的全表扫描。 */
function pruneFinishedJobs() {
  db.prepare(
    `DELETE FROM jobs WHERE status IN ('failed','done','cancelled') AND updated_at < ?`
  ).run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '));
}

import { startJobRunner } from './jobs.js';
// 只引类型（编译期擦除）：CertManager / acme-client 仅在 TLS_DOMAIN 分支内动态加载，
// 避免 acme-client（实测 ~840ms）进入 server-ready 之前的模块图。
import type { LoadedCert } from './lib/tls.js';
import { startDdnsScheduler } from './lib/ddns.js';
import { startDreamScheduler } from './assistant/dreamCycle.js';
import { ensureAgentNodeRuntime } from './assistant/agentNode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 模块图（含 fastify / 全部路由 / better-sqlite3 初始化）加载完成的时间点 */
markStartup('imports');

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
  // 内置 Agent 控制台的同源反向代理（/agent-console/*，含 WebSocket）；须早于静态托管注册
  await registerAgentConsoleProxy(app);
  await app.register(authRoutes);
  await app.register(runtimeRoutes);
  await app.register(healthRoutes);
  await app.register(pageRoutes);
  await app.register(fileRoutes);
  await app.register(ideaRoutes);
  await app.register(inboxRoutes);
  await app.register(assetRoutes);
  // 图片资产直链：必须早于静态托管的 SPA fallback 注册，否则未命中会返回 index.html
  await app.register(mediaRoutes);
  await app.register(officeRoutes);
  await app.register(searchRoutes);
  await app.register(graphRoutes);
  await app.register(settingsRoutes);
  // 视频理解模型配置的独立读写口（v1.5.1：手机成员令牌可经窄代理读写，只认 video_config）
  await app.register(videoConfigRoutes);
  await app.register(updateRoutes);
  await app.register(jobRoutes);
  await app.register(rawRoutes);
  await app.register(guideRoutes);
  await app.register(agentRoutes);
  await app.register(entityNameRoutes);
  await app.register(assistantRoutes);
  // 内置 Agent 控制台的原生 BFF（/api/agent-console/*；v1.5.1 起手机成员令牌也可经窄代理远程配置）
  await app.register(agentConsoleRoutes);
  await app.register(taskRoutes);
  await app.register(customerResearchRoutes);
  await app.register(eventRoutes);
  await app.register(trashRoutes);
  await app.register(syncRoutes);
  await app.register(hubUpdateRoutes);
  await app.register(mcpRoutes);

  // 静态托管前端构建产物 + SPA fallback（HTTP/HTTPS 实例各自缓存一份）。
  // 只预读 index.html，其余资源首次请求时再读盘（见 lib/staticAssets.ts）。
  const webDist = process.env.ENGRAM_WEB_DIST
    ? path.resolve(process.env.ENGRAM_WEB_DIST)
    : path.resolve(__dirname, '../../web/dist');
  const cache = await registerStaticAssetCache(app, webDist);
  if (cache.files) {
    app.log.info(
      { files: cache.files, preloaded: cache.assets.size, preloadedBytes: cache.totalBytes },
      'Frontend static assets discovered (lazy-loaded on first request)',
    );
  }

  return app;
}

/**
 * listen 之后的后台启动链：按原有启动顺序补完非关键工作，避免它们挡住服务就绪。
 *
 * - 先 setImmediate 让出事件循环：listen 完成时可能已有 /health 与首屏请求在排队，
 *   不能紧接着跑同步的 DB/文件工作。
 * - 每步独立 try/catch：任何一步失败只记日志，服务保持可用（同步未就绪时状态面板
 *   有 bootstrapping 状态，任务队列可随时从设置页重新启动）。
 * - 顺序保持与历史一致：扫描收尾 → FTS 兜底入队 → jobs 清理/恢复 → 带外监听 → DDNS → 同步
 *   → 旧版收集箱入库迁移。其中 initSync 会做网络探测 + 首次全量对账（真实环境数秒），放在
 *   靠后且不 await 到主流程；收集箱迁移会动态加载重型解析链，再延迟到 ready+2.5s 之后。
 */
async function runBackgroundStartup(app: FastifyInstance): Promise<void> {
  const backgroundStartedAt = performance.now();
  const step = async (phase: string, action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      console.error(`[startup] 后台任务 ${phase} 失败（服务不受影响）:`, error);
    } finally {
      markStartup(phase);
    }
  };

  await new Promise<void>((resolve) => setImmediate(resolve));

  // 非首屏扫描：原始资料提取入队、图片资产迁移/收容（asset 迁移要按 pages 行建目录，
  // 必须在 scanVaultPages 之后；带外监听等它跑完再从一致状态接管）
  await step('scan-vault-deferred', () => scanVaultDeferred());
  // FTS 兜底：概念/实体页缺 pages_fts 行时补一次索引任务（集合式查询）
  await step('queue-derived', () => queueMissingDerivedPages());
  // 清理 30 天前的终态 jobs 行 + 恢复上次中断的任务（recoverStaleJobs 已改为集合式查询）
  await step('jobs-cleanup', () => pruneFinishedJobs());
  await step('jobs-recover', () => startJobRunner());
  // 带外文件系统监听：外置 Agent / 用户在服务端之外直接增删改 brain 目录时，立刻对账并推 SSE
  await step('vault-watch', () => { startVaultWatch(); });
  // DDNS 直连域名维护（未配置则完全静默跳过；纯定时器）
  await step('ddns', () => startDdnsScheduler());
  // 多端同步：配置了 hub 连接则启动同步客户端（首次接入自动全量对账）。
  // 失败仅日志、不阻断本机使用：同步状态面板已有 bootstrapping / 上次错误状态。
  await step('sync-init', () => initSync());
  // 旧版收集箱入库误建子目录迁移（迁到 原始资料/文档/，movePage 保留页面 ID 与检索引用）。
  //
  // 动态 import ./pipeline/inboxConvert.js 会顺带把 pdfjs/xlsx/mammoth/jszip 整条重型解析链
  // 拉回内存（首次加载 ~1s 级 CPU）——task-6/7 已把 listen 前的其它重链惰性化，这里是最后残留。
  // 迁移只搬历史文件、对首屏无影响，因此放到后台链尾，并保证不早于 ready+2.5s 才开始
  // （同步较慢时顺延到同步之后）：先让首屏静态资源与首屏接口拿到 CPU。
  // 幂等：没有遗留目录时直接返回；失败只记日志（不写任何迁移标记），下次启动重试。
  await step('inbox-legacy-migrate', async () => {
    const wait = LEGACY_INBOX_MIGRATION_MIN_DELAY_MS - (performance.now() - backgroundStartedAt);
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        timer.unref?.();
      });
    }
    const { migrateLegacyInboxAdoptions } = await import('./pipeline/inboxConvert.js');
    const moved = migrateLegacyInboxAdoptions();
    if (moved) console.log(`[startup] 旧版收集箱入库迁移：${moved} 个页面已迁到原始资料/文档`);
  });

  app.log.info({ startupMarks }, '后台启动任务已全部完成');
}

async function main() {
  ensureDirs();
  markStartup('ensure-dirs');
  // 桌面端：把进程的 Node 运行时指向「真实 Node.js」——内置 Agent 的 dsh 原生模块不认 Electron 36
  // 的 V8 指纹（见 assistant/agentNode.ts）。Docker / 源码直跑时进程本身就是 Node，这里是 no-op。
  // 失败不阻断 Engram 启动：打开内置 Agent 时控制台状态里会给出明确原因。
  const agentNode = ensureAgentNodeRuntime();
  console.log(
    agentNode.ok
      ? `[agent] dsh 运行时 Node：${agentNode.path}（${agentNode.source}，v${agentNode.version}）`
      : `[agent] 未找到可用的 Node.js 运行时：${agentNode.error}`,
  );
  markStartup('agent-node');
  migrate();
  markStartup('migrate');
  ensureDefaultPassword();
  markStartup('default-password');
  // CLI 零配置：本机地址+专用 token 登记到 ~/.engram/config.json（手动 login 过则不覆盖）
  autoRegisterCliConfig();
  markStartup('cli-config');

  const app = await createApp();
  markStartup('create-app');

  // listen 之前只保留「数据一致性 / 路由 / 安全入口」必需的工作：
  // 页面扫描（增量，task-2 的 scanVaultPages）、迁移历史系统文件进 AIWorks 系统区、
  // 清理系统区页面标签。原始资料提取入队、图片资产迁移等非首屏工作移到 listen 之后。
  // （进程级单例：双监听共享一份，createApp() 只做路由装配不碰数据）
  await scanVaultPages();
  markStartup('scan-vault');
  migrateLegacySystemFiles();
  // 旧版冲突备份遗留（AIWorks/同步冲突/ 备份页、记录页、过时说明页）入回收站：须先于
  // ensureSystemFiles，避免新旧说明页撞名。各角色都跑——成员端也有本地遗留（早期接入或
  // 从旧快照播种），且删除经同步链路传播，不再依赖中枢单方面清理。
  migrateConflictBackupDir();
  markStartup('legacy-migrations');
  // 预置 AIWorks 系统区页面（操作日志/同步冲突说明等，缺失即建），并重建索引与关系结构
  ensureSystemFiles();
  cleanupSystemPages();
  markStartup('ensure-system');
  // 无头部署的角色初值（SYNC_ROLE=hub|none，仅首次生效）：必须在 initSync 之前写入，
  // 否则首个 tick 会按旧角色起客户端
  applyEnvSyncRole();
  markStartup('sync-role');

  await app.listen({ port: PORT, host: HOST });
  markStartup('listen-ready');
  logServerReady();
  console.log(`Engram 已启动: http://localhost:${PORT}`);

  // SSE 心跳：保活长连接、探活死连接（断线 EventSource 自动重连）
  const hb = setInterval(heartbeat, 30_000);
  hb.unref();

  // 梦境思考调度（按计划用内置 Agent 整理未提炼资料 + 纠错）：
  // 必须在 listen 之后启动——Agent 的知识库工具要回调本机 /mcp，服务还没监听时首跑必失败。
  startDreamScheduler();
  markStartup('dream-scheduler');

  // 其余启动工作（vault 扫描收尾 / 任务队列恢复 / 带外监听 / 多端同步）全部后台化：
  // 不 await，就绪时间不再受它们影响；任何一步失败只记日志。
  void runBackgroundStartup(app).catch((error) => {
    console.error('[startup] 后台启动链异常（服务不受影响）:', error);
  });

  void retireLegacyDockerOffice().then((removed) => {
    if (removed) app.log.info('Docker Office 已停用，旧服务容器已移除，数据卷保留');
  }).catch((error) => app.log.warn({ err: error }, '旧 Office 容器停用失败；Docker Office 功能仍保持关闭'));

  // HTTPS 直连入口（TLS_DOMAIN 未配置则完全关闭，行为与历史一致）：
  // 证书就绪前 HTTP 照常服务（healthcheck 不受影响），就绪后再起 8443 监听。
  if (TLS_DOMAIN) {
    const { CertManager } = await import('./lib/tls.js');
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
