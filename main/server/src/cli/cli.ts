#!/usr/bin/env node
/**
 * Engram CLI（engram）——内置/外置 Agent 操作知识库的唯一命令入口（取代原 MCP /mcp 端点）。
 * 零依赖（Node 22 全局 fetch / FormData）；服务端 REST API + Bearer Agent 令牌。
 *
 * 单文件自包含：本文件不 import 任何相对模块——dist/cli/cli.js 可直接下载成 engram.js
 * 在任意目录 `node engram.js ...` 运行（GET /api/agent/cli 与 /api/settings/agent-cli-source
 * 都按原文下发这份产物）。所以出网校验与格式化辅助都内联在本文件内，改动时勿再引入相对导入。
 *
 * 运行方式：
 *   宿主机:  node server/dist/cli/cli.js <command>
 *   Docker:  docker exec <容器> node dist/cli/cli.js <command>
 *   远程:    从服务端下载 cli.js 后 node engram.js login --url <地址> --token <令牌>
 *   PATH:    ~/.engram/bin/engram(.cmd) 包装脚本由服务端接入流程生成，内置 Agent 直接 engram ...
 *
 * 连接配置优先级：--url/--token 参数 > ENGRAM_URL/ENGRAM_TOKEN 环境变量 > ~/.engram/config.json
 * （本机服务启动时自动登记连接配置，CLI 零配置可用；远程服务用 login 手动登记）
 * 出网统一经 validateTarget 校验（协议/私网/环回/DNS rebinding；私网目标需 login 显式登记）。
 * 退出码：0 成功；2 用法/配置错误；1 服务端拒绝或执行失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * 新资料默认落点：与 server/src/lib/rawSections.ts 的 DEFAULT_RAW_DIR 同值。
 * CLI 需可单文件下载、不能依赖服务端模块，因此本地定义；cli/cli.test.ts 断言两者一致。
 */
export const DEFAULT_RAW_DIR = '原始资料/文档';

/* =======================================================================
 * 出网层（原 cli/net.ts，内联以保证 dist/cli/cli.js 单文件可下载）
 * ======================================================================= */
/**
 * CLI 出网层（唯一出网口）：所有请求先经 validateTarget 再发送。
 * 安全约束：
 *  - 仅允许 http/https；拒绝 URL 内嵌凭据
 *  - 私网/环回/链路本地/保留地址默认阻断；域名按 DNS 实际解析逐地址校验（防 rebinding）
 *  - 重定向手动跟随并复检目标
 *  - allowPrivate=true 仅由用户 `engram login` 显式登记后获得
 *    （CLI 是客户端工具，桌面端 127.0.0.1 / Docker 内网是正常目标）
 */

/** IP 是否属于 私网/环回/链路本地/保留 段 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;               // 环回 / 私网A / 保留
    if (a === 172 && b >= 16 && b <= 31) return true;                // 私网B
    if (a === 192 && b === 168) return true;                         // 私网C
    if (a === 169 && b === 254) return true;                         // 链路本地（含云元数据）
    if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT
    if (a === 192 && ((b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) return true;
    if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;                                       // 组播/保留
    return false;
  }
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  // 仅允许全球单播 2000::/3，也挡住 IPv4 映射、环回、ULA、链路本地、组播与 NAT64。
  if (!/^[23][0-9a-f]{3}:/.test(lower)) return true;
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true; // 文档地址
  if (lower.startsWith('2001:0:') || lower.startsWith('2002:')) return true; // Teredo / 6to4
  return false;
}

export async function validateTarget(rawUrl: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`服务地址无效: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 服务地址: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new Error('服务地址不能携带用户名密码');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'metadata.google.internal' || hostname.startsWith('metadata.')) {
    throw new Error(`目标地址被拒绝（云元数据端点）: ${rawUrl}`);
  }
  if (allowPrivate) return url;
  // 未授权私网：字面量 IP 直接查；域名走 DNS 解析后逐地址查
  const addresses: string[] = [];
  if (net.isIP(hostname)) {
    addresses.push(hostname);
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      addresses.push(...records.map((r) => r.address));
    } catch {
      throw new Error(`服务地址无法解析: ${hostname}`);
    }
  }
  for (const ip of addresses) {
    if (isPrivateAddress(ip)) {
      throw new Error(
        `目标 ${hostname}（${ip}）是私网/环回地址。`
        + '连接本机或内网的 Engram 服务请先执行 `engram login --url <地址> --token <令牌>` 显式登记。'
      );
    }
  }
  return url;
}

export interface SendContext {
  url: string;
  token: string;
  allowPrivate: boolean;
}

/** fetch 网络层失败（DNS/拒绝连接/超时）转成可诊断的错误信息 */
async function rawFetch(url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const cause = (e as any)?.cause?.code ?? (e as any)?.code;
    throw new Error(
      `无法连接 ${url.origin}${cause ? `（${cause}）` : ''}——服务未启动或地址不对。`
      + '本机 Engram 启动后会自动登记连接配置；远程服务请用 `engram login --url <地址> --token <令牌>` 更新。'
    );
  }
}

/** 唯一发送函数：校验通过后才 fetch；重定向手动跟随并复检 */
export async function httpSend(url: URL, init: RequestInit, ctx: SendContext): Promise<Response> {
  await validateTarget(url.toString(), ctx.allowPrivate);
  const res = await rawFetch(url, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (location) {
      const next = await validateTarget(new URL(location, url).toString(), ctx.allowPrivate);
      return rawFetch(next, { ...init, redirect: 'manual' });
    }
  }
  return res;
}

