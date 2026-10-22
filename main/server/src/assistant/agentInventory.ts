import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { DATA_DIR } from '../config.js';
import { agentPatchEntryIds, agentPatchPath, writeAgentPatch } from './agentPatch.js';
import { bundledDshBin, bundledDshVersion, bundledSdkClientVersion, getAgentConfig } from './config.js';
import { customRoute, profilePatchPath } from './agentSettings.js';

/**
 * 内置 Agent 的「插件清单 + 设置项」快照。
 *
 * 数据来源是 dsh 自己的 dump（与运行时同一套 profile / patch / DSH_HOME）：
 *  - --dump-config：合成后的 loader entry 列表（id / 插件包 / config / disabled / 来源层）
 *  - --dump-config-schema：每条 entry 的 config JSON Schema（键、类型、默认值、敏感标记）
 *
 * 为什么不让 Engram 手写插件清单：插件集合随 dsh 版本变化，dump 是唯一不会过期的真源；
 * 版本号 dump 不带，用 require.resolve 读随包 node_modules 的 package.json 补。
 *
 * 0.2.1 实测：config dump 约 13KB / 200ms，schema 约 600KB / 2s，所以默认懒加载 + 落盘缓存。
 */

export type PluginLayer = 'engram' | 'dsh-base' | 'dsh-sdk-app' | 'user' | 'unknown';
export type PluginStatus = 'active' | 'disabled' | 'conditional' | 'absent';

export interface InventoryPlugin {
  entryId: string;
  name: string;
  shortName: string;
  version: string | null;
  layer: PluginLayer;
  /** dump 注释里的来源说明（例如 dsh-base, patched by dsh-sdk-app） */
  layerNote: string;
  status: PluginStatus;
  /** 条件禁用时的 !!js 表达式原文 */
  disabled: string | null;
  configKeys: string[];
  /** 已脱敏的生效配置 */
  config: Record<string, unknown> | null;
}

export interface InventorySetting {
  entryId: string;
  plugin: string;
  /** 顶层配置键 */
  path: string;
  type: string;
  required: boolean;
  default: unknown;
  current: unknown;
  source: 'bundle' | 'profile-patch' | 'engram' | 'default';
  secret: boolean;
  volatile: boolean;
  description: string;
}

export interface InventoryRuntime {
  dshVersion: string | null;
  sdkClientVersion: string | null;
  profile: 'sdk';
  bundles: string[];
  home: string;
  profileDir: string;
  patchFile: string;
  /** Engram patch 里的 loader entry id（含 insert 块内的嵌套条目） */
  engramEntries: string[];
}

export interface AgentInventory {
  generatedAt: string;
  stale: boolean;
  runtime: InventoryRuntime;
  plugins: InventoryPlugin[];
  settings: InventorySetting[];
  errors: string[];
}

/* ============================== dump 解析 ============================== */

export interface DumpEntry {
  entryId: string;
  name: string;
  disabledRaw: string | null;
  config: Record<string, unknown> | null;
  layer: PluginLayer;
  layerNote: string;
}

interface YamlLine {
  indent: number;
  text: string;
}

const HEADER_LINE = /^# == (.+)$/;
const ENTRY_LINE = /^- id: (.+)$/;

