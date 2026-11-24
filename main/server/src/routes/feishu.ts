import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from './auth.js';
import {
  FEISHU_OAUTH_SCOPES,
  buildFeishuAuthorizeUrl,
  clearFeishuTokenCache,
  describeFeishuError,
  exchangeFeishuOauthCode,
  fetchTenantAccessToken,
  listBitableTables,
  resolveBitableApp,
  searchBitableDocs,
} from '../lib/feishuBitable.js';
import {
  DEFAULT_FEISHU_API_BASE,
  FEISHU_API_BASES,
  emptyFeishuConfig,
  feishuConfigForClient,
  feishuFilePath,
  isFeishuAppToken,
  isFeishuTableId,
  newFeishuSource,
  normalizeFeishuApiBase,
  normalizeFeishuCredentials,
  normalizeFeishuInterval,
  normalizeFeishuOrigin,
  parseFeishuBitableUrl,
} from '../lib/feishuBitableConfig.js';
import {
  clearFeishuLiveState,
  ensureFeishuAccessToken,
  feishuLiveStates,
  findFeishuPathByMarker,
  readFeishuConfig,
  saveFeishuConfig,
  syncFeishuSource,
  updateFeishuConfig,
  updateFeishuSource,
} from '../lib/feishuBitableSync.js';
import { pagePathTaken } from '../lib/vault.js';
import { requestOrigin } from '../lib/requestOrigin.js';

/**
 * 设置 → 外设接入 →「飞书多维表格」的接口。
 *
 * 与办公本接入同属 owner 级管理面（requireAuth）：凭据落在中枢本机、拉取在服务器上执行，
 * 手机只持同步成员令牌、没有这条路径，设置页按 features.agentAdmin 隐藏整组（need: 'agent'）。
 *
 * 凭据安全：App Secret 只进 settings 表，GET 只回 hasSecret / App ID；
 * 任何日志、错误响应与前端都拿不到 Secret 原文。
 *
 * 添加数据源 = 粘贴链接 → 解析 app_token / table_id（知识库链接经 wiki 接口换算）→
 * 立刻返回并后台拉第一遍；设置页轮询 GET status 的 live 字段看进度与失败原因。
 */

async function probeCredentials(config: {
  appId: string;
  appSecret: string;
  apiBase: string;
}): Promise<{ ok: boolean; error: string; apiBase: string }> {
  const bases = Array.from(
    new Set([normalizeFeishuApiBase(config.apiBase) ?? DEFAULT_FEISHU_API_BASE, ...FEISHU_API_BASES]),
  );
  let firstError = '';
  for (const apiBase of bases) {
    try {
      await fetchTenantAccessToken({ appId: config.appId, appSecret: config.appSecret }, apiBase);
      return { ok: true, error: '', apiBase };
    } catch (error) {
      if (!firstError) firstError = describeFeishuError(error);
    }
  }
  return { ok: false, error: firstError || '飞书应用凭据不可用', apiBase: config.apiBase };
}

function bodyOf(req: { body?: unknown }): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

/** OAuth state 只存内存：10 分钟内有效、一次性使用（服务重启后需重新点授权） */
const OAUTH_STATE_TTL_MS = 10 * 60_000;
type OauthState = { createdAt: number; redirectUri: string; appId: string; mode: 'tab' | 'external' };
const oauthStates = new Map<string, OauthState>();

function pruneOauthStates(): void {
  const now = Date.now();
  for (const [state, record] of oauthStates) {
    if (now - record.createdAt > OAUTH_STATE_TTL_MS) oauthStates.delete(state);
  }
}

function callbackUriOf(req: FastifyRequest): string {
  const origin = requestOrigin(req);
  return origin ? `${origin}/api/feishu/oauth/callback` : '';
}

