/**
 * 飞书开放平台（多维表格）客户端：取 token、解析知识库节点、读数据表 / 字段 / 记录，
 * 并把记录渲染成可入库的 Markdown。纯网络与纯函数层，不读写 Engram 的库。
 *
 * 认证用「企业自建应用」的 tenant_access_token：
 *  - 应用需要在开放平台开通 bitable:app:readonly（查看多维表格）；
 *  - 若是 /wiki/ 链接，还需要 wiki:wiki:readonly 才能换算成实际 app_token；
 *  - 应用还必须被添加为多该多维表格的协作者，否则飞书会返回无权限。
 *
 * 所有错误都收敛成 FeishuApiError（带飞书 code）＋ describeFeishuError 的中文可执行提示，
 * 设置页直接把这句话展示给用户，不把飞书原始 msg 当成唯一线索。
 */

import { createHash } from 'node:crypto';
import type { ParsedFeishuBitableUrl } from './feishuBitableConfig.js';
import { feishuSourceMarker } from './feishuBitableConfig.js';

/** Open API 里一页记录的最大条数（飞书固定上限） */
const RECORD_PAGE_SIZE = 500;
/** 单次拉取的记录上限：防御异常巨大的表把内存与服务端拖垮；超出在资料里明确标注 */
export const MAX_RECORDS_PER_SYNC = 20_000;
/** 元信息分页上限（数据表 / 字段列表） */
const META_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;

export interface FeishuRequestContext {
  appId: string;
  appSecret: string;
  /** 测试注入；缺省 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入；缺省 Date.now */
  now?: () => number;
  timeoutMs?: number;
}

export class FeishuApiError extends Error {
  readonly code: number;
  readonly httpStatus: number;

  constructor(message: string, options: { code?: number; httpStatus?: number } = {}) {
    super(message);
    this.name = 'FeishuApiError';
    this.code = options.code ?? 0;
    this.httpStatus = options.httpStatus ?? 0;
  }
}

export interface BitableFieldInfo {
  fieldId: string;
  fieldName: string;
  /** 飞书字段类型（1 文本 / 2 数字 / 3 单选 / 5 日期 / 7 复选框 / 11 人员 / 15 链接 / 17 附件 …） */
  type: number;
  isPrimary: boolean;
  property?: unknown;
}

export interface BitableRecordRow {
  recordId: string;
  fields: Record<string, unknown>;
}

export interface FeishuTableMeta {
  appToken: string;
  appName: string;
  tableId: string;
  tableName: string;
}

export interface FetchedBitableTable extends FeishuTableMeta {
  fields: BitableFieldInfo[];
  records: BitableRecordRow[];
  /** 记录数超过 MAX_RECORDS_PER_SYNC 被截断 */
  truncated: boolean;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenEntry>();
/** 并发取 token 的合流：并行拉表时只打一次 token 接口 */
const tokenInflight = new Map<string, Promise<string>>();

/** 测试 / 凭据变更时清空 token 缓存 */
export function clearFeishuTokenCache(): void {
  tokenCache.clear();
  tokenInflight.clear();
}

/** 飞书 token 失效类错误码：清缓存重取一次 */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991664, 99991668]);

function tokenCacheKey(ctx: FeishuRequestContext, apiBase: string): string {
  const secretTag = createHash('sha256').update(ctx.appSecret).digest('hex').slice(0, 12);
  return `${apiBase}|${ctx.appId}|${secretTag}`;
}

function nowOf(ctx: FeishuRequestContext): number {
  return (ctx.now ?? Date.now)();
}

function fetchOf(ctx: FeishuRequestContext): typeof fetch {
  const impl = ctx.fetchImpl ?? globalThis.fetch;
  if (typeof impl !== 'function') {
    throw new FeishuApiError('当前运行环境没有可用的 fetch，无法访问飞书开放平台');
  }
  return impl;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 500) };
  }
}