/** 按 dump 注释判定来源层；"A, patched by B" 归到 A，原文记进 layerNote */
function layerOf(note: string, ownPatch: string | null): { layer: PluginLayer; layerNote: string } {
  const trimmed = note.trim();
  const ownName = ownPatch ? path.basename(ownPatch) : 'engram.cordis.yml';
  if (trimmed.includes(ownName) || /(^|[\\/])engram\.cordis\.yml$/.test(trimmed)) {
    return { layer: 'engram', layerNote: trimmed };
  }
  if (trimmed.startsWith('@deepseek-ai/dsh-base')) return { layer: 'dsh-base', layerNote: trimmed };
  if (trimmed.startsWith('@deepseek-ai/dsh-sdk-app')) return { layer: 'dsh-sdk-app', layerNote: trimmed };
  if (trimmed.includes('dsh-base') || trimmed.includes('dsh-sdk-app')) {
    return { layer: trimmed.includes('dsh-base') ? 'dsh-base' : 'dsh-sdk-app', layerNote: trimmed };
  }
  return { layer: 'user', layerNote: trimmed };
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

function splitKey(text: string): { key: string; rest: string } | null {
  // YAML map 的冒号后必须有空格或行尾；URL 里的 :// 不算分隔符
  const match = /^([A-Za-z0-9_.$-]+):(?:[ \t]+(.*))?$/.exec(text);
  if (!match) return null;
  return { key: match[1], rest: match[2] ?? '' };
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === '' || text === 'null' || text === '~') return null;
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if (/^\[.*\]$/.test(text)) {
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => parseScalar(item));
  }
  return unquote(text);
}

function isBlockMarker(rest: string): boolean {
  return /^[>|][-+]?$/.test(rest.trim());
}

function isJsBlockMarker(rest: string): boolean {
  return /^!!js\s+[>|][-+]?$/.test(rest.trim());
}

function foldBlock(lines: YamlLine[], start: number, indent: number, style: string): { value: string; next: number } {
  const parts: string[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent > indent) {
    parts.push(lines[i].text);
    i++;
  }
  const value = style.startsWith('|') ? parts.join('\n') : parts.join(' ');
  return { value: style.endsWith('-') ? value : value + '\n', next: i };
}

function parseYamlNode(lines: YamlLine[], start: number, indent: number, depth = 0): { value: unknown; next: number } {
  if (depth > 32 || start >= lines.length) return { value: null, next: start };
  if (lines[start].text.startsWith('- ')) return parseYamlList(lines, start, indent, depth);
  return parseYamlMap(lines, start, indent, depth);
}

function parseYamlList(lines: YamlLine[], start: number, indent: number, depth: number): { value: unknown[]; next: number } {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
    const rest = lines[i].text.slice(2).trim();
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseYamlNode(lines, i + 1, lines[i + 1].indent, depth + 1);
        out.push(nested.value);
        i = nested.next;
      } else {
        out.push(null);
        i++;
      }
      continue;
    }
    if (splitKey(rest)) {
      // "- key: value" = 列表项是 map：把本行按 itemIndent 重排后连同后续更深的行一起解析
      const itemIndent = indent + 2;
      const sub: YamlLine[] = [{ indent: itemIndent, text: rest }];
      i++;
      while (i < lines.length && lines[i].indent > indent) {
        sub.push(lines[i]);
        i++;
      }
      out.push(parseYamlMap(sub, 0, itemIndent, depth + 1).value);
      continue;
    }
    out.push(parseScalar(rest));
    i++;
  }
  return { value: out, next: i };
}

function parseYamlMap(
  lines: YamlLine[],
  start: number,
  indent: number,
  depth: number,
): { value: Record<string, unknown>; next: number } {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
    const pair = splitKey(lines[i].text);
    if (!pair) {
      i++;
      continue;
    }
    const { key, rest } = pair;
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseYamlNode(lines, i + 1, lines[i + 1].indent, depth + 1);
        out[key] = nested.value;
        i = nested.next;
      } else {
        out[key] = null;
        i++;
      }
      continue;
    }
    if (isJsBlockMarker(rest)) {
      const folded = foldBlock(lines, i + 1, indent, rest.replace(/^!!js\s+/, ''));
      out[key] = { __js: folded.value.trim() };
      i = folded.next;
      continue;
    }
    if (isBlockMarker(rest)) {
      const folded = foldBlock(lines, i + 1, indent, rest);
      out[key] = folded.value;
      i = folded.next;
      continue;
    }
    if (/^!!js\s+/.test(rest)) {
      out[key] = { __js: unquote(rest.replace(/^!!js\s+/, '')) };
      i++;
      continue;
    }
    out[key] = parseScalar(rest);
    i++;
  }
  return { value: out, next: i };
}

