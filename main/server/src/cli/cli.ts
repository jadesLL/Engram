#!/usr/bin/env node
/**
 * Engram CLI（engram）——外部 Agent 与脚本操作知识库的命令行入口。
 * 零依赖（Node 22 全局 fetch）；与 MCP 共用同一套 REST API 与 Bearer Token。
 *
 * 运行方式：
 *   宿主机:    node server/dist/cli/cli.js <command>
 *   Docker:    docker exec <容器> node dist/cli/cli.js <command>
 *   桌面端:    ELECTRON_RUN_AS_NODE=1 Engram.exe app.asar/server/dist/cli/cli.js <command>
 *
 * 连接配置优先级：--url/--token 参数 > ENGRAM_URL/ENGRAM_TOKEN 环境变量 > ~/.engram/config.json
 * （本机服务启动时自动登记连接配置，CLI 零配置可用；远程服务用 login 手动登记）
 * 出网统一走 ./net.ts（协议/私网/环回/DNS rebinding 校验，私网目标需 login 显式登记）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { api, buildUrl, httpSend, validateTarget, type SendContext } from './net.js';
import { DEFAULT_RAW_DIR } from '../lib/rawSections.js';

const CONFIG_PATH = path.join(os.homedir(), '.engram', 'config.json');

function loadConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function resolveConnection(args: Record<string, any>): SendContext {
  const file = loadConfig();
  const url = String(args.url || process.env.ENGRAM_URL || file.url || '').replace(/\/+$/, '');
  const token = String(args.token || process.env.ENGRAM_TOKEN || file.token || '');
  if (!url || !token) {
    process.stderr.write(
      '缺少连接配置：用 `engram login --url http://<host>:<port> --token <mcp-token>` 保存，'
      + '或设置 ENGRAM_URL / ENGRAM_TOKEN 环境变量（Token 在 设置 → Agent 接入 生成）。\n'
    );
    process.exit(2);
  }
  const allowPrivate =
    args['allow-private'] === true ||
    process.env.ENGRAM_ALLOW_PRIVATE === '1' ||
    file.allowPrivate === true;
  return { url, token, allowPrivate };
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

/** path::quote 或 path|quote 形式解析证据参数 */
function parseEvidence(items: string[]): Array<{ path: string; quote: string }> {
  return items.map((item) => {
    const sep = item.indexOf('::') >= 0 ? item.indexOf('::') : item.indexOf('|');
    if (sep <= 0) throw new Error(`证据格式无效（应为 "路径::引文"）：${item}`);
    return { path: item.slice(0, sep).trim(), quote: item.slice(sep + 2).trim() };
  });
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

const HELP = `Engram CLI —— 外部 Agent 操作知识库

用法: engram <command> [options]   全局: --json（机器可读输出） --url/--token（临时连接） --allow-private（显式放行私网/环回目标）

命令:
  login   --url http://host:port --token <mcp-token>   保存连接配置到 ~/.engram/config.json
                                                       （私网/环回地址经此显式登记后才放行）
  status                                             服务健康与连接检查
  import <file|dir...> [--dir 原始资料]               上传文件/目录到原始资料（自动提取文本）
  files list [--dir 原始资料] [--pending]              列出原始资料（含提取状态/已提炼标记）；--pending 只列未提炼文件
  files read <path> [--raw] [--out <file>]            读原始资料提取文本；--raw 下载原文件
  search <query>                                      关键词检索知识库
  pages list [--outdated] [--tag t]                    列出知识库页面（含提炼规则版本）；--outdated 只列落后于当前指南的页面（规则升级后重提炼用），--tag 按标签过滤
  pages read <titleOrId>                              读页面全文
  pages write <path> --title <t> [--type concept] [--tags a,b] [--evidence "路径::引文"]...
                                                       写页面（stdin 或 --file 为正文；新建概念/实体页需证据；只能写 Wiki/）
  pages rename <titleOrId> --title <新标题>              重命名页面（移动文件+改标题+重定向引用双链，保持页面 ID）
  pages move <titleOrId> [--dir Wiki/实体] [--title <t>]  移动页面到 Wiki 树内目录（保持页面 ID，可顺带改标题）
  pages delete <titleOrId|路径> [--reason <原因>]         把单个 Wiki/ 页面移入回收站（软删除、可恢复；原始资料/AIWorks 只读不可删）
  pages evidence <titleOrId>                          读页面证据账本
  names check <名称> [--page <titleOrId>] [--note <说明>]  公司全名核验：资料库没有全名时登记，随后在对话里问用户是否允许联网查企查查/天眼查
  names propose <核验id> [--full-name <全名>] [--source <出处>] [--note <说明>]
                                                       回填联网查到的工商全名，再在对话里问用户是否改用全名；查不到就不传 --full-name
  names list [--status pending|open|unresolved|all]    读名称核验清单；unresolved 即「最终不是全名」的条目
  names audit                                          全库公司页名称盘点（标题不是工商全名形态的页面）
  names answer <核验id> --allow|--deny [--note <说明>]   回填用户答复（allow：允许联网查询 / 同意改用全名；同意即由服务端改名）
  chat save [--identifier i] [--project p] [--append] 沉积对话（stdin 为正文）
  guide                                               输出《Agent 作业指南》全文
  mcp-config [--format zcode|codex|claude|kimi|generic]  输出各 Agent 的 MCP 接入配置片段
`;

function mcpConfigSnippet(format: string, ctx: SendContext): string {
  const auth = `Bearer ${ctx.token}`;
  const mcpUrl = `${ctx.url}/mcp`;
  switch (format) {
    case 'zcode':
      return [
        `# ZCode：写入 ~/.zcode/cli/config.json（或用 Engram 设置页一键注册）`,
        JSON.stringify({
          mcp: { servers: { engram: { url: mcpUrl, headers: { Authorization: auth } } } },
        }, null, 2),
      ].join('\n');
    case 'codex':
      return [
        `# Codex CLI：追加到 ~/.codex/config.toml`,
        `[mcp_servers.engram]`,
        `url = "${mcpUrl}"`,
        `http_headers = { "Authorization" = "${auth}" }`,
      ].join('\n');
    case 'claude':
      return [
        `# Claude Code：执行以下命令注册`,
        `claude mcp add --transport http engram "${mcpUrl}" --header "Authorization: ${auth}"`,
      ].join('\n');
    case 'kimi':
      return [
        `# Kimi：写入 MCP 配置（mcpServers 节点，具体文件以所用客户端文档为准）`,
        JSON.stringify({
          mcpServers: { engram: { type: 'http', url: mcpUrl, headers: { Authorization: auth } } },
        }, null, 2),
      ].join('\n');
    default:
      return [
        `# 通用 MCP（streamable HTTP + Bearer）：endpoint = ${mcpUrl}`,
        JSON.stringify({
          mcpServers: { engram: { url: mcpUrl, headers: { Authorization: auth } } },
        }, null, 2),
      ].join('\n');
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      json: { type: 'boolean', default: false },
      'allow-private': { type: 'boolean', default: false },
      dir: { type: 'string' },
      raw: { type: 'boolean', default: false },
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
      format: { type: 'string', default: 'generic' },
    },
  });
  const args = parsed.values as Record<string, any>;
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
      `已保存连接配置: ${CONFIG_PATH}${allowPrivate ? '（私网/环回目标已随本次登记放行）' : ''}`,
      asJson,
    );
    return 0;
  }

  const ctx = resolveConnection(args);

  switch (cmd) {
    case 'status': {
      const base = await validateTarget(ctx.url, true);
      const healthUrl = new URL('/health', `${base.protocol}//${base.host}`);
      const health = await (await httpSend(healthUrl, {}, ctx)).text();
      const files = await api(ctx, 'GET', '/api/files/list');
      const pages = await api(ctx, 'GET', '/api/pages/list');
      output({
        url: ctx.url,
        health,
        rawFiles: files.files?.length ?? 0,
        pages: pages.pages?.length ?? 0,
      }, asJson);
      return 0;
    }
    case 'import': {
      const targets = positional.flatMap((t) => walkFiles(t));
      if (!targets.length) {
        process.stderr.write('没有可导入的文件\n');
        return 2;
      }
      const form = new FormData();
      form.append('dir', args.dir || DEFAULT_RAW_DIR);
      for (const file of targets) {
        const buf = fs.readFileSync(file);
        form.append('file', new Blob([new Uint8Array(buf)]), path.basename(file));
      }
      const result = await api(ctx, 'POST', '/api/files/upload', { form });
      output(result, asJson);
      return 0;
    }
    case 'files': {
      const sub = positional[0];
      if (sub === 'list') {
        const result = await api(ctx, 'GET', '/api/files/list', { query: args.dir ? { dir: String(args.dir) } : {} });
        if (args.pending) result.files = (result.files ?? []).filter((f: any) => !f.distilled);
        output(result, asJson);
        return 0;
      }
      if (sub === 'read') {
        const target = positional[1];
        if (!target) {
          process.stderr.write('用法: files read <path>\n');
          return 2;
        }
        if (args.raw) {
          const url = await buildUrl(ctx, '/api/files/raw', { path: target });
          const res = await httpSend(url, {
            headers: { Authorization: `Bearer ${ctx.token}` },
          }, ctx);
          if (!res.ok) throw new Error(`${res.status} 下载失败`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (args.out) {
            fs.writeFileSync(args.out, buf);
            output(`已写入 ${args.out}`, asJson);
          } else {
            process.stdout.write(buf);
          }
          return 0;
        }
        const result = await api(ctx, 'GET', '/api/files/extraction', { query: { path: target } });
        output(result, asJson);
        return 0;
      }
      process.stderr.write('用法: files list|read\n');
      return 2;
    }
    case 'search': {
      const query = positional.join(' ');
      if (!query) {
        process.stderr.write('用法: search <query>\n');
        return 2;
      }
      const result = await api(ctx, 'GET', '/api/search', { query: { q: query } });
      output(result, asJson);
      return 0;
    }
    case 'pages': {
      const sub = positional[0];
      if (sub === 'list') {
        const query: Record<string, string> = {};
        if (args.outdated) query.outdated = 'true';
        if (args.tag) query.tag = String(args.tag);
        const result = await api(ctx, 'GET', '/api/pages/list', { query });
        output(result, asJson);
        return 0;
      }
      if (sub === 'read' || sub === 'evidence') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write(`用法: pages ${sub} <titleOrId>\n`);
          return 2;
        }
        let id = ref;
        // UUID 是系统生成的（8-4-4-4-12 hex），与真实标题不冲突；纯 hex 长标题仍走 by-title
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
          try {
            const byTitle = await api(ctx, 'GET', `/api/pages/by-title/${encodeURIComponent(ref)}`);
            id = byTitle.id;
          } catch {
            process.stderr.write(`页面不存在: ${ref}\n`);
            return 1;
          }
        }
        if (sub === 'read') {
          output(await api(ctx, 'GET', `/api/pages/${id}`), asJson);
        } else {
          output(await api(ctx, 'GET', `/api/pages/${id}/evidence`), asJson);
        }
        return 0;
      }
      if (sub === 'write') {
        const target = positional[1];
        if (!target || !args.title) {
          process.stderr.write('用法: pages write <path> --title <t>（正文来自 stdin 或 --file）\n');
          return 2;
        }
        const content = args.file ? fs.readFileSync(args.file, 'utf8') : readStdin();
        if (!content.trim()) {
          process.stderr.write('正文为空（stdin 或 --file 提供markdown）\n');
          return 2;
        }
        const body: Record<string, unknown> = { path: target, title: args.title, content };
        if (args.type) body.type = args.type;
        if (args.tags) body.tags = String(args.tags).split(',').map((t: string) => t.trim()).filter(Boolean);
        const evidence = parseEvidence((args.evidence as string[]) || []);
        if (evidence.length) body.evidence = evidence;
        const result = await api(ctx, 'POST', '/api/agent/page', { json: body });
        output(result, asJson);
        return 0;
      }
      if (sub === 'rename') {
        const ref = positional[1];
        if (!ref || !args.title) {
          process.stderr.write('用法: pages rename <titleOrId> --title <新标题>\n');
          return 2;
        }
        const result = await api(ctx, 'POST', '/api/agent/page/rename', {
          json: { titleOrId: ref, newTitle: String(args.title) },
        });
        if (asJson) {
          output(result, true);
        } else {
          output(`已重命名: 「${result.title}」，现在位于 ${result.path}（引用双链已重定向，页面 ID 保持不变）。`, false);
        }
        return 0;
      }
      if (sub === 'move') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages move <titleOrId> [--dir Wiki/实体] [--title <新标题>]\n');
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
            ? `已移动: 「${result.title}」→ ${result.path}（页面 ID 保持不变）。`
            : `位置未变化: ${result.path}`, false);
        }
        return 0;
      }
      if (sub === 'delete') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write('用法: pages delete <titleOrId> [--reason <原因>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { titleOrId: ref };
        if (args.reason) body.reason = String(args.reason);
        const result = await api(ctx, 'POST', '/api/agent/page/delete', { json: body });
        if (asJson) {
          output(result, true);
        } else {
          output(`已移入回收站: ${result.title}（${result.path}，回收站条目 id: ${result.trashId}）——可在 Engram 回收站恢复。`, false);
        }
        return 0;
      }
      process.stderr.write('用法: pages list|read|write|rename|move|delete|evidence\n');
      return 2;
    }
    case 'names': {
      const sub = positional[0];
      if (sub === 'check') {
        const entity = positional[1];
        if (!entity) {
          process.stderr.write('用法: names check <名称> [--page <titleOrId>] [--note <说明>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { entity };
        if (args.page) body.titleOrId = String(args.page);
        if (args.note) body.note = String(args.note);
        const result = await api(ctx, 'POST', '/api/agent/entity-name', { json: body });
        output(asJson ? result : result.text, asJson);
        return 0;
      }
      if (sub === 'propose') {
        const id = positional[1];
        if (!id) {
          process.stderr.write('用法: names propose <核验id> [--full-name <全名>] [--source <出处>] [--note <说明>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { id };
        if (args['full-name']) body.fullName = String(args['full-name']);
        if (args.source) body.source = String(args.source);
        if (args.note) body.note = String(args.note);
        const result = await api(ctx, 'POST', '/api/agent/entity-name/propose', { json: body });
        output(asJson ? result : result.text, asJson);
        return 0;
      }
      if (sub === 'list') {
        const result = await api(ctx, 'GET', '/api/entity-names', {
          query: args.status ? { status: String(args.status) } : {},
        });
        output(asJson ? result : result.text, asJson);
        return 0;
      }
      if (sub === 'audit') {
        const result = await api(ctx, 'GET', '/api/agent/entity-name/audit');
        output(asJson ? result : result.text, asJson);
        return 0;
      }
      if (sub === 'answer') {
        const id = positional[1];
        if (!id || (args.allow === args.deny)) {
          process.stderr.write('用法: names answer <核验id> --allow|--deny [--note <说明>]\n');
          return 2;
        }
        const body: Record<string, unknown> = { decision: args.allow ? 'allow' : 'deny' };
        if (args.note) body.note = String(args.note);
        const result = await api(ctx, 'POST', `/api/entity-names/${encodeURIComponent(id)}/answer`, { json: body });
        output(asJson
          ? result
          : `已答复 #${result.check.id}：「${result.check.entity}」→ `
            + `${result.check.outcome === 'renamed' ? `已改用全名「${result.check.fullName}」`
              : result.check.outcome === 'query_denied' ? '不同意联网查询（标题保持材料写法）'
                : result.check.outcome === 'kept_material' ? '保持材料写法'
                  : result.check.outcome === 'no_full_name' ? '查询未找到全名'
                    : '已同意联网查询，等 Agent 回填结果'}`
            + `（待答复 ${result.pending} 条）`, asJson);
        return 0;
      }
      process.stderr.write('用法: names check|propose|list|audit|answer\n');
      return 2;
    }
    case 'chat': {
      const sub = positional[0];
      if (sub !== 'save') {
        process.stderr.write('用法: chat save [--identifier i] [--project p] [--append]\n');
        return 2;
      }
      const content = args.file ? fs.readFileSync(args.file, 'utf8') : readStdin();
      if (!content.trim()) {
        process.stderr.write('正文为空（stdin 或 --file 提供对话markdown）\n');
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
      output(result, asJson);
      return 0;
    }
    case 'guide': {
      const result = await api(ctx, 'GET', '/api/guide');
      output(result.guide, asJson);
      return 0;
    }
    case 'mcp-config': {
      output(mcpConfigSnippet(String(args.format || 'generic'), ctx), asJson);
      return 0;
    }
    default:
      process.stderr.write(`未知命令: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
