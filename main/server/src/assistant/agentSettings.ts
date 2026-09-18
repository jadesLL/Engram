import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig } from './config.js';

/**
 * 内置 Agent 的自定义模型地址 → dsh 设置文档。
 *
 * dsh 的模型路由来自 `$DSH_HOME/settings.yaml` 这一层用户设置（热加载，也是 dsh 自己的
 * Models 页写的地方）：`llm-pi-ai` 段声明「手工声明的 provider 路由」（baseURL + 线协议 +
 * 模型清单），`agent-default-model` 段指默认路由。dsh 自带的 `deepseek-official` 路由只能
 * 打官方地址，所以自定义地址必须走 llm-pi-ai 路由。
 *
 * 内置 Agent 的 DSH_HOME 在数据目录内（与用户自己的 dsh 隔离），这里按顶层段做文本级
 * 合并：只替换本方维护的两段，其余内容（含用户手写段与注释）逐字保留。与
 * `lib/dshConfig.ts` 维护 MCP patch 块同一思路，不引入 YAML 依赖、不 parse 用户文件。
 */

/** 自定义地址用的 provider 路由 id（固定一条，每次保存整段重写） */
export const CUSTOM_PROVIDER_ID = 'engram-custom';
/** 自定义地址的凭据引用名：dsh 按 apiKeyEnv 解析，跑 Agent 时经该环境变量注入 Key */
export const CUSTOM_KEY_ENV = 'ENGRAM_AGENT_API_KEY';
/** dsh llm-pi-ai 支持的线协议；默认 openai-completions（多数中转站/网关） */
export const AGENT_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type AgentApi = (typeof AGENT_APIS)[number];
export const DEFAULT_AGENT_API: AgentApi = 'openai-completions';

/** 本方维护的顶层段（顺序即写入顺序） */
const SECTION_KEYS = ['llm-pi-ai', 'agent-default-model'] as const;

/** 生成文件头：标明这两段由设置页维护，手写其它段不受影响 */
const HEADER = [
  '# Engram 内置 Agent 的模型地址配置（由 设置 → Agent 接入 → 内置 Agent 维护）。',
  '# 保存设置会整块替换本文件的 llm-pi-ai / agent-default-model 两段；其它段与注释逐字保留。',
];

export interface CustomRoute {
  /** llm-pi-ai 的 provider 路由 id */
  provider: string;
  /** 自定义 API 地址（baseURL） */
  baseUrl: string;
  /** 线协议 */
  api: AgentApi;
  /** 模型 id */
  model: string;
  /** 凭据环境变量名 */
  keyEnv: string;
}

/** 归一化线协议：不认识的取值退回默认（设置页只给三个选项，这里防手改 API） */
export function agentApi(value: string | undefined): AgentApi {
  const api = (value || '').trim();
  return (AGENT_APIS as readonly string[]).includes(api) ? (api as AgentApi) : DEFAULT_AGENT_API;
}

/**
 * 解析自定义地址路由：地址与模型都填了才算启用。
 * 返回 null 表示走 dsh 自带的 `deepseek-official`（官方地址 + DEEPSEEK_API_KEY）。
 */
export function customRoute(config: AgentConfig): CustomRoute | null {
  const baseUrl = (config.baseUrl || '').trim();
  const model = (config.model || '').trim();
  if (!baseUrl || !model) return null;
  return {
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    api: agentApi(config.api),
    model,
    keyEnv: CUSTOM_KEY_ENV,
  };
}

export function agentSettingsPath(home: string): string {
  return path.join(home, 'settings.yaml');
}

interface Section {
  key: string;
  lines: string[];
}

interface SectionRange {
  key: string;
  start: number;
  end: number;
}

/** 顶层键行（列 0 的 `key:`）：缩进行、`- ` 列表项都不算 */
const TOP_LEVEL_KEY = /^([A-Za-z0-9_.-]+):(\s|$)/;

function topLevelKey(line: string): string | null {
  const match = TOP_LEVEL_KEY.exec(line);
  return match ? match[1] : null;
}

function toLines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/);
}

/** 每个顶层段的 [start, end)：end 到下一个顶层键之前 */
function sectionRanges(lines: string[]): SectionRange[] {
  const ranges: SectionRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const key = topLevelKey(lines[i]);
    if (!key) continue;
    let end = i + 1;
    while (end < lines.length && topLevelKey(lines[end]) === null) end++;
    ranges.push({ key, start: i, end });
  }
  return ranges;
}

/** YAML 双引号标量：转义反斜杠/双引号，顺带把换行折成空格，挡掉注入 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

function sectionsFor(route: CustomRoute): Section[] {
  return [
    {
      key: 'llm-pi-ai',
      lines: [
        'llm-pi-ai:',
        '  providers:',
        `    ${route.provider}:`,
        '      displayName: Engram 自定义地址',
        `      apiKeyEnv: ${route.keyEnv}`,
        `      api: ${route.api}`,
        `      baseURL: ${quote(route.baseUrl)}`,
        '      models:',
        `        - id: ${quote(route.model)}`,
      ],
    },
    {
      key: 'agent-default-model',
      lines: [
        'agent-default-model:',
        `  provider: ${route.provider}`,
        `  model: ${quote(route.model)}`,
      ],
    },
  ];
}

/** 替换或追加顶层段；未涉及的段与注释逐字保留 */
export function upsertSections(text: string, sections: Section[]): string {
  let lines = toLines(text);
  for (const section of sections) {
    const range = sectionRanges(lines).find((entry) => entry.key === section.key);
    if (range) {
      lines = [...lines.slice(0, range.start), ...section.lines, ...lines.slice(range.end)];
      continue;
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines = [...lines, ...(lines.length > 0 ? [''] : []), ...section.lines];
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** 删除顶层段（关闭自定义地址时回收本方配置） */
export function removeSections(text: string, keys: readonly string[]): string {
  let lines = toLines(text);
  for (const key of keys) {
    const range = sectionRanges(lines).find((entry) => entry.key === key);
    if (range) lines = [...lines.slice(0, range.start), ...lines.slice(range.end)];
  }
  return lines.join('\n');
}

/** 只剩注释与空行 = 本方文件（可整体删除） */
function onlyComments(text: string): boolean {
  return text.split(/\r?\n/).every((line) => line.trim() === '' || line.trimStart().startsWith('#'));
}

/** 去掉本方文件头（关闭自定义地址时连头一起收干净，不留孤儿注释） */
function stripHeader(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !HEADER.includes(line))
    .join('\n');
}

function writeSettings(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * 把当前配置同步进内置 DSH_HOME 的 settings.yaml：
 * 配了自定义地址就写入/更新本方两段；没配就删掉这两段（文件里只剩本方内容时整体删除）。
 */
export function syncAgentSettings(home: string, config: AgentConfig): void {
  const file = agentSettingsPath(home);
  const route = customRoute(config);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  if (!route) {
    if (!existing) return;
    const stripped = stripHeader(removeSections(existing, SECTION_KEYS));
    const next = `${stripped.replace(/^[\r\n]+/, '').replace(/\n+$/, '')}\n`;
    if (onlyComments(next)) fs.rmSync(file, { force: true });
    else writeSettings(file, next);
    return;
  }

  const header = `${HEADER.join('\n')}\n`;
  const body = existing.includes(HEADER[0]) ? existing : `${header}${existing.trim() ? `${existing.trimEnd()}\n` : ''}`;
  writeSettings(file, upsertSections(body, sectionsFor(route)));
}
