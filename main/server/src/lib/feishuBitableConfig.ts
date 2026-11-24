/**
 * 飞书多维表格接入的配置（settings 键 `feishu_bitable_config`）。
 *
 * 凭据属于 owner 级配置：App Secret 只落在中枢本机的 settings 表，
 * **不登记同步偏好、不进 /api/settings 白名单、不回显给前端**；
 * 前端只拿 `hasSecret` 与 App ID（App ID 是标识不是密钥）。
 *
 * 数据源（source）是「一张多维表格里的一个数据表」：用户粘贴表格链接，
 * 服务端解析出 app_token / table_id，拉取期间把记录渲染成 Markdown 存进
 * `原始资料/文档/飞书多维表格/<表名>.md`，重新拉取覆盖同一份文件。
 */

import { randomUUID } from 'node:crypto';
import { RAW_DOC_DIR } from './rawSections.js';

export const FEISHU_CONFIG_KEY = 'feishu_bitable_config';

/** 拉取资料的落点：原始资料/文档/飞书多维表格（仍属「文档」二级分类） */
export const FEISHU_RAW_DIR = `${RAW_DOC_DIR}/飞书多维表格`;

/** 自动同步间隔（分钟）：关闭 / 每小时 / 每 6 小时 / 每天 */
export const FEISHU_SYNC_INTERVALS = [60, 360, 1440] as const;

export type FeishuSyncIntervalMinutes = (typeof FEISHU_SYNC_INTERVALS)[number];

export type FeishuSyncStatus = 'never' | 'ok' | 'error';

export interface FeishuBitableSource {
  /** 稳定 ID（配置里唯一，删除/同步都用它定位；不随表格改名变化） */
  id: string;
  /** 展示名 = 数据表名（表格改名后拉取时更新） */
  name: string;
  /** 用户粘贴的原始链接（界面展示与追溯） */
  url: string;
  /** 多维表格 app_token（wiki 链接已换算成实际对象 token） */
  appToken: string;
  /** 多维表格应用名（文档里的「所属多维表格」） */
  appName: string;
  tableId: string;
  /** 来源站点（https://xxx.feishu.cn / https://xxx.larksuite.com） */
  origin: string;
  /** Open API 基址（国内 open.feishu.cn / 国际 open.larksuite.com） */
  apiBase: string;
  /** 资料落点（vault 相对路径；表格改名不换路径，避免同一张表生出两份资料） */
  filePath: string;
  /** 是否按间隔自动拉取 */
  autoSync: boolean;
  intervalMinutes: FeishuSyncIntervalMinutes;
  createdAt: number;
  /** 上次成功拉取时间（0 = 从未成功） */
  lastSyncAt: number;
  lastStatus: FeishuSyncStatus;
  lastError: string;
  lastRecordCount: number;
}

export interface FeishuBitableConfig {
  appId: string;
  appSecret: string;
  /** 最近一次使用的 Open API 基址（凭据测试时自动识别国内 / 国际站） */
  apiBase: string;
  /**
   * 飞书账号 OAuth 授权结果（user_access_token + refresh_token）。
   * 只落中枢本机 settings：不进 /api/settings、不随多端同步、日志与前端都拿不到原文。
   */
  oauth: FeishuOauthBinding | null;
  /** 曾经授权过但令牌刷新失败：拉取时直接提示重新授权，不偷偷回退到应用身份 */
  oauthRequired: boolean;
  sources: FeishuBitableSource[];
}

export interface FeishuOauthBinding {
  accessToken: string;
  refreshToken: string;
  /** user_access_token 过期时间（ms） */
  expiresAt: number;
  /** refresh_token 过期时间（ms；0 = 未知） */
  refreshExpiresAt: number;
  grantedAt: number;
}

/** 允许的 Open API 基址（不接受用户随便填主机，避免凭据外发） */
export const FEISHU_API_BASES = ['https://open.feishu.cn', 'https://open.larksuite.com'] as const;

export const DEFAULT_FEISHU_API_BASE = 'https://open.feishu.cn';

export function emptyFeishuConfig(): FeishuBitableConfig {
  return {
    appId: '',
    appSecret: '',
    apiBase: DEFAULT_FEISHU_API_BASE,
    oauth: null,
    oauthRequired: false,
    sources: [],
  };
}

/** 前端可见的 OAuth 状态：只有「绑没绑 + 何时过期」，绝不含令牌 */
export interface FeishuOauthForClient {
  bound: boolean;
  /** 曾经授权过但已失效，需要重新授权 */
  required: boolean;
  expiresAt: number;
  refreshExpiresAt: number;
  grantedAt: number;
}

