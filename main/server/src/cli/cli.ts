#!/usr/bin/env node
/**
 * Engram CLI（engram）——外部 Agent 与脚本操作知识库的命令行入口。
 * 零依赖（Node 22 全局 fetch）；与 MCP 共用同一套 REST API 与 Bearer Token。
 *
 * 运行方式：
 *   宿主机:    node server/dist/cli.js <command>
 *   Docker:    docker exec <容器> node dist/cli.js <command>
 *   桌面端:    ELECTRON_RUN_AS_NODE=1 Engram.exe app.asar/server/dist/cli.js <command>
 *
 * 连接配置优先级：--url/--token 参数 > ENGRAM_URL/ENGRAM_TOKEN 环境变量 > ~/.engram/config.json
 * 出网统一走 ./net.ts（协议/私网/环回/DNS rebinding 校验，私网目标需 login 显式登记）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { api, buildUrl, httpSend, validateTarget, type SendContext } from './net.js';

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
      + '或设置 ENGRAM_URL / ENGRAM_TOKEN 环境变量（Token 在 设置 → MCP 集成 生成）。\n'
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
  files list [--dir 原始资料]                         列出原始资料（含提取状态）
  files read <path> [--raw] [--out <file>]            读原始资料提取文本；--raw 下载原文件
  search <query>                                      关键词检索知识库
  pages list                                          列出知识库页面
  pages read <titleOrId>                              读页面全文
  pages write <path> --title <t> [--type concept] [--tags a,b] [--evidence "路径::引文"]...
                                                       写页面（stdin 或 --file 为正文；新建概念/实体页需证据）
  pages evidence <titleOrId>                          读页面证据账本
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
      append: { type: 'boolean', default: false },
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
      form.append('dir', args.dir || '原始资料');
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
        output(await api(ctx, 'GET', '/api/pages/list'), asJson);
        return 0;
      }
      if (sub === 'read' || sub === 'evidence') {
        const ref = positional[1];
        if (!ref) {
          process.stderr.write(`用法: pages ${sub} <titleOrId>\n`);
          return 2;
        }
        let id = ref;
        if (!/^[a-f0-9]{8,}$/i.test(ref)) {
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
      process.stderr.write('用法: pages list|read|write|evidence\n');
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