/** tenant_access_token 的获取（带进程内缓存；提前 2 分钟过期） */
export async function fetchTenantAccessToken(
  ctx: FeishuRequestContext,
  apiBase: string,
): Promise<string> {
  const key = tokenCacheKey(ctx, apiBase);
  const cached = tokenCache.get(key);
  const now = nowOf(ctx);
  if (cached && cached.expiresAt > now) return cached.token;

  // 字段 / 记录 / 表名是并行请求的：缓存为空时让它们共用同一次 token 请求
  const pending = tokenInflight.get(key);
  if (pending) return pending;

  const promise = requestTenantAccessToken(ctx, apiBase, key, now).finally(() => {
    tokenInflight.delete(key);
  });
  tokenInflight.set(key, promise);
  return promise;
}

async function requestTenantAccessToken(
  ctx: FeishuRequestContext,
  apiBase: string,
  key: string,
  now: number,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchOf(ctx)(`${apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: ctx.appId, app_secret: ctx.appSecret }),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FeishuApiError(
      `无法连接飞书开放平台（${apiBase}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const payload = (await readJson(response)) as Record<string, unknown> | null;
  const code = Number(payload?.code ?? 0);
  const token = typeof payload?.tenant_access_token === 'string' ? payload.tenant_access_token : '';
  if (!response.ok || code !== 0 || !token) {
    const msg = typeof payload?.msg === 'string' ? payload.msg : `HTTP ${response.status}`;
    throw new FeishuApiError(
      code === 10003 || code === 10014 || response.status === 401
        ? `App ID 或 App Secret 不正确（飞书返回：${msg}）`
        : `获取飞书访问令牌失败：${msg}`,
      { code, httpStatus: response.status },
    );
  }

  const expire = Number(payload?.expire ?? 7200);
  const ttlMs = (Number.isFinite(expire) && expire > 0 ? expire : 7200) * 1000;
  tokenCache.set(key, { token, expiresAt: now + Math.max(ttlMs - 120_000, 30_000) });
  return token;
}

interface FeishuEnvelope {
  code: number;
  msg: string;
  data?: Record<string, unknown> | null;
}

async function feishuRequest(
  ctx: FeishuRequestContext,
  apiBase: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const url = `${apiBase}${path}`;
  let response: Response;
  try {
    response = await fetchOf(ctx)(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FeishuApiError(
      `无法连接飞书开放平台：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const payload = (await readJson(response)) as FeishuEnvelope | null;
  const code = Number(payload?.code ?? (response.ok ? 0 : -1));
  if (!response.ok || code !== 0) {
    const msg = typeof payload?.msg === 'string' && payload.msg ? payload.msg : `HTTP ${response.status}`;
    throw new FeishuApiError(msg, { code, httpStatus: response.status });
  }
  return (payload?.data as Record<string, unknown> | null) ?? {};
}

/** 带 token 的请求：token 失效时清缓存重取并重试一次 */
async function authorizedRequest(
  ctx: FeishuRequestContext,
  apiBase: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const token = await fetchTenantAccessToken(ctx, apiBase);
  try {
    return await feishuRequest(ctx, apiBase, token, path, init);
  } catch (error) {
    if (error instanceof FeishuApiError && TOKEN_INVALID_CODES.has(error.code)) {
      clearFeishuTokenCache();
      const fresh = await fetchTenantAccessToken(ctx, apiBase);
      return feishuRequest(ctx, apiBase, fresh, path, init);
    }
    throw error;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

/**
 * 把用户粘贴的链接换算成实际的 app_token：
 *  - base 链接本身就是 app_token；
 *  - wiki 链接是知识库节点 token，需要 get_node 换出 obj_token（obj_type 必须是 bitable）。
 * 同时尽力读一次多维表格名称（拿不到不影响拉取）。
 */
export async function resolveBitableApp(
  ctx: FeishuRequestContext,
  link: ParsedFeishuBitableUrl,
): Promise<{ appToken: string; appName: string }> {
  let appToken = link.token;
  if (link.kind === 'wiki') {
    const data = await authorizedRequest(
      ctx,
      link.apiBase,
      `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(link.token)}&obj_type=wiki`,
    );
    const node = (data.node ?? {}) as Record<string, unknown>;
    const objType = str(node.obj_type);
    const objToken = str(node.obj_token);
    if (!objToken) {
      throw new FeishuApiError('知识库节点里没有找到实际文档 token，请改用多维表格的 /base/ 直链');
    }
    if (objType && objType !== 'bitable') {
      throw new FeishuApiError(`这个知识库节点不是多维表格（实际类型：${objType}）`);
    }
    appToken = objToken;
  }

  let appName = '';
  try {
    const data = await authorizedRequest(ctx, link.apiBase, `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}`);
    const app = (data.app ?? {}) as Record<string, unknown>;
    appName = str(app.name);
  } catch {
    // 应用元信息拿不到不影响读表（个别租户会对该接口收紧权限）
  }
  return { appToken, appName };
}

export interface BitableTableSummary {
  tableId: string;
  name: string;
}

/** 列出多维表格下的所有数据表（链接没带 table 参数时让用户选） */
export async function listBitableTables(
  ctx: FeishuRequestContext,
  input: { apiBase: string; appToken: string },
): Promise<BitableTableSummary[]> {
  const tables: BitableTableSummary[] = [];
  let pageToken = '';
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ page_size: String(META_PAGE_SIZE) });
    if (pageToken) query.set('page_token', pageToken);
    const data = await authorizedRequest(
      ctx,
      input.apiBase,
      `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables?${query.toString()}`,
    );
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const raw = (item ?? {}) as Record<string, unknown>;
      const tableId = str(raw.table_id);
      if (tableId) tables.push({ tableId, name: str(raw.name) || tableId });
    }
    if (data.has_more !== true) break;
    pageToken = str(data.page_token);
    if (!pageToken) break;
  }
  return tables;
}

async function fetchTableName(
  ctx: FeishuRequestContext,
  input: { apiBase: string; appToken: string; tableId: string },
): Promise<string> {
  const tables = await listBitableTables(ctx, input);
  const hit = tables.find((table) => table.tableId === input.tableId);
  if (!hit) {
    throw new FeishuApiError('数据表不存在，或应用没有访问该多维表格的权限（请把应用加为多维表格协作者）', {
      code: 1254004,
    });
  }
  return hit.name;
}

async function fetchFields(
  ctx: FeishuRequestContext,
  input: { apiBase: string; appToken: string; tableId: string },
): Promise<BitableFieldInfo[]> {
  const fields: BitableFieldInfo[] = [];
  let pageToken = '';
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ page_size: String(META_PAGE_SIZE) });
    if (pageToken) query.set('page_token', pageToken);
    const data = await authorizedRequest(
      ctx,
      input.apiBase,
      `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/fields?${query.toString()}`,
    );
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const raw = (item ?? {}) as Record<string, unknown>;
      const fieldName = str(raw.field_name);
      if (!fieldName) continue;
      fields.push({
        fieldId: str(raw.field_id),
        fieldName,
        type: num(raw.type),
        isPrimary: raw.is_primary === true,
        property: raw.property,
      });
    }
    if (data.has_more !== true) break;
    pageToken = str(data.page_token);
    if (!pageToken) break;
  }
  return fields;
}

async function fetchRecords(
  ctx: FeishuRequestContext,
  input: { apiBase: string; appToken: string; tableId: string },
): Promise<{ records: BitableRecordRow[]; truncated: boolean }> {
  const records: BitableRecordRow[] = [];
  let pageToken = '';
  for (let page = 0; page < 200; page += 1) {
    const query = new URLSearchParams({ page_size: String(RECORD_PAGE_SIZE) });
    if (pageToken) query.set('page_token', pageToken);
    const data = await authorizedRequest(
      ctx,
      input.apiBase,
      `/open-apis/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(input.tableId)}/records?${query.toString()}`,
    );
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const raw = (item ?? {}) as Record<string, unknown>;
      const fields = raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields)
        ? (raw.fields as Record<string, unknown>)
        : {};
      records.push({ recordId: str(raw.record_id), fields });
      if (records.length >= MAX_RECORDS_PER_SYNC) {
        return { records, truncated: true };
      }
    }
    if (data.has_more !== true) return { records, truncated: false };
    pageToken = str(data.page_token);
    if (!pageToken) return { records, truncated: false };
  }
  return { records, truncated: true };
}

/** 拉取一张数据表的全部内容（整表记录，不受视图筛选影响） */
export async function fetchBitableTable(
  ctx: FeishuRequestContext,
  input: { apiBase: string; appToken: string; appName?: string; tableId: string },
): Promise<FetchedBitableTable> {
  const [tableName, fields, recordResult] = await Promise.all([
    fetchTableName(ctx, input),
    fetchFields(ctx, input),
    fetchRecords(ctx, input),
  ]);
  return {
    appToken: input.appToken,
    appName: input.appName || '',
    tableId: input.tableId,
    tableName,
    fields,
    records: recordResult.records,
    truncated: recordResult.truncated,
  };
}

/** 飞书错误 → 用户能照做的一句话（设置页直接展示） */
export function describeFeishuError(error: unknown): string {
  if (!(error instanceof FeishuApiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const raw = error.message || '';
  if (error.code === 99991672) {
    return '飞书应用缺少多维表格权限：请在飞书开放平台为应用开通「查看、评论和导出多维表格」（bitable:app:readonly），并把应用添加为该多维表格的协作者后重试';
  }
  if (error.code === 1254003) {
    return '应用无权访问这个多维表格：请在多维表格右上角「…」→ 添加文档应用，把飞书应用加为协作者后重试';
  }
  if (error.code === 1254004) {
    return '数据表不存在或应用无权访问：请确认链接里的 table 参数，并确认应用已加为多维表格协作者';
  }
  if (error.code === 91402 || error.code === 131005) {
    return '知识库节点不存在或应用无权访问：请确认链接可访问，并给应用开通知识库只读权限（wiki:wiki:readonly）';
  }
  if (TOKEN_INVALID_CODES.has(error.code) || error.code === 10003 || error.code === 10014) {
    return `飞书应用凭据无效：请检查 App ID / App Secret 是否填对、应用是否已发布（飞书返回：${raw}）`;
  }
  if (/无法连接飞书开放平台/.test(raw)) return raw;
  return `飞书接口报错${error.code ? `（${error.code}）` : ''}：${raw || '未知错误'}`;
}

const DATE_FIELD_TYPES = new Set([5, 1001, 1002]);
const USER_FIELD_TYPES = new Set([11, 1003, 1004]);
const ATTACHMENT_FIELD_TYPES = new Set([17]);
const CHECKBOX_FIELD_TYPE = 7;
const LINK_FIELD_TYPE = 15;
const LOCATION_FIELD_TYPE = 22;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 飞书时间戳（毫秒）→ 本地时间 `YYYY-MM-DD HH:mm`（资料里给人看） */
export function formatFeishuDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function truncateCell(text: string): string {
  const MAX_CELL = 1000;
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
}

/** 单元格 → 一行 Markdown 文本（不转义，转义在 renderBitableMarkdown 里统一做） */
export function bitableCellText(value: unknown, fieldType: number): string {
  if (value === null || value === undefined) return '';
  if (fieldType === CHECKBOX_FIELD_TYPE) {
    if (value === true) return '是';
    if (value === false) return '否';
    return '';
  }
  if (DATE_FIELD_TYPES.has(fieldType)) {
    const ms = typeof value === 'number' ? value : Number(value);
    const formatted = formatFeishuDateTime(ms);
    if (formatted) return formatted;
  }
  if (ATTACHMENT_FIELD_TYPES.has(fieldType)) {
    const list = Array.isArray(value) ? value : [value];
    return list
      .map((item) => {
        if (typeof item === 'string') return item;
        const raw = (item ?? {}) as Record<string, unknown>;
        return str(raw.name) || str(raw.file_token);
      })
      .filter(Boolean)
      .join('、');
  }
  if (USER_FIELD_TYPES.has(fieldType)) {
    const list = Array.isArray(value) ? value : [value];
    return list
      .map((item) => {
        if (typeof item === 'string') return item;
        const raw = (item ?? {}) as Record<string, unknown>;
        return str(raw.name) || str(raw.en_name) || str(raw.id);
      })
      .filter(Boolean)
      .join('、');
  }
  if (LINK_FIELD_TYPE === fieldType) {
    const raw = (value ?? {}) as Record<string, unknown>;
    const text = str(raw.text);
    const link = str(raw.link);
    if (text && link) return `${text}（${link}）`;
    return text || link;
  }
  if (LOCATION_FIELD_TYPE === fieldType) {
    const raw = (value ?? {}) as Record<string, unknown>;
    return (
      str(raw.full_address)
      || [str(raw.pname), str(raw.cityname), str(raw.address)].filter(Boolean).join('')
      || str(raw.name)
    );
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => bitableCellText(item, 0))
      .filter(Boolean)
      .join('、');
  }
  if (typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    // 文本（含 @人 / 链接富文本段）、人员、附件、公式结果都可能带这些字段
    if (typeof raw.text === 'string') {
      const link = str(raw.link);
      return link && link !== raw.text ? `${raw.text}（${link}）` : raw.text;
    }
    if (typeof raw.name === 'string') return raw.name;
    if (typeof raw.link === 'string') return raw.link;
    if (typeof raw.value === 'string' || typeof raw.value === 'number') return String(raw.value);
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

export interface RenderBitableInput extends FeishuTableMeta {
  url: string;
  fields: BitableFieldInfo[];
  records: BitableRecordRow[];
  truncated: boolean;
}

/**
 * 记录 → 原始资料 Markdown 正文（不含 frontmatter、不含一级标题：
 * 标题由文件名与 frontmatter 承载，见 lib/rawBody.ts）。
 *
 * 用 Markdown 表格而不是逐条小节：多维表格的价值在列结构，表格最省行数也最像原表；
 * 单元格里的换行压成 `<br>`、竖线转义，保证表格不被撑破。
 *
 * 正文**不写同步时间**：时间每次拉取都会变，会让「内容没变」的自动同步也重写文件、
 * 把已提炼标记打回待办。最近拉取时间由设置页的配置状态展示；文件正文只在数据变化时变。
 */
export function renderBitableMarkdown(input: RenderBitableInput): string {
  const lines: string[] = [];
  lines.push(feishuSourceMarker(input.appToken, input.tableId));
  lines.push('> 本文件由 Engram 从飞书多维表格自动同步，重新拉取会整篇覆盖，请勿手改。');
  const owner = input.appName ? `多维表格：${input.appName} · ` : '';
  lines.push(`> ${owner}数据表：${input.tableName}`);
  if (input.url) lines.push(`> 来源链接：${input.url}`);
  const countNote = input.truncated
    ? `共 ${input.records.length} 条记录；表内记录过多，本次只拉取前 ${MAX_RECORDS_PER_SYNC} 条`
    : `共 ${input.records.length} 条记录，${input.fields.length} 列`;
  lines.push(`> ${countNote}`);
  lines.push('');

  if (!input.fields.length) {
    lines.push('（该数据表没有可读取的字段）');
    return `${lines.join('\n')}\n`;
  }
  if (!input.records.length) {
    lines.push('（该数据表暂无记录）');
    return `${lines.join('\n')}\n`;
  }

  const escape = (text: string): string =>
    truncateCell(text.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim());

  lines.push(`| ${input.fields.map((field) => escape(field.fieldName)).join(' | ')} |`);
  lines.push(`| ${input.fields.map(() => '---').join(' | ')} |`);
  for (const record of input.records) {
    const cells = input.fields.map((field) => escape(bitableCellText(record.fields[field.fieldName], field.type)));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}