/** 前端可见的配置：没有任何密钥字段 */
export interface FeishuConfigForClient {
  configured: boolean;
  appId: string;
  hasSecret: boolean;
  apiBase: string;
  oauth: FeishuOauthForClient;
  sources: FeishuBitableSource[];
}

const APP_ID_MAX = 200;
const APP_SECRET_MAX = 500;

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : '';
}

function positiveInt(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
}

function normalizeInterval(value: unknown): FeishuSyncIntervalMinutes {
  const num = Number(value);
  return (FEISHU_SYNC_INTERVALS as readonly number[]).includes(num)
    ? (num as FeishuSyncIntervalMinutes)
    : 60;
}

function normalizeStatus(value: unknown): FeishuSyncStatus {
  return value === 'ok' || value === 'error' ? value : 'never';
}

/** 数据表 ID / 视图 ID 的形态校验（飞书固定前缀） */
const TABLE_ID_RE = /^tbl[A-Za-z0-9]{2,100}$/;
const VIEW_ID_RE = /^vew[A-Za-z0-9]{2,100}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{6,200}$/;

export interface ParsedFeishuBitableUrl {
  /** base = 直接的多维表格链接；wiki = 知识库节点链接（需再换 app_token） */
  kind: 'base' | 'wiki';
  /** base 链接为 app_token；wiki 链接为 node_token */
  token: string;
  tableId: string;
  viewId: string;
  /** 文档所在站点，如 https://abc.feishu.cn */
  origin: string;
  /** Open API 基址 */
  apiBase: string;
}

export type ParseFeishuBitableUrlResult =
  | { ok: true; link: ParsedFeishuBitableUrl }
  | { ok: false; error: string };

/** 文档站点 → Open API 基址；不认识的域名直接拒绝（避免把 App Secret 发给任意主机） */
function openApiBaseFor(hostname: string): string | null {
  const host = hostname.toLowerCase();
  if (host === 'feishu.cn' || host.endsWith('.feishu.cn')) return 'https://open.feishu.cn';
  if (host === 'larksuite.com' || host.endsWith('.larksuite.com')) return 'https://open.larksuite.com';
  return null;
}

/**
 * 解析粘贴的多维表格链接：
 *  - `https://abc.feishu.cn/base/<app_token>?table=tbl…&view=vew…`
 *  - `https://abc.feishu.cn/wiki/<node_token>?table=tbl…`（知识库里的多维表格，需 wiki 接口换算）
 * 只接受飞书 / Lark 域名；table 参数缺失时返回空字符串，由调用方让用户从表格列表里选。
 */
export function parseFeishuBitableUrl(raw: string): ParseFeishuBitableUrlResult {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, error: '请粘贴飞书多维表格链接' };
  if (input.length > 2000) return { ok: false, error: '链接过长，请只粘贴多维表格地址' };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, error: '链接格式不正确，请从飞书复制完整的多维表格地址' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: '只支持 http(s) 链接' };
  }

  const apiBase = openApiBaseFor(url.hostname);
  if (!apiBase) {
    return { ok: false, error: '不是飞书多维表格链接：域名需要是 feishu.cn 或 larksuite.com' };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const kind = segments[0];
  if ((kind !== 'base' && kind !== 'wiki') || !segments[1]) {
    return {
      ok: false,
      error: '链接里没有多维表格：请打开具体多维表格（/base/… 或 /wiki/…）后复制地址',
    };
  }
  const token = segments[1];
  if (!TOKEN_RE.test(token)) return { ok: false, error: '链接里的多维表格 ID 格式不正确' };

  const tableParam = url.searchParams.get('table') || '';
  const viewParam = url.searchParams.get('view') || '';
  if (tableParam && !TABLE_ID_RE.test(tableParam)) {
    return { ok: false, error: '链接里的 table 参数不像数据表 ID（应以 tbl 开头）' };
  }
  if (viewParam && !VIEW_ID_RE.test(viewParam)) {
    return { ok: false, error: '链接里的 view 参数不像视图 ID（应以 vew 开头）' };
  }

  return {
    ok: true,
    link: {
      kind,
      token,
      tableId: tableParam,
      viewId: viewParam,
      origin: `https://${url.hostname.toLowerCase()}`,
      apiBase,
    },
  };
}

/** 文件名清洗：去掉 Windows / Markdown 路径不允许的字符，限制长度；空名用表 ID 兜底 */
export function feishuFileName(name: string, tableId: string): string {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 80)
    .replace(/[-.\s]+$/g, '');
  if (cleaned) return cleaned;
  const fallback = String(tableId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(-12);
  return fallback ? `多维表格-${fallback}` : `多维表格-${Date.now()}`;
}