function yamlLines(raw: string[]): YamlLine[] {
  return raw
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trimStart() }))
    .filter((line) => line.text !== '' && !line.text.startsWith('#'));
}

/**
 * 解析 dsh --dump-config 输出（Cordis entry-list YAML）。
 *
 * 只覆盖 dsh 实际会打印的方言：顶层 "- id:" 条目 + 2 空格字段 + block 风格 config
 * （含 !!js 表达式与 block 标量）。不引入 YAML 依赖，也不解析用户手写文件。
 */
export function parseDumpConfig(text: string, ownPatchName = 'engram.cordis.yml'): DumpEntry[] {
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: DumpEntry[] = [];
  let layer: PluginLayer = 'unknown';
  let layerNote = '';
  let current: DumpEntry | null = null;
  let configLines: string[] = [];
  let disabledLines: string[] = [];
  let mode: 'none' | 'config' | 'disabled' = 'none';

  const flush = () => {
    if (!current) return;
    const lines = yamlLines(configLines);
    if (lines.length > 0) {
      const parsed = parseYamlNode(lines, 0, lines[0].indent, 0);
      current.config = parsed.value as Record<string, unknown>;
    } else {
      current.config = null;
    }
    if (disabledLines.length > 0) {
      const blockLines = yamlLines(disabledLines);
      if (blockLines.length > 0) current.disabledRaw = '!!js ' + blockLines.map((line) => line.text).join(' ');
    }
    entries.push(current);
    current = null;
    configLines = [];
    disabledLines = [];
    mode = 'none';
  };

  for (const line of rawLines) {
    const header = HEADER_LINE.exec(line);
    if (header) {
      flush();
      const found = layerOf(header[1], ownPatchName);
      layer = found.layer;
      layerNote = found.layerNote;
      continue;
    }
    const entryMatch = ENTRY_LINE.exec(line);
    if (entryMatch) {
      flush();
      current = {
        entryId: entryMatch[1].trim(),
        name: '',
        disabledRaw: null,
        config: null,
        layer,
        layerNote,
      };
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 2) {
      const pair = splitKey(trimmed);
      mode = 'none';
      if (pair?.key === 'name') current.name = unquote(pair.rest);
      else if (pair?.key === 'disabled') {
        const rest = pair.rest.trim();
        if (/^!!js\s+[>|][-+]?$/.test(rest)) mode = 'disabled';
        else if (/^!!js\s+/.test(rest)) current.disabledRaw = '!!js ' + unquote(rest.replace(/^!!js\s+/, ''));
        else current.disabledRaw = rest;
      } else if (pair?.key === 'config') {
        if (pair.rest.trim() === '') mode = 'config';
        else {
          const parsed = yamlLines(['    ' + trimmed.replace(/^config:\s*/, '')]);
          current.config = parseYamlMap(parsed, 0, 4, 0).value;
        }
      }
      continue;
    }
    if (indent >= 4 && mode === 'config') configLines.push(line);
    else if (indent >= 4 && mode === 'disabled') disabledLines.push(line);
  }
  flush();
  return entries;
}

/** 解析 dsh --dump-config-schema（JSON Schema + x-cordis.entries）为设置项 */
export interface SchemaField {
  path: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  secret: boolean;
  volatile: boolean;
  description: string;
}

function resolveRef(defs: Record<string, any>, value: any, depth = 0): any {
  if (!value || typeof value !== 'object' || depth > 24) return value;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
    return resolveRef(defs, defs[value.$ref.slice('#/$defs/'.length)], depth + 1);
  }
  return value;
}

/** 判断一个已解析的 schema 节点是不是 loaderExpression（!!js 表达式占位） */
function isLoaderExpressionNode(node: any): boolean {
  return Boolean(
    node &&
      typeof node === 'object' &&
      node.properties &&
      typeof node.properties === 'object' &&
      Object.keys(node.properties).length <= 2 &&
      node.properties.__jsExpr,
  );
}