/** 桌面端在系统浏览器里完成授权后展示的落地页（无脚本、不依赖登录态） */
function oauthResultHtml(title: string, message: string, tone: 'ok' | 'error'): string {
  const color = tone === 'error' ? '#b3261e' : '#2f6f4f';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f3ec; color: #2b2a27;
         font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 30rem; margin: 24px; padding: 28px 30px; border-radius: 16px; background: #fff; box-shadow: 0 8px 24px rgba(40, 36, 28, .08); }
  h1 { margin: 0 0 10px; font-size: 20px; color: ${color}; }
  p { margin: 0 0 8px; }
  .hint { color: #6b675f; font-size: 13px; }
</style></head>
<body><main><h1>${title}</h1><p>${message}</p><p class="hint">可以关闭这个页面，回到 Engram 的 设置 → 外设接入 → 飞书多维表格 查看状态。</p></main></body></html>`;
}

export async function feishuRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    // OAuth 回调是飞书重定向回来的顶层导航：可能发生在另一个浏览器/WebView 里，
    // 不能依赖登录 Cookie；安全性由一次性 state（只能由已登录的设置页生成）保证。
    if (req.url.startsWith('/api/feishu/oauth/callback')) return;
    await requireAuth(req, reply);
  });

  /** 设置页状态：凭据是否就绪、数据源列表、每个数据源最近一次拉取的实时状态 */
  app.get('/api/feishu/status', async (req) => {
    const config = readFeishuConfig();
    return {
      settings: feishuConfigForClient(config),
      live: feishuLiveStates(),
      redirectUri: callbackUriOf(req),
      scopes: FEISHU_OAUTH_SCOPES,
    };
  });

  /** 生成飞书账号授权链接：浏览器跳过去登录/同意，回调带 code + state 回来 */
  app.get('/api/feishu/oauth/start', async (req, reply) => {
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) {
      return reply.code(400).send({ error: '先保存飞书应用凭据，再进行飞书授权' });
    }
    const redirectUri = callbackUriOf(req);
    if (!redirectUri) {
      return reply.code(400).send({ error: '无法识别当前访问地址，请通过浏览器地址栏里的 Engram 地址访问后再授权' });
    }
    pruneOauthStates();
    const state = crypto.randomBytes(24).toString('hex');
    const mode: OauthState['mode'] = String((req.query as Record<string, unknown>)?.mode || '') === 'external'
      ? 'external'
      : 'tab';
    oauthStates.set(state, { createdAt: Date.now(), redirectUri, appId: config.appId, mode });
    return {
      url: buildFeishuAuthorizeUrl({
        apiBase: config.apiBase,
        appId: config.appId,
        redirectUri,
        state,
      }),
      redirectUri,
      scopes: FEISHU_OAUTH_SCOPES,
    };
  });

  /**
   * 飞书授权回调（浏览器顶层跳转回来，SameSite=Lax Cookie 会带上）。
   * 成功/失败都 302 回设置页并带 `feishu=bound` / `feishu_error=...`，由设置页提示。
   */
  app.get('/api/feishu/oauth/callback', async (req, reply) => {
    const query = (req.query || {}) as Record<string, unknown>;
    const origin = requestOrigin(req) || '';
    const state = String(query.state || '');
    const record = oauthStates.get(state);
    oauthStates.delete(state);
    const external = record?.mode === 'external';
    const html = (title: string, message: string, tone: 'ok' | 'error') =>
      reply.type('text/html; charset=utf-8').send(oauthResultHtml(title, message, tone));
    const back = (params: string) =>
      `${origin}/settings?section=peripheral&anchor=peripheral-feishu&${params}`;
    const fail = (message: string) => {
      // 系统浏览器（桌面端）没有 Engram 登录态，不要把人甩到登录页：给一张结果页
      if (external) return html('飞书授权未完成', message, 'error');
      return reply.redirect(back(`feishu=error&feishu_error=${encodeURIComponent(message)}`));
    };

    if (!record || Date.now() - record.createdAt > OAUTH_STATE_TTL_MS) {
      return fail('授权已过期，请重新点「飞书授权」');
    }
    if (query.error) {
      return fail('飞书授权被取消或拒绝');
    }
    const code = String(query.code || '');
    if (!code) return fail('飞书没有返回授权码，请重新授权');
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) {
      return fail('飞书应用凭据已被清除，请先重新保存凭据再授权');
    }
    if (record.appId !== config.appId) {
      return fail('飞书应用凭据已变化，请重新点「飞书授权」');
    }
    try {
      const tokens = await exchangeFeishuOauthCode(
        { appId: config.appId, appSecret: config.appSecret },
        { apiBase: config.apiBase, code, redirectUri: record.redirectUri },
      );
      updateFeishuConfig((current) => {
        current.oauth = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
          grantedAt: Date.now(),
        };
        current.oauthRequired = false;
      });
      clearFeishuTokenCache();
      if (external) {
        return html('飞书账号授权成功', '已保存到 Engram，可以回到 Engram 窗口继续选表。', 'ok');
      }
      return reply.redirect(back('feishu=bound'));
    } catch (error) {
      return fail(describeFeishuError(error));
    }
  });

  /** 解除飞书账号授权（保留应用凭据与数据源；用应用身份继续拉或重新授权） */
  app.post('/api/feishu/oauth/unbind', async () => {
    updateFeishuConfig((config) => {
      config.oauth = null;
      config.oauthRequired = false;
    });
    return { ok: true };
  });

  /** 按名字搜索当前飞书账号可见的多维表格（授权后不用再粘贴链接） */
  app.post('/api/feishu/search', async (req, reply) => {
    const config = readFeishuConfig();
    if (!config.oauth) {
      return reply.code(400).send({
        error: config.oauthRequired ? '飞书授权已失效，请重新点「飞书授权」' : '先完成飞书账号授权，再搜索多维表格',
      });
    }
    const query = typeof bodyOf(req).query === 'string' ? String(bodyOf(req).query).trim() : '';
    if (!query) return reply.code(400).send({ error: '请输入多维表格名称关键词' });
    try {
      const accessToken = await ensureFeishuAccessToken(config);
      const items = await searchBitableDocs(
        { appId: config.appId, appSecret: config.appSecret, accessToken },
        { apiBase: config.apiBase, query },
      );
      return { items };
    } catch (error) {
      return reply.code(400).send({ error: describeFeishuError(error) });
    }
  });

  /** 保存凭据并顺手测一次（自动识别飞书 / Lark 国际站） */
  app.put('/api/feishu/credentials', async (req, reply) => {
    const input = normalizeFeishuCredentials(bodyOf(req));
    if (!input) return reply.code(400).send({ error: '请填写飞书应用的 App ID 与 App Secret' });
    const config = readFeishuConfig();
    const secretProvided = Boolean(input.appSecret);
    // 换应用（App ID 变了，或显式换了另一把 Secret）→ 旧 OAuth 令牌作废
    const appChanged = Boolean(config.appId)
      && (config.appId !== input.appId || (secretProvided && config.appSecret !== input.appSecret));
    if (!input.appSecret) {
      if (!config.appSecret) return reply.code(400).send({ error: '首次接入需要填写 App Secret' });
      if (config.appId && config.appId !== input.appId) {
        return reply.code(400).send({ error: '更换 App ID 时需要重新填写 App Secret' });
      }
      input.appSecret = config.appSecret;
    }
    config.appId = input.appId;
    config.appSecret = input.appSecret;
    if (appChanged) {
      config.oauth = null;
      config.oauthRequired = false;
    }
    saveFeishuConfig(config);
    clearFeishuTokenCache();
    const test = await probeCredentials(config);
    if (test.ok && test.apiBase !== config.apiBase) {
      config.apiBase = test.apiBase;
      saveFeishuConfig(config);
    }
    return { ok: true, test, settings: feishuConfigForClient(readFeishuConfig()) };
  });

  /** 只测连通性，不改配置 */
  app.post('/api/feishu/test', async (_req, reply) => {
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) {
      return reply.code(400).send({ error: '先保存飞书应用凭据，再测试连接' });
    }
    clearFeishuTokenCache();
    const test = await probeCredentials(config);
    if (test.ok && test.apiBase !== config.apiBase) {
      config.apiBase = test.apiBase;
      saveFeishuConfig(config);
    }
    return test;
  });

  /** 解析链接 / app_token 并列出多维表格里的数据表（搜索选表或链接没带 table 时用） */
  app.post('/api/feishu/tables', async (req, reply) => {
    const body = bodyOf(req);
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) {
      return reply.code(400).send({ error: '先保存飞书应用凭据，再添加数据源' });
    }
    const appTokenInput = isFeishuAppToken(body.appToken) ? String(body.appToken).trim() : '';
    let apiBase = normalizeFeishuApiBase(body.apiBase) ?? config.apiBase;
    let origin = normalizeFeishuOrigin(body.origin) || '';
    let tableId = '';
    let viewId = '';
    let url = typeof body.url === 'string' ? body.url : '';
    try {
      const accessToken = await ensureFeishuAccessToken(config);
      const context = { appId: config.appId, appSecret: config.appSecret, accessToken };
      let appToken = appTokenInput;
      let appName = typeof body.appName === 'string' ? String(body.appName).trim().slice(0, 200) : '';
      if (!appToken) {
        const parsed = parseFeishuBitableUrl(url);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        apiBase = parsed.link.apiBase;
        origin = parsed.link.origin;
        tableId = parsed.link.tableId;
        viewId = parsed.link.viewId;
        const resolved = await resolveBitableApp(context, parsed.link);
        appToken = resolved.appToken;
        appName = resolved.appName;
      } else {
        if (!origin) {
          origin = apiBase.includes('larksuite.com') ? 'https://www.larksuite.com' : 'https://www.feishu.cn';
        }
        url = url || `${origin}/base/${appToken}`;
      }
      const tables = await listBitableTables(context, { apiBase, appToken });
      return { url, appToken, appName, apiBase, origin, tableId, viewId, tables };
    } catch (error) {
      return reply.code(400).send({ error: describeFeishuError(error) });
    }
  });

  /** 添加数据源：链接或搜索选中的 app_token 都可以；入配置后后台拉第一遍 */
  app.post('/api/feishu/sources', async (req, reply) => {
    const body = bodyOf(req);
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) {
      return reply.code(400).send({ error: '先保存飞书应用凭据，再添加数据源' });
    }
    const appTokenInput = isFeishuAppToken(body.appToken) ? String(body.appToken).trim() : '';
    const requestedTable = typeof body.tableId === 'string' ? body.tableId.trim() : '';
    let apiBase = normalizeFeishuApiBase(body.apiBase) ?? config.apiBase;
    let origin = normalizeFeishuOrigin(body.origin) || '';
    let url = typeof body.url === 'string' ? body.url.trim() : '';
    let appName = typeof body.appName === 'string' ? String(body.appName).trim().slice(0, 200) : '';
    let tableId = requestedTable;
    try {
      const accessToken = await ensureFeishuAccessToken(config);
      const context = { appId: config.appId, appSecret: config.appSecret, accessToken };
      let appToken = appTokenInput;
      if (!appToken) {
        const parsed = parseFeishuBitableUrl(url);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        apiBase = parsed.link.apiBase;
        origin = parsed.link.origin;
        tableId = tableId || parsed.link.tableId;
        const resolved = await resolveBitableApp(context, parsed.link);
        appToken = resolved.appToken;
        appName = resolved.appName;
      } else {
        if (!origin) {
          origin = apiBase.includes('larksuite.com') ? 'https://www.larksuite.com' : 'https://www.feishu.cn';
        }
        url = url || `${origin}/base/${appToken}`;
      }
      if (!isFeishuTableId(tableId)) {
        return reply.code(400).send({ error: '请选择要拉取的数据表' });
      }
      const tables = await listBitableTables(context, { apiBase, appToken });
      const table = tables.find((item) => item.tableId === tableId);
      if (!table) {
        return reply.code(400).send({ error: '没有找到这张数据表：可能已被删除，或当前飞书账号没有访问权限' });
      }
      // 来源链接带上选中的数据表；搜索选表时原始 url 可能只有 base
      if (url && !/[?&]table=/.test(url)) {
        url += `${url.includes('?') ? '&' : '?'}table=${tableId}`;
      }
      if (config.sources.some((source) => source.appToken === appToken && source.tableId === tableId)) {
        return reply.code(409).send({ error: '这张数据表已经添加过了' });
      }
      const filePath = findFeishuPathByMarker(appToken, tableId)
        || feishuFilePath(table.name || tableId, tableId, pagePathTaken);
      const source = newFeishuSource({
        name: table.name || tableId,
        url,
        appToken,
        appName,
        tableId,
        origin,
        apiBase,
        filePath,
      });
      config.sources.push(source);
      config.apiBase = apiBase;
      saveFeishuConfig(config);
      // 首次拉取放后台：大表可能几十秒，接口先回 201，设置页轮询 live 看进度
      void syncFeishuSource(source.id);
      return reply.code(201).send({ source, live: feishuLiveStates()[source.id] || null });
    } catch (error) {
      return reply.code(400).send({ error: describeFeishuError(error) });
    }
  });

  /** 调整自动同步开关 / 间隔 */
  app.patch('/api/feishu/sources/:id', async (req, reply) => {
    const id = String((req.params as { id?: string }).id || '');
    const body = bodyOf(req);
    if (body.autoSync !== undefined && typeof body.autoSync !== 'boolean') {
      return reply.code(400).send({ error: 'autoSync 必须是布尔值' });
    }
    let interval: number | null = null;
    if (body.intervalMinutes !== undefined) {
      interval = normalizeFeishuInterval(body.intervalMinutes);
      if (interval === null) return reply.code(400).send({ error: '不支持的自动同步间隔' });
    }
    const updated = updateFeishuSource(id, (source) => ({
      ...source,
      autoSync: typeof body.autoSync === 'boolean' ? body.autoSync : source.autoSync,
      intervalMinutes: (interval as typeof source.intervalMinutes | null) ?? source.intervalMinutes,
    }));
    if (!updated) return reply.code(404).send({ error: '数据源不存在' });
    return { source: updated, live: feishuLiveStates()[id] || null };
  });

  /** 移出数据源：只删配置，已拉取的资料留在原始资料里（删除用户资料走回收站） */
  app.delete('/api/feishu/sources/:id', async (req, reply) => {
    const id = String((req.params as { id?: string }).id || '');
    const config = readFeishuConfig();
    const index = config.sources.findIndex((source) => source.id === id);
    if (index < 0) return reply.code(404).send({ error: '数据源不存在' });
    const [removed] = config.sources.splice(index, 1);
    saveFeishuConfig(config);
    clearFeishuLiveState(id);
    return { ok: true, removed: removed.id, filePath: removed.filePath };
  });

  /** 立即拉取（后台执行，202 + 轮询 status 的 live 字段） */
  app.post('/api/feishu/sources/:id/sync', async (req, reply) => {
    const id = String((req.params as { id?: string }).id || '');
    const config = readFeishuConfig();
    const source = config.sources.find((item) => item.id === id);
    if (!source) return reply.code(404).send({ error: '数据源不存在' });
    if (!config.appId || !config.appSecret) {
      return reply.code(400).send({ error: '先保存飞书应用凭据，再拉取资料' });
    }
    void syncFeishuSource(id);
    return reply.code(202).send({ ok: true, live: feishuLiveStates()[id] || null });
  });

  /** 清除凭据与全部数据源（设置页有二次确认；已拉取的资料同样保留） */
  app.delete('/api/feishu/credentials', async () => {
    const config = readFeishuConfig();
    saveFeishuConfig(emptyFeishuConfig());
    clearFeishuTokenCache();
    for (const source of config.sources) clearFeishuLiveState(source.id);
    return { ok: true };
  });
}