/**
 * 资料落点：`原始资料/文档/飞书多维表格/<表名>.md`；重名时追加序号。
 * `exists` 由调用方注入，纯函数便于单测。
 */
export function feishuFilePath(name: string, tableId: string, exists: (rel: string) => boolean): string {
  const stem = feishuFileName(name, tableId);
  for (let i = 1; i <= 99; i += 1) {
    const candidate = `${FEISHU_RAW_DIR}/${i === 1 ? stem : `${stem} (${i})`}.md`;
    if (!exists(candidate)) return candidate;
  }
  return `${FEISHU_RAW_DIR}/${stem}-${Date.now()}.md`;
}

/**
 * 资料正文里的来源标记（HTML 注释，渲染不可见）：
 * 重新接入同一张表时据此复用已拉取的资料文件，而不是另起一份。
 */
export function feishuSourceMarker(appToken: string, tableId: string): string {
  return `<!-- engram:feishu-bitable app=${appToken} table=${tableId} -->`;
}

export function parseFeishuSourceMarker(body: string): { appToken: string; tableId: string } | null {
  const match = /<!--\s*engram:feishu-bitable\s+app=([A-Za-z0-9_-]+)\s+table=(tbl[A-Za-z0-9]+)\s*-->/.exec(
    String(body ?? ''),
  );
  return match ? { appToken: match[1], tableId: match[2] } : null;
}

function normalizeSource(value: unknown): FeishuBitableSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id, 120);
  const appToken = text(raw.appToken, 200);
  const tableId = text(raw.tableId, 120);
  const origin = text(raw.origin, 300);
  const apiBase = normalizeFeishuApiBase(raw.apiBase);
  const filePath = text(raw.filePath, 500);
  if (!id || !appToken || !tableId || !filePath) return null;
  if (!TABLE_ID_RE.test(tableId) || !TOKEN_RE.test(appToken)) return null;
  if (!origin || !apiBase || !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(origin)) return null;
  const name = text(raw.name, 200) || feishuFileName('', tableId);
  return {
    id,
    name,
    url: text(raw.url, 2000),
    appToken,
    appName: text(raw.appName, 200),
    tableId,
    origin,
    apiBase,
    filePath,
    autoSync: raw.autoSync === true,
    intervalMinutes: normalizeInterval(raw.intervalMinutes),
    createdAt: positiveInt(raw.createdAt),
    lastSyncAt: positiveInt(raw.lastSyncAt),
    lastStatus: normalizeStatus(raw.lastStatus),
    lastError: text(raw.lastError, 500),
    lastRecordCount: positiveInt(raw.lastRecordCount),
  };
}

/**
 * 读取口径：坏 JSON / 缺字段 / 单条数据源损坏都只影响那一条，不让设置页整体报错。
 * 缺省返回空配置（未接入）。
 */
export function parseFeishuBitableConfig(value: unknown): FeishuBitableConfig {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return emptyFeishuConfig();
    try {
      parsed = JSON.parse(value);
    } catch {
      return emptyFeishuConfig();
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyFeishuConfig();
  const raw = parsed as Record<string, unknown>;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map(normalizeSource).filter((item): item is FeishuBitableSource => item !== null)
    : [];
  const oauth = normalizeFeishuOauth(raw.oauth);
  return {
    appId: text(raw.appId, APP_ID_MAX),
    appSecret: text(raw.appSecret, APP_SECRET_MAX),
    apiBase: normalizeFeishuApiBase(raw.apiBase) ?? DEFAULT_FEISHU_API_BASE,
    oauth,
    oauthRequired: raw.oauthRequired === true && !oauth,
    sources,
  };
}

/** OAuth 令牌上限：飞书 access/refresh token 约 1–2KB，预留 4KB 以上 */
const OAUTH_TOKEN_MAX = 8192;

/**
 * 解析 OAuth 绑定：缺 access/refresh 任一项即视为未绑定。
 * 令牌过期不在这里拒绝——刷新逻辑在同步层，过期但可刷新的绑定必须保留。
 */
export function normalizeFeishuOauth(value: unknown): FeishuOauthBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const accessToken = text(raw.accessToken, OAUTH_TOKEN_MAX);
  const refreshToken = text(raw.refreshToken, OAUTH_TOKEN_MAX);
  if (!accessToken || !refreshToken) return null;
  const expiresAt = positiveInt(raw.expiresAt);
  if (!expiresAt) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    refreshExpiresAt: positiveInt(raw.refreshExpiresAt),
    grantedAt: positiveInt(raw.grantedAt),
  };
}

