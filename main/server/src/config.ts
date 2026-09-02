import path from 'node:path';
import fs from 'node:fs';

const cwd = process.cwd();

/** 数据根目录：容器内 /data，开发时为 server/data */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(cwd, 'data'));
/** Markdown 权威源目录（页面 + 附件 + 其他文件都在这里） */
export const BRAIN_DIR = path.join(DATA_DIR, 'brain');
/** 回收站 */
export const TRASH_DIR = path.join(BRAIN_DIR, '.trash');
/** 编辑器粘贴/上传的图片等内联资源 */
export const ASSETS_DIR = path.join(BRAIN_DIR, 'assets');
/** SQLite 数据库文件 */
export const DB_FILE = path.join(DATA_DIR, 'wiki.db');

export const PORT = Number(process.env.PORT || 8080);
export const HOST = process.env.HOST || '0.0.0.0';

/**
 * 会话 Cookie 的 Domain 属性（可选）。配置为父域（如 .example.com）时，
 * 隧道域与直连域两个子域共享登录态——浏览器「一键切直连」免重登的前提。
 * 未配置时为 host-only（默认行为，仅当前域有效）。
 * 注意：该父域下所有子域都会携带此 Cookie，请勿在不可信子域上部署服务。
 */
export const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN || '').trim();

/**
 * HTTPS 直连入口（内置 TLS/ACME）。TLS_DOMAIN 未配置时全部为空，行为与历史版本一致。
 * - TLS_DOMAIN：直连证书域名（如 DDNS 域名），存在即启用 8443 HTTPS 监听
 * - TLS_DNS_API_TOKEN：Cloudflare API token（需 Zone.DNS Edit 权限，写 DNS-01 TXT 记录）
 * - TLS_EMAIL：ACME 账户邮箱（可选）
 * - TLS_ACME_DIRECTORY：ACME directory URL（默认 Let's Encrypt production；测试可切 staging）
 * - TLS_PORT：容器内 HTTPS 监听端口（默认 8443，compose 映射宿主 443）
 */
export const TLS_DOMAIN = (process.env.TLS_DOMAIN || '').trim();
export const TLS_DNS_API_TOKEN = (process.env.TLS_DNS_API_TOKEN || '').trim();
export const TLS_EMAIL = (process.env.TLS_EMAIL || '').trim();
export const TLS_ACME_DIRECTORY = (process.env.TLS_ACME_DIRECTORY || '').trim();
export const TLS_PORT = Number(process.env.TLS_PORT || 8443);
export const OFFICE_EDITOR_ENABLED = process.env.OFFICE_EDITOR_ENABLED !== 'false';
export const OFFICE_INTERNAL_URL = process.env.OFFICE_INTERNAL_URL || 'http://onlyoffice';
export const OFFICE_INTERNAL_APP_URL = process.env.OFFICE_INTERNAL_APP_URL || 'http://engram:8080';
export const OFFICE_PUBLIC_PATH = normalizePublicPath(process.env.OFFICE_PUBLIC_PATH || '/onlyoffice/');
export const OFFICE_INSTANCE_ID = process.env.OFFICE_INSTANCE_ID || 'main';
export const OFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || '';
export const OFFICE_HISTORY_LIMIT = positiveInt(process.env.OFFICE_HISTORY_LIMIT, 20);
export const OFFICE_MAX_FILE_SIZE = positiveInt(
  process.env.OFFICE_MAX_FILE_SIZE,
  200 * 1024 * 1024
);

/** 飞书开放平台自建应用凭证（未配置则长连接不启动；长连接模式由 SDK 封装鉴权，无需签名/加密密钥） */
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
export const FEISHU_API_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';

/**
 * DDNS 直连域名维护（设置页 ddns_config 可配，env 为 Docker/无 GUI 部署的逐字段回退）：
 * - DDNS_TOKEN：Cloudflare API Token（需 Zone.DNS Edit 权限）
 * - DDNS_RECORD：维护的记录 FQDN（如 home.example.com）
 * - DDNS_TYPE：A / AAAA / auto（默认 auto，有全局 IPv6 用 AAAA，否则 A）
 * - DDNS_INTERVAL_MIN：同步间隔分钟数（默认 5）
 */
const DDNS_TYPE_RAW = (process.env.DDNS_TYPE || '').trim().toLowerCase();
export const DDNS_TOKEN = (process.env.DDNS_TOKEN || '').trim();
export const DDNS_RECORD = (process.env.DDNS_RECORD || '').trim();
export const DDNS_TYPE = DDNS_TYPE_RAW === 'a' || DDNS_TYPE_RAW === 'aaaa' ? DDNS_TYPE_RAW : 'auto';
export const DDNS_INTERVAL_MIN = positiveInt(process.env.DDNS_INTERVAL_MIN, 5);

function normalizePublicPath(value: string): string {
  const withLeading = value.startsWith('/') ? value : `/${value}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/** 固定目录结构（用户不可增删文件夹） */
export const FIXED_DIRS = [
  '原始资料',
  '原始资料/对话',
  'Wiki',
  'Wiki/概念',
  'Wiki/实体',
  'Wiki/查询',
  'Wiki/归档',
  'Wiki/关系',
  'AIWorks',
  'AIWorks/index',
  'AIWorks/log',
  'AIWorks/scheme',
] as const;

/** 允许新建/移入页面的目录（Wiki 树内） */
export const PAGE_DIRS = ['Wiki', 'Wiki/概念', 'Wiki/实体', 'Wiki/查询', 'Wiki/归档', 'Wiki/关系'] as const;

/** 允许上传文件的目录（原始资料 + 编辑器资源目录） */
export const UPLOAD_DIRS = ['原始资料', 'assets'] as const;

export function normalizeDir(dir: string): string {
  return dir.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '').split('\\').join('/');
}

export function isPageDir(dir: string): boolean {
  return (PAGE_DIRS as readonly string[]).includes(normalizeDir(dir));
}

export function isUploadDir(dir: string): boolean {
  return (UPLOAD_DIRS as readonly string[]).includes(normalizeDir(dir));
}

/** 页面类型 → 物理目录映射（类型即目录；知识库只分概念/实体两类） */
const TYPE_DIR: Record<string, string> = {
  concept: 'Wiki/概念',
  person: 'Wiki/实体',
  customer: 'Wiki/实体',
  org: 'Wiki/实体',
  place: 'Wiki/实体',
  work: 'Wiki/实体',
  project: 'Wiki/实体',
  other: 'Wiki/实体',
};

export function typeToDir(type: string): string {
  return TYPE_DIR[type] || 'Wiki/概念';
}

export const ARCHIVE_DIR = 'Wiki/归档';
export const QUERY_DIR = 'Wiki/查询';
export const AILOG_DIR = 'AIWorks/log';

export function ensureDirs() {
  for (const dir of [DATA_DIR, BRAIN_DIR, TRASH_DIR, ASSETS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const rel of FIXED_DIRS) {
    fs.mkdirSync(path.join(BRAIN_DIR, rel), { recursive: true });
  }
}