/** 构造带校验的 API 地址 */
export async function buildUrl(ctx: SendContext, pathname: string, query: Record<string, string> = {}): Promise<URL> {
  const base = await validateTarget(ctx.url, true);
  const url = new URL(base.pathname.replace(/\/+$/, '') + pathname, base);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

/** 服务端拒绝（4xx/5xx）时抛出的错误：保留 status 与响应体，供 CLI 给出精确提示与退出码 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** JSON/表单 API 调用（自动带 Bearer） */
export async function api(
  ctx: SendContext,
  method: string,
  pathname: string,
  options: { json?: unknown; form?: FormData; query?: Record<string, string> } = {},
): Promise<any> {
  const url = await buildUrl(ctx, pathname, options.query);
  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.token}` };
  const init: RequestInit = { method, headers };
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.json);
  } else if (options.form) {
    init.body = options.form;
  }
  const res = await httpSend(url, init, ctx);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep raw text */ }
  if (!res.ok) {
    const message = typeof body === 'object' && body?.error ? body.error : `${res.status} ${text.slice(0, 300)}`;
    throw new ApiError(message, res.status, body);
  }
  return body;
}

/* =======================================================================
 * 纯格式化/解析辅助（原 cli/format.ts，内联以保证单文件可下载）
 * ======================================================================= */
/**
 * CLI 的纯格式化/解析辅助（不读网络、不碰进程状态，便于单测）。
 *
 * 内联在 cli.ts 内以保证 dist/cli/cli.js 自包含（远程下载单文件即可运行）；
 * 这些纯函数仍可经 cli.ts 的导出单独单测。
 */

/** 令牌脱敏：保留可辨认的前缀与末 4 位，中间省略（日志/终端截图不泄露凭据） */
export function maskToken(token: string): string {
  const value = String(token || '');
  if (!value) return '（未配置）';
  if (value.length <= 10) return value.slice(0, 2) + '****';
  return value.slice(0, 6) + '…' + value.slice(-4);
}

/** 「路径::引文」或「路径|引文」→ 证据对象；格式非法时抛出可直接展示的错误 */
export function parseEvidenceItems(items: string[]): Array<{ path: string; quote: string }> {
  return items.map((item) => {
    const double = item.indexOf('::');
    const single = item.indexOf('|');
    const sep = double >= 0 ? double : single;
    if (sep <= 0) throw new Error('证据格式无效（应为 "路径::引文"）：' + item);
    const sepLength = double >= 0 ? 2 : 1;
    return { path: item.slice(0, sep).trim(), quote: item.slice(sep + sepLength).trim() };
  });
}

/** 字节数 → 可读大小（与旧 MCP 文本口径一致：一律 KB 取整，不换单位） */
export function formatKb(bytes: number): string {
  return Math.round((Number(bytes) || 0) / 1024) + 'KB';
}

/** MIME → 落盘扩展名（图片/PDF 落临时文件后由 Agent 自己的工具读） */
export function extensionForMime(mime: string): string {
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
  };
  return map[type] || 'bin';
}

/** 路径/URL 的扩展名（小写、不含点）；没有扩展名返回空串 */
export function extensionOf(rel: string): string {
  const clean = String(rel || '').split(/[?#]/)[0];
  const ext = path.posix.extname(clean).slice(1).toLowerCase();
  return ext === '' ? '' : ext;
}

/** 临时文件路径（只生成路径，不创建文件）：engram-<时间戳>-<随机>.<ext> */
export function tempFilePath(ext: string, now = Date.now(), random = Math.random()): string {
  const safeExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const suffix = Math.floor(random * 0xffffff).toString(16).padStart(6, '0');
  return path.join(os.tmpdir(), 'engram-' + now + '-' + suffix + '.' + safeExt);
}

/** 限幅取整数（--limit 等）：非法值回退默认值，超界夹紧 */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/* =======================================================================
 * 命令实现
 * ======================================================================= */
const CONFIG_PATH = path.join(os.homedir(), '.engram', 'config.json');

/** 令牌脱敏后的连接信息（config show 用） */
interface ConnectionView {
  configPath: string;
  url: string;
  token: string;
  allowPrivate: boolean;
  source: string;
  configured: boolean;
  envOverrides: Record<string, string>;
}

function loadConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** 解析连接（参数 > 环境变量 > 配置文件）；缺少必填项时按配置错误退出（2） */
function resolveConnection(args: Record<string, any>): SendContext {
  const file = loadConfig();
  const url = String(args.url || process.env.ENGRAM_URL || file.url || '').replace(/\/+$/, '');
  const token = String(args.token || process.env.ENGRAM_TOKEN || file.token || '');
  if (!url || !token) {
    process.stderr.write(
      '缺少连接配置：用 engram login --url http://<host>:<port> --token <agent-token> 保存，'
      + '或设置 ENGRAM_URL / ENGRAM_TOKEN 环境变量（令牌在 设置 → Agent 接入 生成）。\n',
    );
    process.exit(2);
  }
  const allowPrivate =
    args['allow-private'] === true
    || process.env.ENGRAM_ALLOW_PRIVATE === '1'
    || file.allowPrivate === true;
  return { url, token, allowPrivate };
}

function describeConnection(args: Record<string, any>): ConnectionView {
  const file = loadConfig();
  const url = String(args.url || process.env.ENGRAM_URL || file.url || '').replace(/\/+$/, '');
  const token = String(args.token || process.env.ENGRAM_TOKEN || file.token || '');
  const allowPrivate =
    args['allow-private'] === true
    || process.env.ENGRAM_ALLOW_PRIVATE === '1'
    || file.allowPrivate === true;
  const envOverrides: Record<string, string> = {};
  if (args.url) envOverrides.url = '命令行参数';
  else if (process.env.ENGRAM_URL) envOverrides.url = '环境变量 ENGRAM_URL';
  if (args.token) envOverrides.token = '命令行参数';
  else if (process.env.ENGRAM_TOKEN) envOverrides.token = '环境变量 ENGRAM_TOKEN';
  let source = '未配置';
  if (args.url || args.token || process.env.ENGRAM_URL || process.env.ENGRAM_TOKEN) source = '临时参数 / 环境变量';
  else if (file.source === 'server') source = '服务端自动登记';
  else if (file.url) source = '手动 login';
  return {
    configPath: CONFIG_PATH,
    url,
    token: maskToken(token),
    allowPrivate,
    source,
    configured: Boolean(url && token),
    envOverrides,
  };
}

function output(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  } else if (typeof value === 'string') {
    process.stdout.write(value.endsWith('\n') ? value : value + '\n');
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  }
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** --file F 或 -（标准输入）；未给 --file 时读标准输入 */
function readTextInput(file: string | undefined): string {
  if (!file || file === '-') return readStdin();
  return fs.readFileSync(file, 'utf8');
}

function walkFiles(target: string, out: string[] = []): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    out.push(target);
    return out;
  }
  for (const entry of fs.readdirSync(target)) {
    if (entry.startsWith('.')) continue;
    walkFiles(path.join(target, entry), out);
  }
  return out;
}

/** 二进制下载：成功返回字节与 Content-Type，服务端 JSON 错误原样抛出 */
async function fetchBinary(
  ctx: SendContext,
  pathname: string,
  query: Record<string, string>,
): Promise<{ buffer: Buffer; contentType: string }> {
  const url = await buildUrl(ctx, pathname, query);
  const res = await httpSend(url, { headers: { Authorization: 'Bearer ' + ctx.token } }, ctx);
  if (!res.ok) {
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* 非 JSON 错误体保留原文 */ }
    const message = typeof body === 'object' && body?.error
      ? body.error
      : res.status + ' ' + text.slice(0, 300);
    throw new ApiError(message, res.status, body);
  }
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

/** 把二进制写入目标文件（--out 或临时文件），返回落盘路径 */
function writeBinaryFile(
  buffer: Buffer,
  out: string | undefined,
  mime: string,
  preferredExt = '',
): string {
  const target = out || tempFilePath(preferredExt || extensionForMime(mime));
  fs.writeFileSync(target, buffer);
  return target;
}

/**
 * 页面定位：ref 可以是页面 ID、标题或路径（与 MCP read_page 同口径）。
 * 返回页面 ID；不存在返回 null。
 */
async function resolvePageId(ctx: SendContext, ref: string): Promise<string | null> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuid.test(ref)) return ref;
  try {
    const byTitle = await api(ctx, 'GET', '/api/pages/by-title/' + encodeURIComponent(ref));
    if (byTitle?.id) return String(byTitle.id);
  } catch { /* 继续按路径/ID 查 */ }
  if (ref.includes('/') || /\.md$/i.test(ref)) {
    try {
      const list = await api(ctx, 'GET', '/api/pages/list');
      const hit = (list.pages || []).find((page: any) => page.path === ref);
      if (hit?.id) return String(hit.id);
    } catch { /* 列表失败时退回直接 GET */ }
  }
  try {
    const page = await api(ctx, 'GET', '/api/pages/' + encodeURIComponent(ref));
    if (page?.meta?.id) return String(page.meta.id);
  } catch { /* 不存在 */ }
  return null;
}

const HELP = `Engram CLI —— Agent 操作知识库的唯一命令入口（REST + Agent 令牌，零依赖）

用法: engram <command> [options]
全局选项: --json（机器可读输出） --url/--token（临时连接） --allow-private（显式放行私网/环回目标）
退出码: 0 成功；2 用法/配置错误；1 服务端拒绝或执行失败

连接:
  login --url <url> --token <token>     登记远程连接（本机服务启动时已自动登记 ~/.engram/config.json）
  status                                服务健康 + 连接 + 数量检查
  config show                           显示当前连接（令牌脱敏）

作业手册:
  guide                                 输出《Engram 知识库 Agent 作业指南》全文
  skill list                            列出内置 skill 元数据
  skill show <name>                     读取内置 skill 全文

检索与原始资料:
  search <query> [--limit N]            关键词检索（页面 + 原始资料提取文本）
  import <file|dir...> [--dir D]        上传文件/目录到原始资料（自动提取文本）
  files list [--pending] [--dir D]      列原始资料（含提取状态/已提炼标记）
  files read <path> [--out F]           读提取文本（--out 写入文件）
  files raw <path> [--out F]            下载原文件字节（默认落临时文件并打印路径）
  files add <path> [--file F|-]         新建原始资料 Markdown（正文来自文件/标准输入）

知识库页面:
  pages list [--outdated] [--tag T] [--path P]
                                        目录树（含提炼规则版本；--outdated 只列规则落后页）
  pages read <ref>                      读页面全文
  pages related <ref>                   读图谱关联（相邻页面/实体关系）
  pages evidence <ref>                  读证据账本
  pages write <path> --title T [--type concept] [--tags a,b] [--evidence "路径::引文"]...
                                        写页面（正文来自 stdin 或 --file；只能写 Wiki/）
  pages rename <ref> --title T          重命名（文件+标题+双链重定向，保持页面 ID）
  pages move <ref> [--dir Wiki/实体] [--title T]
                                        移动页面（保持页面 ID）
  pages delete <ref> [--reason R]       移入回收站（软删除、可恢复）
  pages asset <ref> [--out F]           /media/... 图片落文件（默认临时文件）

收集箱（不属于知识库；入库由用户在界面确认）:
  inbox list [--status all|pending|converted|adopted] [--limit N]
  inbox read <path> [--out F]           读原件文字；图片落文件
  inbox raw <path> --out F              下载原件字节
  inbox add <path> [--file F|-]         新建文本原件（待整理）
  inbox write <path> [--file F|-] [--title T] [--note N]
                                        写原件转换产物（仍在收集箱）
  inbox convert <path>                  服务端一键转换（可能数分钟）

公司全名核验（唯一允许问用户的场景）:
  names check <名称> [--page <ref>] [--note N]
  names propose <id> [--full-name F] [--source S] [--note N]
  names list [--status pending|open|unresolved|all]
  names audit
  names answer <id> --allow|--deny [--note N]

客户调研:
  research begin --customer C [--scope knowledge-web|knowledge-only] [--save]
                 [--save-mode new|overwrite] [--overwrite-path P] [--client X] [--timezone TZ]
  research submit --task <taskId> [--file F|-]
                                        提交报告 JSON（identity/sections/sources/save...）

对话与其他:
  chat save [--identifier I] [--project P] [--append] [--file F|-]
  ask --data '<json>' [--file F|-] [--timeout-ms N]
                                        内置 Agent 在对话里问用户并等点选（阻塞长轮询）
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed: { values: Record<string, any>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        json: { type: 'boolean', default: false },
        'allow-private': { type: 'boolean', default: false },
        dir: { type: 'string' },
        out: { type: 'string' },
        title: { type: 'string' },
        type: { type: 'string' },
        tags: { type: 'string' },
        file: { type: 'string' },
        evidence: { type: 'string', multiple: true },
        identifier: { type: 'string' },
        project: { type: 'string' },
        reason: { type: 'string' },
        status: { type: 'string' },
        page: { type: 'string' },
        note: { type: 'string' },
        'full-name': { type: 'string' },
        source: { type: 'string' },
        allow: { type: 'boolean', default: false },
        deny: { type: 'boolean', default: false },
        append: { type: 'boolean', default: false },
        pending: { type: 'boolean', default: false },
        outdated: { type: 'boolean', default: false },
        tag: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'string' },
        customer: { type: 'string' },
        scope: { type: 'string' },
        save: { type: 'boolean', default: false },
        'save-mode': { type: 'string' },
        'overwrite-path': { type: 'string' },
        client: { type: 'string' },
        timezone: { type: 'string' },
        task: { type: 'string' },
        data: { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }) as { values: Record<string, any>; positionals: string[] };
  } catch (error) {
    process.stderr.write('参数错误: ' + (error instanceof Error ? error.message : String(error)) + '\n（engram help 查看用法）\n');
    return 2;
  }
  const args = parsed.values;
  const positional = parsed.positionals;
  const asJson = args.json === true;

  if (cmd === 'login') {
    if (!args.url || !args.token) {
      process.stderr.write('login 需要 --url 与 --token\n');
      return 2;
    }
    let allowPrivate = false;
    try {
      await validateTarget(String(args.url), false);
    } catch {
      // 私网/环回：login 即用户对本机/内网目标的明确授权，登记后放行
      await validateTarget(String(args.url), true);
      allowPrivate = true;
    }
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ url: args.url, token: args.token, allowPrivate }, null, 2));
    output(
      '已保存连接配置: ' + CONFIG_PATH + (allowPrivate ? '（私网/环回目标已随本次登记放行）' : ''),
      asJson,
    );
    return 0;
  }

  if (cmd === 'config') {
    if (positional[0] !== 'show') {
      process.stderr.write('用法: config show\n');
      return 2;
    }
    const view = describeConnection(args);
    if (asJson) {
      output(view, true);
    } else {
      const lines = [
        '连接配置: ' + view.configPath,
        '服务地址: ' + (view.url || '（未配置）'),
        'Agent 令牌: ' + view.token,
        '私网/环回放行: ' + (view.allowPrivate ? '是' : '否'),
        '配置来源: ' + view.source,
      ];
      if (Object.keys(view.envOverrides).length) {
        lines.push('临时覆盖: ' + Object.entries(view.envOverrides).map(([k, v]) => k + '（' + v + '）').join('、'));
      }
      if (!view.configured) lines.push('提示: 用 engram login --url <地址> --token <令牌> 登记连接。');
      output(lines.join('\n'), false);
    }
    return view.configured ? 0 : 2;
  }

  const ctx = resolveConnection(args);

  switch (cmd) {
    case 'status': {
      const base = await validateTarget(ctx.url, true);
      const healthUrl = new URL('/health', base.protocol + '//' + base.host);
      const healthRes = await httpSend(healthUrl, {}, ctx);
      const healthText = (await healthRes.text()).trim();
      let health: unknown = healthText;
      try { health = JSON.parse(healthText); } catch { /* 纯文本 ok */ }
      const files = await api(ctx, 'GET', '/api/files/list', { query: { dir: '原始资料' } });
      const pages = await api(ctx, 'GET', '/api/pages/list');
      const summary = {
        url: ctx.url,
        health,
        rawFiles: files.files?.length ?? 0,
        pages: pages.pages?.length ?? 0,
      };
      if (asJson) {
        output(summary, true);
      } else {
        output([
          '服务: ' + summary.url,
          '健康: ' + (typeof health === 'string' ? health : JSON.stringify(health)),
          '原始资料: ' + summary.rawFiles + ' 个文件',
          '知识库页面: ' + summary.pages + ' 个',
        ].join('\n'), false);
      }
      return 0;
    }
    case 'guide': {
      const result = await api(ctx, 'GET', '/api/guide');
      output(asJson ? result : String(result.guide || ''), asJson);
      return 0;
    }
    case 'skill': {
      const sub = positional[0];
      if (sub === 'list') {
        const result = await api(ctx, 'GET', '/api/agent/skills');
        if (asJson) {
          output(result, true);
        } else {
          const text = (result.skills || []).map((skill: any) => [
            '- ' + skill.name + '（v' + skill.version + '）｜' + skill.title,
            '  用途：' + skill.description,
            '  何时用：' + skill.whenToUse,
          ].join('\n')).join('\n\n');
          output(
            (text || '（没有内置 skill）')
            + '\n\n用 engram skill show <name> 取某份 skill 的全文。'
            + 'skill 版本独立于指南版本，改 skill 不会把已有页面标为规则落后。',
            false,
          );
        }
        return 0;
      }
      if (sub === 'show') {
        const name = positional[1];
        if (!name) {
          process.stderr.write('用法: skill show <name>（先用 skill list 查看可用清单）\n');
          return 2;
        }
        try {
          const skill = await api(ctx, 'GET', '/api/agent/skills/' + encodeURIComponent(name));
          output(
            asJson
              ? skill
              : '# ' + skill.title + '（' + skill.name + ' · v' + skill.version + '）\n\n' + skill.body,
            asJson,
          );
          return 0;
        } catch (error) {
          if (error instanceof ApiError) {
            const available = Array.isArray((error.body as any)?.available)
              ? (error.body as any).available as string[]
              : [];
            process.stderr.write(
              '未找到 skill: ' + name + '\n'
              + (available.length ? '可用：' + available.join('、') + '\n' : ''),
            );
            return 1;
          }
          throw error;
        }
      }
      process.stderr.write('用法: skill list|show <name>\n');
      return 2;
    }
    case 'search': {
      const query = positional.join(' ');
      if (!query) {
        process.stderr.write('用法: search <query> [--limit N]\n');
        return 2;
      }
      const limit = clampInt(args.limit, 8, 1, 30);
      // limit 由服务端夹紧（1-30），这里只做参数规整，不再在结果上截断
      const result = await api(ctx, 'GET', '/api/search', {
        query: { q: query, limit: String(limit) },
      });
      const hits = result.hits || [];
      if (asJson) {
        output({ query, limit, hits }, true);
      } else {
        const text = hits
          .map((hit: any, index: number) => '[' + (index + 1) + '] ' + hit.title + ' (' + hit.refType + ':' + hit.path + ')\n' + hit.snippet)
          .join('\n\n');
        output(text || '（无结果）', false);
      }
      return 0;
    }
    case 'import': {
      const targets = positional.flatMap((target) => walkFiles(target));
      if (!targets.length) {
        process.stderr.write('没有可导入的文件\n');
        return 2;
      }
      const form = new FormData();
      form.append('dir', args.dir || DEFAULT_RAW_DIR);
      for (const file of targets) {
        const buffer = fs.readFileSync(file);
        form.append('file', new Blob([new Uint8Array(buffer)]), path.basename(file));
      }
      const result = await api(ctx, 'POST', '/api/files/upload', { form });
      output(result, asJson);
      return 0;
    }
    case 'files': {
      const sub = positional[0];
      if (sub === 'list') {
        const dir = args.dir ? String(args.dir) : '原始资料';
        const result = await api(ctx, 'GET', '/api/files/list', { query: { dir } });
        let files: any[] = result.files || [];
        if (args.pending) files = files.filter((file) => !file.distilled);
        if (asJson) {
          output({ dir, pending: args.pending === true, files }, true);
        } else {
          const lines = files.map((file) =>
            file.path + ' · ' + file.ext + ' · ' + formatKb(file.size)
            + ' · 提取:' + (file.extractionStatus ?? 'md页面')
            + (file.distilled ? ' · 已提炼' : ''));
          output(
            lines.join('\n') || (args.pending ? '（没有待提炼的文件）' : '（原始资料为空）'),
            false,
          );
        }
        return 0;
      }
      if (sub === 'read') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: files read <path> [--out F]\n');
          return 2;
        }
        const result = await api(ctx, 'GET', '/api/agent/file', { query: { path: target, mode: 'text' } });
        const text = String(result.text || '');
        if (args.out) {
          fs.writeFileSync(String(args.out), text, 'utf8');
          output(
            asJson
              ? { path: target, out: String(args.out), kind: result.kind, chars: text.length }
              : '已写入 ' + String(args.out) + '（' + text.length + ' 字）',
            asJson,
          );
        } else {
          output(asJson ? result : text, asJson);
        }
        return 0;
      }
      if (sub === 'raw') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: files raw <path> [--out F]\n');
          return 2;
        }
        const binary = await fetchBinary(ctx, '/api/agent/file', { path: target, mode: 'raw' });
        const out = writeBinaryFile(binary.buffer, args.out ? String(args.out) : undefined, binary.contentType, extensionOf(target));
        output(
          asJson
            ? { path: out, sourcePath: target, bytes: binary.buffer.length, mimeType: binary.contentType }
            : '已保存原文件: ' + out + '（' + formatKb(binary.buffer.length) + '，' + binary.contentType + '）',
          asJson,
        );
        return 0;
      }
      if (sub === 'add') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: files add <path> [--file F|-]\n');
          return 2;
        }
        const content = readTextInput(args.file);
        if (!content.trim()) {
          process.stderr.write('正文为空（--file 或标准输入提供 Markdown）\n');
          return 2;
        }
        const result = await api(ctx, 'POST', '/api/agent/raw-material', { json: { path: target, content } });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      process.stderr.write('用法: files list|read|raw|add\n');
      return 2;
    }
    case 'pages': {
      const sub = positional[0];
      if (sub === 'list') {
        const query: Record<string, string> = {};
        if (args.outdated) query.outdated = 'true';
        if (args.tag) query.tag = String(args.tag);
        if (args.path) query.path = String(args.path);
        const result = await api(ctx, 'GET', '/api/agent/pages/tree', { query });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      if (sub === 'read') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages read <ref>\n');
          return 2;
        }
        const id = await resolvePageId(ctx, ref);
        if (!id) {
          process.stderr.write('页面不存在: ' + ref + '\n');
          return 1;
        }
        const page = await api(ctx, 'GET', '/api/pages/' + id);
        if (asJson) {
          output(page, true);
        } else {
          const meta = page.meta || {};
          output(
            '# ' + meta.title + '\n路径: ' + meta.path + '\n类型: ' + meta.type
            + '\n标签: ' + (meta.tags || []).join(', ') + '\n\n' + String(page.content || ''),
            false,
          );
        }
        return 0;
      }
      if (sub === 'related') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages related <ref>\n');
          return 2;
        }
        const data = await api(ctx, 'GET', '/api/agent/pages/related', { query: { titleOrId: ref } });
        if (asJson) {
          output(data, true);
        } else if (!(data.neighbors || []).length && !(data.entities || []).length) {
          output('「' + ref + '」暂无图谱关联（无相邻页面与实体关系）', false);
        } else {
          output(JSON.stringify(data, null, 2), false);
        }
        return 0;
      }
      if (sub === 'evidence') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages evidence <ref>\n');
          return 2;
        }
        const id = await resolvePageId(ctx, ref);
        if (!id) {
          process.stderr.write('页面不存在: ' + ref + '\n');
          return 1;
        }
        const evidence = await api(ctx, 'GET', '/api/pages/' + id + '/evidence');
        output(asJson ? evidence : JSON.stringify(evidence, null, 2), asJson);
        return 0;
      }
      if (sub === 'write') {
        const target = positional[1];
        if (!target || !args.title) {
          process.stderr.write('用法: pages write <path> --title <t>（正文来自 stdin 或 --file）\n');
          return 2;
        }
        const content = readTextInput(args.file);
        if (!content.trim()) {
          process.stderr.write('正文为空（stdin 或 --file 提供 markdown）\n');
          return 2;
        }
        const body: Record<string, unknown> = { path: target, title: args.title, content };
        if (args.type) body.type = args.type;
        if (args.tags) body.tags = String(args.tags).split(',').map((tag) => tag.trim()).filter(Boolean);
        const evidence = parseEvidenceItems((args.evidence as string[]) || []);
        if (evidence.length) body.evidence = evidence;
        const result = await api(ctx, 'POST', '/api/agent/page', { json: body });
        if (asJson) {
          output(result, true);
        } else {
          output(
            '已保存: ' + result.meta.path + '（id: ' + result.meta.id + '，'
            + (result.created ? '新建' : '更新') + '，规则版本 v' + result.guideVersion
            + (result.evidenceRecorded ? '，证据 ' + result.evidenceRecorded + ' 条入账' : '') + '）',
            false,
          );
        }
        return 0;
      }
      if (sub === 'rename') {
        const ref = positional[1];
        if (!ref || !args.title) {
          process.stderr.write('用法: pages rename <ref> --title <新标题>\n');
          return 2;
        }
        const result = await api(ctx, 'POST', '/api/agent/page/rename', {
          json: { titleOrId: ref, newTitle: String(args.title) },
        });
        if (asJson) {
          output(result, true);
        } else {
          output('已重命名: 「' + result.title + '」，现在位于 ' + result.path + '（引用双链已重定向，页面 ID 保持不变）。', false);
        }
        return 0;
      }
      if (sub === 'move') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages move <ref> [--dir Wiki/实体] [--title <新标题>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { titleOrId: ref };
        if (args.dir) body.dir = String(args.dir);
        if (args.title) body.newTitle = String(args.title);
        const result = await api(ctx, 'POST', '/api/agent/page/move', { json: body });
        if (asJson) {
          output(result, true);
        } else {
          output(result.moved
            ? '已移动: 「' + result.title + '」→ ' + result.path + '（页面 ID 保持不变）。'
            : '位置未变化: ' + result.path, false);
        }
        return 0;
      }
      if (sub === 'delete') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages delete <ref> [--reason <原因>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { titleOrId: ref };
        if (args.reason) body.reason = String(args.reason);
        const result = await api(ctx, 'POST', '/api/agent/page/delete', { json: body });
        if (asJson) {
          output(result, true);
        } else {
          output('已移入回收站: ' + result.title + '（' + result.path + '，回收站条目 id: ' + result.trashId + '）——可在 Engram 回收站恢复。', false);
        }
        return 0;
      }
      if (sub === 'asset') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages asset <ref> [--out F]（ref 为正文里的 /media/... 引用）\n');
          return 2;
        }
        const binary = await fetchBinary(ctx, '/api/agent/asset', { path: ref });
        const out = writeBinaryFile(binary.buffer, args.out ? String(args.out) : undefined, binary.contentType, extensionOf(ref));
        output(
          asJson
            ? { ref, path: out, mimeType: binary.contentType, bytes: binary.buffer.length }
            : '已保存图片: ' + out + '（' + binary.contentType + '，' + formatKb(binary.buffer.length) + '）\n用你自己的图片读取工具打开这个文件查看。',
          asJson,
        );
        return 0;
      }
      process.stderr.write('用法: pages list|read|related|evidence|write|rename|move|delete|asset\n');
      return 2;
    }
    case 'inbox': {
      const sub = positional[0];
      if (sub === 'list') {
        const status = ['all', 'pending', 'converted', 'adopted'].includes(String(args.status))
          ? String(args.status)
          : 'all';
        const limit = clampInt(args.limit, 200, 1, 500);
        const result = await api(ctx, 'GET', '/api/agent/inbox/items', {
          query: { status, limit: String(limit) },
        });
        if (asJson) {
          output(result, true);
        } else {
          const counts = result.counts || {};
          const lines = (result.items || []).map((item: any) => {
            const state = item.status === 'adopted'
              ? '已入库 → ' + item.adoptedPath
              : item.status === 'converted'
                ? '已转换 → ' + item.derivedPath
                : item.status === 'converting'
                  ? '转换中'
                  : item.status === 'failed'
                    ? '转换失败：' + item.error
                    : '待整理';
            return item.path + ' · ' + (item.ext || '未知') + ' · ' + formatKb(item.size) + ' · ' + state
              + (item.capability === 'agent-only' ? ' · 需 Agent 视觉/转写'
                : item.capability === 'unsupported' ? ' · 暂不支持转换' : '');
          });
          const header = [
            '收集箱共 ' + (counts.all || 0) + ' 项（待整理 ' + (counts.pending || 0)
            + ' · 已转换 ' + (counts.converted || 0) + ' · 已入库 ' + (counts.adopted || 0) + '）。',
            '注意：收集箱内容不在知识库中——不要把它当作事实来源引用，也不要用它去写页面证据。'
            + '标记「已入库」的条目，其产物副本已在 原始资料/ 下成为可引用来源。',
          ].join('\n');
          output(header + '\n\n' + (lines.join('\n') || '（收集箱为空）'), false);
        }
        return 0;
      }
      if (sub === 'read') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: inbox read <path> [--out F]\n');
          return 2;
        }
        const binary = await fetchBinary(ctx, '/api/agent/inbox/item', { path: target, mode: 'text' });
        const contentType = binary.contentType.toLowerCase();
        if (contentType.startsWith('image/')) {
          const out = writeBinaryFile(binary.buffer, args.out ? String(args.out) : undefined, binary.contentType, extensionOf(target));
          output(
            asJson
              ? { kind: 'image', path: out, sourcePath: target, mimeType: binary.contentType, bytes: binary.buffer.length }
              : '已保存图片: ' + out + '（' + binary.contentType + '，' + formatKb(binary.buffer.length) + '）\n用你自己的图片读取工具打开这个文件查看。',
            asJson,
          );
          return 0;
        }
        const text = binary.buffer.toString('utf8');
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* 纯文本响应 */ }
        const markdown = typeof body === 'object' && body?.text ? String(body.text) : text;
        if (args.out) {
          fs.writeFileSync(String(args.out), markdown, 'utf8');
          output(
            asJson
              ? { kind: 'text', path: target, out: String(args.out), chars: markdown.length }
              : '已写入 ' + String(args.out) + '（' + markdown.length + ' 字）',
            asJson,
          );
        } else {
          output(asJson ? body : markdown, asJson);
        }
        return 0;
      }
      if (sub === 'raw') {
        const target = positional[1];
        if (!target || !args.out) {
          process.stderr.write('用法: inbox raw <path> --out F\n');
          return 2;
        }
        const binary = await fetchBinary(ctx, '/api/agent/inbox/item', { path: target, mode: 'raw' });
        fs.writeFileSync(String(args.out), binary.buffer);
        output(
          asJson
            ? { path: String(args.out), sourcePath: target, bytes: binary.buffer.length, mimeType: binary.contentType }
            : '已保存原件: ' + String(args.out) + '（' + formatKb(binary.buffer.length) + '，' + binary.contentType + '）',
          asJson,
        );
        return 0;
      }
      if (sub === 'add') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: inbox add <path> [--file F|-]\n');
          return 2;
        }
        const content = readTextInput(args.file);
        if (!content.trim()) {
          process.stderr.write('正文为空（--file 或标准输入提供文本）\n');
          return 2;
        }
        const result = await api(ctx, 'POST', '/api/agent/inbox/add', { json: { path: target, content } });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      if (sub === 'write') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: inbox write <path> [--file F|-] [--title T] [--note N]\n');
          return 2;
        }
        const markdown = readTextInput(args.file);
        if (!markdown.trim()) {
          process.stderr.write('markdown 为空（--file 或标准输入提供转换产物正文）\n');
          return 2;
        }
        const body: Record<string, unknown> = { path: target, markdown };
        if (args.title) body.title = String(args.title);
        if (args.note) body.note = String(args.note);
        const result = await api(ctx, 'POST', '/api/agent/inbox/write', { json: body });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      if (sub === 'convert') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: inbox convert <path>\n');
          return 2;
        }
        const result = await api(ctx, 'POST', '/api/agent/inbox/convert', { json: { path: target } });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      process.stderr.write('用法: inbox list|read|raw|add|write|convert\n');
      return 2;
    }
    case 'names': {
      const sub = positional[0];
      if (sub === 'check') {
        const entity = positional[1];
        if (!entity) {
          process.stderr.write('用法: names check <名称> [--page <ref>] [--note <说明>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { entity };
        if (args.page) body.titleOrId = String(args.page);
        if (args.note) body.note = String(args.note);
        const result = await api(ctx, 'POST', '/api/agent/entity-name', { json: body });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      if (sub === 'propose') {
        const id = positional[1];
        if (!id) {
          process.stderr.write('用法: names propose <id> [--full-name <全名>] [--source <出处>] [--note <说明>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { id };
        if (args['full-name']) body.fullName = String(args['full-name']);
        if (args.source) body.source = String(args.source);
        if (args.note) body.note = String(args.note);
        const result = await api(ctx, 'POST', '/api/agent/entity-name/propose', { json: body });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      if (sub === 'list') {
        const result = await api(ctx, 'GET', '/api/entity-names', {
          query: args.status ? { status: String(args.status) } : {},
        });
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      if (sub === 'audit') {
        const result = await api(ctx, 'GET', '/api/agent/entity-name/audit');
        output(asJson ? result : String(result.text || ''), asJson);
        return 0;
      }
      if (sub === 'answer') {
        const id = positional[1];
        if (!id || args.allow === args.deny) {
          process.stderr.write('用法: names answer <id> --allow|--deny [--note <说明>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { decision: args.allow ? 'allow' : 'deny' };
        if (args.note) body.note = String(args.note);
        const result = await api(ctx, 'POST', '/api/entity-names/' + encodeURIComponent(id) + '/answer', { json: body });
        if (asJson) {
          output(result, true);
        } else {
          const check = result.check || {};
          const outcome = check.outcome === 'renamed' ? '已改用全名「' + check.fullName + '」'
            : check.outcome === 'query_denied' ? '不同意联网查询（标题保持材料写法）'
              : check.outcome === 'kept_material' ? '保持材料写法'
                : check.outcome === 'no_full_name' ? '查询未找到全名'
                  : '已同意联网查询，等 Agent 回填结果';
          output('已答复 #' + check.id + '：「' + check.entity + '」→ ' + outcome + '（待答复 ' + result.pending + ' 条）', false);
        }
        return 0;
      }
      process.stderr.write('用法: names check|propose|list|audit|answer\n');
      return 2;
    }
    case 'chat': {
      const sub = positional[0];
      if (sub !== 'save') {
        process.stderr.write('用法: chat save [--identifier I] [--project P] [--append] [--file F|-]\n');
        return 2;
      }
      const content = readTextInput(args.file);
      if (!content.trim()) {
        process.stderr.write('正文为空（stdin 或 --file 提供对话 markdown）\n');
        return 2;
      }
      const result = await api(ctx, 'POST', '/api/raw/chat', {
        json: {
          content,
          identifier: args.identifier,
          project: args.project,
          append: args.append === true,
        },
      });
      const meta = result.meta || {};
      output(
        asJson
          ? result
          : '已沉积对话: ' + meta.path + '（id: ' + meta.id + '）' + (meta.appended ? '（追加合并）' : '（新建）'),
        asJson,
      );
      return 0;
    }
    case 'research': {
      const sub = positional[0];
      if (sub === 'begin') {
        const customer = args.customer || positional[1];
        if (!customer) {
          process.stderr.write('用法: research begin --customer <客户名称> [--scope knowledge-web|knowledge-only] [--save] ...\n');
          return 2;
        }
        const body: Record<string, unknown> = { customer };
        if (args.scope) body.scope = String(args.scope);
        if (args.save) body.save = true;
        if (args['save-mode']) body.saveMode = String(args['save-mode']);
        if (args['overwrite-path']) body.overwritePath = String(args['overwrite-path']);
        if (args.client) body.client = String(args.client);
        if (args.timezone) body.timeZone = String(args.timezone);
        const result = await api(ctx, 'POST', '/api/agent/research/begin', { json: body });
        output(asJson ? result : JSON.stringify(result, null, 2), asJson);
        return 0;
      }
      if (sub === 'submit') {
        if (!args.task) {
          process.stderr.write('用法: research submit --task <taskId> [--file F|-]（FILE 为报告 JSON）\n');
          return 2;
        }
        const rawReport = readTextInput(args.file);
        if (!rawReport.trim()) {
          process.stderr.write('报告 JSON 为空（--file 或标准输入提供 identity/sections/sources）\n');
          return 2;
        }
        let report: Record<string, unknown>;
        try {
          const parsedReport = JSON.parse(rawReport);
          if (!parsedReport || typeof parsedReport !== 'object' || Array.isArray(parsedReport)) {
            process.stderr.write('报告 JSON 必须是对象\n');
            return 2;
          }
          report = parsedReport as Record<string, unknown>;
        } catch (error) {
          process.stderr.write('报告 JSON 解析失败: ' + (error instanceof Error ? error.message : String(error)) + '\n');
          return 2;
        }
        const result = await api(ctx, 'POST', '/api/agent/research/submit', {
          json: { ...report, taskId: String(args.task) },
        });
        output(asJson ? result : JSON.stringify(result, null, 2), asJson);
        return 0;
      }
      process.stderr.write('用法: research begin|submit\n');
      return 2;
    }
    case 'ask': {
      let payloadSource = '';
      let rawPayload = '';
      if (args.data !== undefined) {
        rawPayload = String(args.data);
        payloadSource = '--data';
      } else if (args.file) {
        rawPayload = readTextInput(String(args.file));
        payloadSource = args.file === '-' ? 'stdin' : '--file ' + String(args.file);
      } else {
        rawPayload = readStdin();
        payloadSource = 'stdin';
      }
      if (!rawPayload.trim()) {
        process.stderr.write("用法: ask --data '<json>' [--file F|-] [--timeout-ms N]\n");
        return 2;
      }
      let payload: Record<string, any>;
      try {
        const parsedPayload = JSON.parse(rawPayload);
        if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
          process.stderr.write('提问 JSON 必须是对象（{questions:[...],timeoutMs?}）\n');
          return 2;
        }
        payload = parsedPayload as Record<string, any>;
      } catch (error) {
        process.stderr.write('提问 JSON 解析失败: ' + (error instanceof Error ? error.message : String(error)) + '\n');
        return 2;
      }
      const timeoutMs = Number(args['timeout-ms']);
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) payload.timeoutMs = Math.round(timeoutMs);
      const result = await api(ctx, 'POST', '/api/agent/ask', { json: payload });
      if (asJson) {
        output({ ...result, payloadSource }, true);
      } else {
        output(String(result.text || ''), false);
      }
      return result.ok === true ? 0 : 1;
    }
    default:
      process.stderr.write('未知命令: ' + cmd + '\n\n' + HELP);
      return 2;
  }
}

/** 直接执行（node cli.js ...）才跑命令；被测试 import 时不执行 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const current = fileURLToPath(import.meta.url);
    const target = path.resolve(entry);
    return process.platform === 'win32' ? current.toLowerCase() === target.toLowerCase() : current === target;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write('错误: ' + (error instanceof Error ? error.message : String(error)) + '\n');
      process.exit(1);
    },
  );
}