/** app_token（base 直链里的 token）形态校验：搜索选表时客户端直接给 token */
export function isFeishuAppToken(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const token = value.trim();
  // 数据表 / 视图 ID 是 tbl… / vew…，不是 app_token
  return TOKEN_RE.test(token) && !/^(tbl|vew)/i.test(token);
}

/** 文档站点 origin 只接受飞书 / Lark 域名（来源链接展示与拼接用） */
export function normalizeFeishuOrigin(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!openApiBaseFor(url.hostname)) return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** 只接受白名单里的 Open API 基址 */
export function normalizeFeishuApiBase(value: unknown): string | null {
  const candidate = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  return (FEISHU_API_BASES as readonly string[]).includes(candidate) ? candidate : null;
}

/** 自动同步间隔：只接受白名单值（关闭由 autoSync 表示，不在这里） */
export function normalizeFeishuInterval(value: unknown): FeishuSyncIntervalMinutes | null {
  const num = Number(value);
  return (FEISHU_SYNC_INTERVALS as readonly number[]).includes(num)
    ? (num as FeishuSyncIntervalMinutes)
    : null;
}

export function isFeishuTableId(value: unknown): value is string {
  return typeof value === 'string' && TABLE_ID_RE.test(value.trim());
}

/**
 * 写入校验：App ID / Secret 只接受非空字符串（Secret 允许留空表示「沿用已保存的值」）。
 * 返回 null 表示请求不合法，由路由回 400。
 */
export function normalizeFeishuCredentials(input: unknown): { appId: string; appSecret: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.appId !== 'string' || typeof raw.appSecret !== 'string') return null;
  const appId = raw.appId.trim();
  const appSecret = raw.appSecret.trim();
  if (!appId || appId.length > APP_ID_MAX || /[\u0000-\u001f]/.test(appId)) return null;
  if (appSecret.length > APP_SECRET_MAX || /[\u0000-\u001f]/.test(appSecret)) return null;
  return { appId, appSecret };
}

export function serializeFeishuBitableConfig(config: FeishuBitableConfig): string {
  return JSON.stringify({
    appId: config.appId,
    appSecret: config.appSecret,
    apiBase: normalizeFeishuApiBase(config.apiBase) ?? DEFAULT_FEISHU_API_BASE,
    oauth: config.oauth
      ? {
          accessToken: config.oauth.accessToken,
          refreshToken: config.oauth.refreshToken,
          expiresAt: config.oauth.expiresAt,
          refreshExpiresAt: config.oauth.refreshExpiresAt,
          grantedAt: config.oauth.grantedAt,
        }
      : null,
    oauthRequired: Boolean(config.oauthRequired && !config.oauth),
    sources: config.sources.map((source) => ({
      id: source.id,
      name: source.name,
      url: source.url,
      appToken: source.appToken,
      appName: source.appName,
      tableId: source.tableId,
      origin: source.origin,
      apiBase: source.apiBase,
      filePath: source.filePath,
      autoSync: source.autoSync,
      intervalMinutes: source.intervalMinutes,
      createdAt: source.createdAt,
      lastSyncAt: source.lastSyncAt,
      lastStatus: source.lastStatus,
      lastError: source.lastError,
      lastRecordCount: source.lastRecordCount,
    })),
  });
}

/** 前端可见视图：永远不带 appSecret / accessToken / refreshToken */
export function feishuConfigForClient(config: FeishuBitableConfig): FeishuConfigForClient {
  return {
    configured: Boolean(config.appId && config.appSecret),
    appId: config.appId,
    hasSecret: Boolean(config.appSecret),
    apiBase: config.apiBase,
    oauth: {
      bound: Boolean(config.oauth),
      required: Boolean(config.oauthRequired && !config.oauth),
      expiresAt: config.oauth?.expiresAt ?? 0,
      refreshExpiresAt: config.oauth?.refreshExpiresAt ?? 0,
      grantedAt: config.oauth?.grantedAt ?? 0,
    },
    sources: config.sources,
  };
}

/** 新建数据源的默认值（路由里补充解析结果后再落库） */
export function newFeishuSource(input: {
  name: string;
  url: string;
  appToken: string;
  appName: string;
  tableId: string;
  origin: string;
  apiBase: string;
  filePath: string;
}): FeishuBitableSource {
  return {
    id: randomUUID(),
    name: input.name,
    url: input.url,
    appToken: input.appToken,
    appName: input.appName,
    tableId: input.tableId,
    origin: input.origin,
    apiBase: input.apiBase,
    filePath: input.filePath,
    autoSync: false,
    intervalMinutes: 60,
    createdAt: Date.now(),
    lastSyncAt: 0,
    lastStatus: 'never',
    lastError: '',
    lastRecordCount: 0,
  };
}