/**
 * 收集所有对象分支（Schemastery 的 union 会展开成多层 anyOf）。
 *
 * 一个插件配置常按"传输方式/凭据来源"分支：只取第一支会漏掉另一支的字段
 * （例如 mcp-client 的 stdio 支与 streamable-http 支），所以这里做并集。
 */
function collectObjectNodes(defs: Record<string, any>, value: any, depth = 0, out: any[] = []): any[] {
  const node = resolveRef(defs, value, depth);
  if (!node || typeof node !== 'object' || depth > 24) return out;
  if (isLoaderExpressionNode(node)) return out;
  if (node.properties || node.type === 'object') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node.anyOf)) {
    for (const branch of node.anyOf) collectObjectNodes(defs, branch, depth + 1, out);
  }
  return out;
}

function underlying(defs: Record<string, any>, value: any, depth = 0): any {
  const node = resolveRef(defs, value, depth);
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node.anyOf)) {
    for (const branch of node.anyOf) {
      const resolved = resolveRef(defs, branch, depth + 1);
      if (!resolved || typeof resolved !== 'object') continue;
      if (isLoaderExpressionNode(resolved)) continue; // loaderExpression：运行时表达式，不当普通值展示
      if (resolved.const !== undefined) return resolved;
      if (resolved.type || resolved.properties || resolved.items) return resolved;
      if (Array.isArray(resolved.anyOf)) {
        const nested = underlying(defs, resolved, depth + 1);
        if (nested) return nested;
      }
    }
  }
  return node;
}

function typeOf(node: any): string {
  if (!node || typeof node !== 'object') return 'unknown';
  if (node.const !== undefined) return 'const';
  if (node.type === 'array') return 'array';
  if (node.type === 'object' || node.properties) return 'object';
  // Schemastery 的标量类型可能是字符串（"string"），也可能是带 null 的联合（["string","null"]）
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) {
    const types = node.type.filter((type: unknown) => type !== 'null');
    return typeof types[0] === 'string' ? types[0] : 'unknown';
  }
  return 'unknown';
}

export function settingsFromSchema(schema: any, entryId: string): SchemaField[] {
  const defs = schema?.$defs ?? {};
  const roster = schema?.['x-cordis']?.entries;
  if (!Array.isArray(roster)) return [];
  const entry = roster.find((row: any) => row?.id === entryId);
  if (!entry || !entry.configRef || entry.configRef === '#/$defs/unknownConfig') return [];
  const def = defs[entry.configRef.slice('#/$defs/'.length)];
  const objectNodes = collectObjectNodes(defs, def);
  if (objectNodes.length === 0) return [];
  const required = new Set<string>();
  for (const node of objectNodes) {
    for (const key of Array.isArray(node.required) ? node.required : []) required.add(String(key));
  }
  const properties = new Map<string, any>();
  for (const node of objectNodes) {
    for (const [key, property] of Object.entries<any>(node.properties ?? {})) {
      if (!properties.has(key)) properties.set(key, property);
    }
  }
  const fields: SchemaField[] = [];
  for (const [key, property] of properties) {
    const node = underlying(defs, property);
    const merged = node && typeof node === 'object' ? { ...property, ...node } : property;
    const x = { ...(node?.['x-cordis'] ?? {}), ...(property?.['x-cordis'] ?? {}) };
    fields.push({
      path: key,
      type: typeOf(node),
      required: required.has(key),
      defaultValue: property?.default !== undefined ? property.default : node?.default,
      secret: x.role === 'credential-ref',
      volatile: x.volatile === true,
      description: typeof merged.description === 'string' ? merged.description : '',
    });
  }
  return fields;
}

/* ============================== 脱敏 / 版本 ============================== */

const SECRET_KEYS = /^(authorization|api_?key|token|secret|password|cookie|access_?token)$/i;
const SECRET_SUFFIX = /(Token|Secret|Password|ApiKey)$/;

