import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import {
  clearFeishuTokenCache,
  describeFeishuError,
  fetchTenantAccessToken,
  listBitableTables,
  resolveBitableApp,
} from '../lib/feishuBitable.js';
import {
  DEFAULT_FEISHU_API_BASE,
  FEISHU_API_BASES,
  emptyFeishuConfig,
  feishuConfigForClient,
  feishuFilePath,
  isFeishuTableId,
  newFeishuSource,
  normalizeFeishuApiBase,
  normalizeFeishuCredentials,
  normalizeFeishuInterval,
  parseFeishuBitableUrl,
} from '../lib/feishuBitableConfig.js';
import {
  clearFeishuLiveState,
  feishuLiveStates,
  findFeishuPathByMarker,
  readFeishuConfig,
  saveFeishuConfig,
  syncFeishuSource,
  updateFeishuSource,
} from '../lib/feishuBitableSync.js';
import { pagePathTaken } from '../lib/vault.js';

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

export async function feishuRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 设置页状态：凭据是否就绪、数据源列表、每个数据源最近一次拉取的实时状态 */
  app.get('/api/feishu/status', async () => {
    const config = readFeishuConfig();
    return { settings: feishuConfigForClient(config), live: feishuLiveStates() };
  });

  /** 保存凭据并顺手测一次（自动识别飞书 / Lark 国际站） */
  app.put('/api/feishu/credentials', async (req, reply) => {
    const input = normalizeFeishuCredentials(bodyOf(req));
    if (!input) return reply.code(400).send({ error: '请填写飞书应用的 App ID 与 App Secret' });
    const config = readFeishuConfig();
    if (!input.appSecret) {
      if (!config.appSecret) return reply.code(400).send({ error: '首次接入需要填写 App Secret' });
      if (config.appId && config.appId !== input.appId) {
        return reply.code(400).send({ error: '更换 App ID 时需要重新填写 App Secret' });
      }
      input.appSecret = config.appSecret;
    }
    config.appId = input.appId;
    config.appSecret = input.appSecret;
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

  /** 解析链接并列出多维表格里的数据表（链接没带 table 参数时让用户选） */
  app.post('/api/feishu/tables', async (req, reply) => {
    const body = bodyOf(req);
    const parsed = parseFeishuBitableUrl(typeof body.url === 'string' ? body.url : '');
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) {
      return reply.code(400).send({ error: '先保存飞书应用凭据，再添加数据源' });
    }
    try {
      const context = { appId: config.appId, appSecret: config.appSecret };
      const resolved = await resolveBitableApp(context, parsed.link);
      const tables = await listBitableTables(context, {
        apiBase: parsed.link.apiBase,
        appToken: resolved.appToken,
      });
      return {
        url: String(body.url),
        appToken: resolved.appToken,
        appName: resolved.appName,
        apiBase: parsed.link.apiBase,
        origin: parsed.link.origin,
        tableId: parsed.link.tableId,
        viewId: parsed.link.viewId,
        tables,
      };
    } catch (error) {
      return reply.code(400).send({ error: describeFeishuError(error) });
    }
  });

  /** 添加数据源：拉一次元信息校验，入配置后后台拉第一遍 */
  app.post('/api/feishu/sources', async (req, reply) => {
    const body = bodyOf(req);
    const parsed = parseFeishuBitableUrl(typeof body.url === 'string' ? body.url : '');
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const config = readFeishuConfig();
    if (!config.appId || !config.appSecret) {
      return reply.code(400).send({ error: '先保存飞书应用凭据，再添加数据源' });
    }
    const requestedTable = typeof body.tableId === 'string' ? body.tableId.trim() : '';
    const tableId = requestedTable || parsed.link.tableId;
    if (!isFeishuTableId(tableId)) {
      return reply.code(400).send({ error: '链接里没有指定数据表：请先打开具体数据表，或从表格列表里选择一张' });
    }
    try {
      const context = { appId: config.appId, appSecret: config.appSecret };
      const resolved = await resolveBitableApp(context, parsed.link);
      const tables = await listBitableTables(context, {
        apiBase: parsed.link.apiBase,
        appToken: resolved.appToken,
      });
      const table = tables.find((item) => item.tableId === tableId);
      if (!table) {
        return reply.code(400).send({ error: '没有找到这张数据表：可能已被删除，或应用没有访问权限' });
      }
      if (config.sources.some((source) => source.appToken === resolved.appToken && source.tableId === tableId)) {
        return reply.code(409).send({ error: '这张数据表已经添加过了' });
      }
      const filePath = findFeishuPathByMarker(resolved.appToken, tableId)
        || feishuFilePath(table.name || tableId, tableId, pagePathTaken);
      const source = newFeishuSource({
        name: table.name || tableId,
        url: String(body.url),
        appToken: resolved.appToken,
        appName: resolved.appName,
        tableId,
        origin: parsed.link.origin,
        apiBase: parsed.link.apiBase,
        filePath,
      });
      config.sources.push(source);
      config.apiBase = parsed.link.apiBase;
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