export function isSecretKey(key: string): boolean {
  if (/Env$/i.test(key)) return false; // apiKeyEnv 是"环境变量名"引用，不是密钥本身
  return SECRET_KEYS.test(key) || SECRET_SUFFIX.test(key);
}

export const MASK = '••••';

/** 递归脱敏（键名命中敏感词的值整体替换为掩码） */
export function maskSecrets<T>(value: T, keyHint = ''): T {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, keyHint)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? MASK : maskSecrets(item, key);
    }
    return out as T;
  }
  if (keyHint && isSecretKey(keyHint) && typeof value === 'string') return MASK as unknown as T;
  return value;
}

/** dump 原文脱敏：Authorization / token 之类的整行值替换 */
export function maskDumpText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*(?:authorization|api[-_]?key|token|secret|password)\s*:\s*).+$/i, '$1' + MASK))
    .join('\n');
}

export function packageRoot(name: string): string {
  const parts = name.split('/');
  return name.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function shortPluginName(name: string): string {
  return packageRoot(name).replace(/^@[^/]+\//, '').replace(/^dsh-/, '');
}

const requireFromHere = createRequire(import.meta.url);

/** 默认版本解析：读随包 node_modules 的 package.json（读不到返回 null） */
export function resolvePluginVersion(name: string): string | null {
  try {
    const file = requireFromHere.resolve(packageRoot(name) + '/package.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/* ============================== 组装 ============================== */

export interface AssembleInput {
  dumpText: string;
  schema: any | null;
  generatedAt: string;
  runtime: InventoryRuntime;
  engramPatchText: string;
  profilePatchText: string;
  resolveVersion?: (name: string) => string | null;
  errors?: string[];
}

/** 去掉 !!js 表达式外层的引号（只在整个值被引号包住时才剥，避免误伤表达式里的字符串字面量） */
export function stripJsQuotes(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

export function assembleInventory(input: AssembleInput): AgentInventory {
  const resolveVersion = input.resolveVersion ?? resolvePluginVersion;
  const entries = parseDumpConfig(input.dumpText, path.basename(input.runtime.patchFile));
  const engramIds = new Set(agentPatchEntryIds(input.engramPatchText));
  const profileIds = new Set(
    input.profilePatchText
      .split(/\r?\n/)
      .map((line) => /^-\s+id:\s*(\S+)\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => match[1].replace(/^['"]|['"]$/g, '')),
  );

  const plugins: InventoryPlugin[] = entries.map((entry) => {
    const config = entry.config ? (maskSecrets(entry.config) as Record<string, unknown>) : null;
    const disabledRaw = entry.disabledRaw;
    let status: PluginStatus = 'active';
    if (disabledRaw === 'true') status = 'disabled';
    else if (disabledRaw && disabledRaw !== 'false') status = 'conditional';
    // 条件禁用时把 !!js 表达式原文给界面看（'!!js ' 前缀已剥掉）
    const disabledExpr = status === 'conditional' && disabledRaw
      ? stripJsQuotes(disabledRaw.replace(/^!!js\s+/, ''))
      : null;
    return {
      entryId: entry.entryId,
      name: entry.name,
      shortName: shortPluginName(entry.name || entry.entryId),
      version: entry.name ? resolveVersion(entry.name) : null,
      layer: entry.layer,
      layerNote: entry.layerNote,
      status,
      disabled: disabledExpr,
      configKeys: config ? Object.keys(config) : [],
      config,
    };
  });

  const settings: InventorySetting[] = [];
  if (input.schema) {
    for (const plugin of plugins) {
      for (const field of settingsFromSchema(input.schema, plugin.entryId)) {
        const rawCurrent = plugin.config ? plugin.config[field.path] : undefined;
        const source: InventorySetting['source'] = engramIds.has(plugin.entryId)
          ? 'engram'
          : profileIds.has(plugin.entryId)
            ? 'profile-patch'
            : rawCurrent !== undefined
              ? 'bundle'
              : 'default';
        let current: unknown = rawCurrent === undefined ? (field.defaultValue ?? null) : rawCurrent;
        if (current && typeof current === 'object' && '__js' in (current as Record<string, unknown>)) {
          current = '!!js ' + String((current as Record<string, unknown>).__js);
        }
        settings.push({
          entryId: plugin.entryId,
          plugin: plugin.name,
          path: field.path,
          type: field.type,
          required: field.required,
          default: field.defaultValue ?? null,
          current: field.secret ? MASK : current,
          source,
          secret: field.secret || isSecretKey(field.path),
          volatile: field.volatile,
          description: field.description,
        });
      }
    }
  }

  return {
    generatedAt: input.generatedAt,
    stale: false,
    runtime: input.runtime,
    plugins,
    settings,
    errors: input.errors ?? [],
  };
}

/* ============================== 运行 dump / 缓存 ============================== */

const DUMP_TIMEOUT_MS = 15_000;
const SCHEMA_TIMEOUT_MS = 30_000;
const CACHE_DIR = path.join(DATA_DIR, 'agent');
const CACHE_FILE = path.join(CACHE_DIR, 'inventory.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface DumpResult {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: string;
}

function runDsh(
  dshBin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<DumpResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dshBin, ...args], { env, cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: DumpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      finish({ stdout, stderr, code: null, error: 'dump 超时（' + timeoutMs + 'ms）' });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 8_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish({ stdout, stderr, code: null, error: String(error.message || error) }));
    child.on('close', (code) => finish({ stdout, stderr, code }));
  });
}

function readOptional(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readBundles(home: string): string[] {
  try {
    const profile = JSON.parse(readOptional(path.join(home, 'profiles', 'sdk', 'package.json')) || '{}');
    const bundles = profile?.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.length > 0) {
      return bundles.filter((item: unknown): item is string => typeof item === 'string');
    }
  } catch {
    /* 首次运行前还没有 profile 目录 */
  }
  return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'];
}

function inventoryFingerprint(home: string, patchFile: string): string {
  const hash = createHash('sha1');
  hash.update(bundledDshVersion() ?? '');
  hash.update(bundledSdkClientVersion() ?? '');
  hash.update(readOptional(patchFile));
  hash.update(readOptional(profilePatchPath(home)));
  return hash.digest('hex');
}

interface StoredCache {
  fingerprint: string;
  writtenAt: number;
  inventory: AgentInventory;
}

let memoryCache: StoredCache | null = null;
let inFlight: Promise<AgentInventory> | null = null;

function readDiskCache(): StoredCache | null {
  try {
    const parsed = JSON.parse(readOptional(CACHE_FILE) || 'null') as StoredCache | null;
    if (!parsed || typeof parsed.fingerprint !== 'string' || !parsed.inventory) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskCache(entry: StoredCache): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(entry), 'utf8');
  } catch {
    /* 缓存写失败只影响下次首屏速度，不影响功能 */
  }
}

/** 只读缓存（不触发 dump）：状态接口 / 设置页首屏用 */
export function peekInventory(): AgentInventory | null {
  return memoryCache?.inventory ?? readDiskCache()?.inventory ?? null;
}

/** 生成（或复用）内置 Agent 的插件/设置快照 */
export async function getAgentInventory(options: { refresh?: boolean } = {}): Promise<AgentInventory> {
  const config = getAgentConfig();
  const home = path.join(DATA_DIR, 'dsh');
  const patchFile = agentPatchPath(home);
  const fp = inventoryFingerprint(home, patchFile);
  const cached = memoryCache ?? readDiskCache();
  if (!options.refresh && cached && cached.fingerprint === fp && Date.now() - cached.writtenAt < CACHE_MAX_AGE_MS) {
    memoryCache = cached;
    return cached.inventory;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const inventory = await buildAgentInventoryAt({ home, dshBin: config.dshPath || bundledDshBin() });
      const entry: StoredCache = { fingerprint: fp, writtenAt: Date.now(), inventory };
      memoryCache = entry;
      writeDiskCache(entry);
      return inventory;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function buildAgentInventoryAt(input: { home: string; dshBin: string | null }): Promise<AgentInventory> {
  const home = input.home;
  const generatedAt = new Date().toISOString();
  const config = getAgentConfig();
  const route = customRoute(config);
  const { ensureAgentToken } = await import('./repository.js');
  const token = ensureAgentToken();
  const patchFile = writeAgentPatch(home, { token, route });
  const patchText = readOptional(patchFile);
  const profilePatchText = readOptional(profilePatchPath(home));
  const runtime: InventoryRuntime = {
    dshVersion: bundledDshVersion(),
    sdkClientVersion: bundledSdkClientVersion(),
    profile: 'sdk',
    bundles: readBundles(home),
    home,
    profileDir: path.join(home, 'profiles', 'sdk'),
    patchFile,
    engramEntries: agentPatchEntryIds(patchText),
  };

  if (!input.dshBin) {
    return {
      generatedAt,
      stale: true,
      runtime,
      plugins: [],
      settings: [],
      errors: ['未找到随包 dsh 运行时（@deepseek-ai/dsh 依赖缺失）'],
    };
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: home,
    ...(config.apiKey ? (route ? { [route.keyEnv]: config.apiKey } : { DEEPSEEK_API_KEY: config.apiKey }) : {}),
  };
  const baseArgs = ['--profile', 'sdk', '--patch', patchFile];
  const [dump, schemaDump] = await Promise.all([
    runDsh(input.dshBin, [...baseArgs, '--dump-config'], env, home, DUMP_TIMEOUT_MS),
    runDsh(input.dshBin, [...baseArgs, '--dump-config-schema'], env, home, SCHEMA_TIMEOUT_MS),
  ]);

  const errors: string[] = [];
  if (dump.error || dump.code !== 0) {
    errors.push('dump-config 失败：' + (dump.error || dump.stderr.trim() || 'exit ' + dump.code));
  }
  if (schemaDump.error || schemaDump.code !== 0) {
    errors.push('dump-config-schema 失败：' + (schemaDump.error || schemaDump.stderr.trim() || 'exit ' + schemaDump.code));
  }
  let schema: unknown = null;
  if (!schemaDump.error && schemaDump.stdout.trim()) {
    try {
      schema = JSON.parse(schemaDump.stdout);
    } catch (error) {
      errors.push('schema 解析失败：' + (error as Error).message);
    }
  }

  const inventory = assembleInventory({
    dumpText: dump.stdout,
    schema,
    generatedAt,
    runtime,
    engramPatchText: patchText,
    profilePatchText,
    errors,
  });
  inventory.stale = errors.length > 0;
  return inventory;
}

/** 原始 dump 文本（已脱敏；排障与「高级」页用） */
export async function rawInventoryDump(kind: 'config' | 'schema'): Promise<{ text: string; error?: string }> {
  const config = getAgentConfig();
  const home = path.join(DATA_DIR, 'dsh');
  const { ensureAgentToken } = await import('./repository.js');
  const token = ensureAgentToken();
  const patchFile = writeAgentPatch(home, { token, route: customRoute(config) });
  const dshBin = config.dshPath || bundledDshBin();
  if (!dshBin) return { text: '', error: '未找到随包 dsh 运行时' };
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home };
  const result = await runDsh(
    dshBin,
    ['--profile', 'sdk', '--patch', patchFile, kind === 'config' ? '--dump-config' : '--dump-config-schema'],
    env,
    home,
    kind === 'config' ? DUMP_TIMEOUT_MS : SCHEMA_TIMEOUT_MS,
  );
  if (result.error) return { text: '', error: result.error };
  return {
    text: maskDumpText(result.stdout),
    error: result.code === 0 ? undefined : (result.stderr.trim() || kind + ' 退出码 ' + result.code),
  };
}
