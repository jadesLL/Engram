// CHANGELOG 解析与渲染：未发布区聚合 → 版本段落 + 安卓累积段。
// CHANGELOG.md 默认在 main 根；实际仓库里它在仓库根（main 的上一级），两处都会查找。
import fs from 'node:fs';
import path from 'node:path';

export const UNRELEASED_HEADING = '## 未发布';
/** 需要写进安卓累积段的平台影响分类（A=服务端+窄代理、C=移动布局/手势、D=原生桥、F=同步数据面）。 */
export const ANDROID_PLATFORMS = ['A', 'C', 'D', 'F'];
/** 平台影响合法取值（PLATFORM-PARALLEL-DEV §4.1）。 */
export const PLATFORM_TOKENS = ['A', 'B', 'C', 'D', 'E', 'F'];

const UNRELEASED_RE = /^## 未发布\s*$/;
const RELEASED_RE = /^## v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[（(](\d{4}-\d{2}-\d{2})[）)]\s*$/;
const SECTION_RE = /^## /;
const H3_RE = /^###\s+(.+?)\s*$/;
const BOLD_RE = /^\*\*(.+?)\*\*\s*$/;
const ENTRY_RE = /^\s*-\s+(.*)$/;
const PLATFORM_RE = /^\[平台影响\s*[:：]\s*([^\]]*)\]\s*(.*)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { eol, lines: text.replace(/\r\n/g, '\n').split('\n') };
}

/** 校验 YYYY-MM-DD 是否为合法日历日期。 */
export function isValidDate(text) {
  const m = DATE_RE.exec(typeof text === 'string' ? text.trim() : '');
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 本地今天的 YYYY-MM-DD（发版日期默认值）。 */
export function todayLocal() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 解析条目正文：可选的 [平台影响: A,F] 标记 + 描述。 */
function parseEntryContent(content) {
  const m = PLATFORM_RE.exec(content);
  if (!m) return { platforms: [], description: content.trim() };
  const platforms = m[1].split(',').map((token) => token.trim()).filter(Boolean);
  return { platforms, description: m[2].trim() };
}

/**
 * 解析某个区段内的条目（以 - 开头的行）。
 * 分类取条目上方最近的 ### 标题或 **粗体** 行；HTML 注释块内的行忽略。
 */
function parseEntries(lines, fromIndex, toIndex) {
  const entries = [];
  let category = '其他';
  let inComment = false;
  for (let i = fromIndex; i <= toIndex; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (inComment) {
      if (trimmed.includes('-->')) inComment = false;
      continue;
    }
    const commentStart = trimmed.indexOf('<!--');
    if (commentStart !== -1) {
      if (trimmed.indexOf('-->', commentStart + 4) === -1) inComment = true;
      continue;
    }
    const h3 = H3_RE.exec(raw);
    if (h3) {
      category = h3[1].trim();
      continue;
    }
    const bold = BOLD_RE.exec(trimmed);
    if (bold) {
      category = bold[1].trim();
      continue;
    }
    const entry = ENTRY_RE.exec(raw);
    if (!entry) continue;
    const { platforms, description } = parseEntryContent(entry[1]);
    entries.push({ line: i + 1, category, raw, platforms, description });
  }
  return entries;
}

/**
 * 解析整份 CHANGELOG。
 * startLine / endLine 都是 1-based 行号且包含端点；rawLines/bodyLines 是对应行数组。
 * @returns {{preambleLines: string[], unreleased: object|null, released: object[], lines: string[], eol: string}}
 */
export function parseChangelog(text) {
  const { eol, lines } = splitLines(text);
  const headers = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (SECTION_RE.test(lines[i])) headers.push(i);
  }
  const preambleLines = lines.slice(0, headers.length > 0 ? headers[0] : lines.length);
  let unreleased = null;
  const released = [];
  for (let h = 0; h < headers.length; h += 1) {
    const startIndex = headers[h];
    const endIndex = h + 1 < headers.length ? headers[h + 1] - 1 : lines.length - 1;
    const headerLine = lines[startIndex];
    const releasedMatch = RELEASED_RE.exec(headerLine);
    if (UNRELEASED_RE.test(headerLine)) {
      if (unreleased) continue;
      unreleased = {
        startLine: startIndex + 1,
        endLine: endIndex + 1,
        rawLines: lines.slice(startIndex, endIndex + 1),
        entries: parseEntries(lines, startIndex + 1, endIndex),
      };
    } else if (releasedMatch) {
      released.push({
        version: releasedMatch[1],
        date: releasedMatch[2],
        startLine: startIndex + 1,
        endLine: endIndex + 1,
        bodyLines: lines.slice(startIndex + 1, endIndex + 1),
        entries: parseEntries(lines, startIndex + 1, endIndex),
      });
    }
  }
  return { preambleLines, unreleased, released, lines, eol };
}

/**
 * 校验未发布区条目格式。
 * @param {Array<{line: number, platforms: string[], description: string}>} entries
 * @returns {{errors: Array<{line: number, message: string}>, warnings: Array<{line: number, message: string}>}}
 */
export function validateEntries(entries) {
  const errors = [];
  const warnings = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const where = `第 ${entry.line} 行`;
    const platforms = Array.isArray(entry.platforms) ? entry.platforms : [];
    if (platforms.length === 0) {
      errors.push({ line: entry.line, message: `${where}：缺少平台影响标记（格式 [平台影响: A|B|C|D|E|F|none]）` });
    } else {
      for (const token of platforms) {
        if (token === 'none' || PLATFORM_TOKENS.includes(token)) continue;
        if (/[\s、/|]/.test(token)) {
          errors.push({ line: entry.line, message: `${where}：多个平台标记必须用英文逗号分隔（当前「${token}」）` });
        } else {
          errors.push({ line: entry.line, message: `${where}：平台标记必须是 A–F 或 none（当前「${token}」）` });
        }
      }
      if (platforms.includes('none') && platforms.length > 1) {
        warnings.push({ line: entry.line, message: `${where}：none 不应与其他平台标记同时出现` });
      }
    }
    if (!entry.description || !String(entry.description).trim()) {
      errors.push({ line: entry.line, message: `${where}：条目描述为空` });
    }
  }
  return { errors, warnings };
}

/** 把条目对象/字符串统一成 "- …" 行。 */
function normalizeEntryLine(entry) {
  if (typeof entry === 'string') return entry.startsWith('- ') ? entry.trimEnd() : `- ${entry.trim()}`;
  if (entry && typeof entry.raw === 'string' && entry.raw.trim()) return entry.raw.trim();
  if (entry && entry.description) return `- ${String(entry.description).trim()}`;
  return null;
}

/**
 * 渲染单个版本段落（不含前后空行控制，返回带 \n 的字符串）。
 * @param {{version: string, date: string, summary?: string|null, groups?: Array<{category: string, entries: Array<object|string>}>, android?: {baseVersion: string, lines: string[]}|null}} input
 */
export function renderVersionSection({ version, date, summary, groups, android }) {
  const versionText = String(version).replace(/^v/, '');
  const out = [`## v${versionText}（${date}）`];
  if (summary) out.push('', `**${String(summary).trim()}**`);
  const groupList = Array.isArray(groups) ? groups.filter(Boolean) : [];
  if (groupList.length === 0) {
    out.push('', '### 其他');
  } else {
    for (const group of groupList) {
      out.push('', `### ${group.category || '其他'}`);
      const items = [];
      for (const entry of group.entries || []) {
        const line = normalizeEntryLine(entry);
        if (line) items.push(line);
      }
      if (items.length > 0) out.push('', ...items);
    }
  }
  if (android) {
    const androidBase = String(android.baseVersion).replace(/^v/, '');
    out.push('', `**安卓端：自 v${androidBase} 以来的累计更新**`, '');
    const androidLines = (android.lines || []).map((line) => (line.startsWith('- ') ? line : `- ${line}`));
    out.push(...(androidLines.length > 0 ? androidLines : ['- 本版本无安卓相关更新（安卓端无需更新）。']));
  }
  return out.join('\n');
}

/**
 * 汇总安卓累积段：baseVersion 之后（含当前未发布区）所有已发布/未发布段落里 A/C/D/F 条目。
 * @param {{text: string, baseVersion: string, currentVersion: string}} input
 * @returns {{baseVersion: string, count: number, versions: string[], lines: string[]}}
 */
export function androidCumulative({ text, baseVersion, currentVersion }) {
  const parsed = parseChangelog(text);
  const base = String(baseVersion).replace(/^v/, '');
  const current = String(currentVersion).replace(/^v/, '');
  const baseIndex = parsed.released.findIndex((section) => section.version === base);
  if (baseIndex < 0) throw new Error(`CHANGELOG 中找不到安卓累积基线 v${base}`);
  const isAndroid = (entry) => (entry.platforms || []).some((platform) => ANDROID_PLATFORMS.includes(platform));
  const buckets = [];
  const unreleasedAndroid = parsed.unreleased ? parsed.unreleased.entries.filter(isAndroid) : [];
  if (unreleasedAndroid.length > 0) buckets.push({ version: current, entries: unreleasedAndroid });
  for (let i = 0; i < baseIndex; i += 1) {
    const section = parsed.released[i];
    const androidEntries = section.entries.filter(isAndroid);
    if (androidEntries.length > 0) buckets.push({ version: section.version, entries: androidEntries });
  }
  const count = buckets.reduce((sum, bucket) => sum + bucket.entries.length, 0);
  if (count === 0) {
    return { baseVersion: base, count: 0, versions: [], lines: ['本版本无安卓相关更新（安卓端无需更新）。'] };
  }
  if (buckets.length === 1 && buckets[0].version === current) {
    return {
      baseVersion: base,
      count,
      versions: [current],
      lines: [`本版本包含自 v${base} 以来全部安卓相关更新（见上）。`],
    };
  }
  const lines = [`本区间（自 v${base} 之后）安卓端累计更新共 ${count} 条：`];
  for (const bucket of buckets) {
    lines.push(`- v${bucket.version}：${bucket.entries.map((entry) => entry.description).join('；')}`);
  }
  return { baseVersion: base, count, versions: buckets.map((bucket) => bucket.version), lines };
}

/** 从「## 未发布」区提取模板注释行（保留缩进）。 */
function extractCommentLines(regionLines) {
  const collected = [];
  let inComment = false;
  for (const line of regionLines) {
    const trimmed = line.trim();
    if (inComment) {
      collected.push(line);
      if (trimmed.includes('-->')) inComment = false;
      continue;
    }
    const start = trimmed.indexOf('<!--');
    if (start === -1) continue;
    collected.push(line);
    if (trimmed.indexOf('-->', start + 4) === -1) inComment = true;
  }
  return collected;
}

/**
 * 把未发布区渲染成新版本段落，并清空未发布区（保留标题 + 模板注释）。
 * @param {{text: string, version: string, date: string, summary?: string|null, androidBase?: string|null}} input
 * @returns {{text: string, section: string, movedEntries: object[], android: object|null}}
 */
export function renderChangelog({ text, version, date, summary, androidBase }) {
  const versionText = String(version).replace(/^v/, '');
  const parsed = parseChangelog(text);
  if (parsed.released.some((section) => section.version === versionText)) {
    throw new Error(`CHANGELOG 已存在 v${versionText} 版本段落（重复 render？先回退 CHANGELOG.md）`);
  }
  if (!parsed.unreleased) throw new Error('CHANGELOG 缺少「## 未发布」区，无法生成版本段落');
  const entries = parsed.unreleased.entries;
  if (entries.length === 0) throw new Error('「## 未发布」区没有条目，无法生成版本段落（纯维护版本可手写段落）');
  const { errors } = validateEntries(entries);
  if (errors.length > 0) {
    throw new Error(`未发布区条目格式有误：\n${errors.map((error) => `  - ${error.message}`).join('\n')}`);
  }

  const groups = [];
  for (const entry of entries) {
    let group = groups.find((item) => item.category === entry.category);
    if (!group) {
      group = { category: entry.category, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }

  const baseVersion = androidBase ? String(androidBase).replace(/^v/, '') : parsed.released.length > 0 ? parsed.released[0].version : null;
  const android = baseVersion ? androidCumulative({ text, baseVersion, currentVersion: versionText }) : null;
  const section = renderVersionSection({ version: versionText, date, summary, groups, android });

  const prefix = parsed.lines.slice(0, parsed.unreleased.startLine - 1);
  const region = parsed.lines.slice(parsed.unreleased.startLine - 1, parsed.unreleased.endLine);
  const tail = parsed.lines.slice(parsed.unreleased.endLine);
  const comments = extractCommentLines(region);
  const block = [UNRELEASED_HEADING, ''];
  if (comments.length > 0) block.push(...comments, '');
  block.push(...section.split('\n'), '');
  const nextLines = [...prefix, ...block, ...tail];
  return { text: nextLines.join(parsed.eol), section, movedEntries: entries, android };
}

/** 取某个已发布版本的正文（不含标题行）；不存在返回 null。 */
export function extractVersionBody(text, version) {
  const versionText = String(version).replace(/^v/, '');
  const parsed = parseChangelog(text);
  const section = parsed.released.find((item) => item.version === versionText);
  if (!section) return null;
  return section.bodyLines.join(parsed.eol);
}

/**
 * 定位 CHANGELOG.md：先 main 根，再 main 的上一级（仓库根）。找不到返回 null。
 * @param {string} repoDir
 */
export function resolveChangelogPath(repoDir) {
  const candidates = [path.join(repoDir, 'CHANGELOG.md'), path.join(path.resolve(repoDir, '..'), 'CHANGELOG.md')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 读 CHANGELOG；找不到时抛出带查找路径的明确错误。 */
export function readChangelog(repoDir) {
  const filePath = resolveChangelogPath(repoDir);
  if (!filePath) {
    const candidates = [path.join(repoDir, 'CHANGELOG.md'), path.join(path.resolve(repoDir, '..'), 'CHANGELOG.md')];
    throw new Error(`找不到 CHANGELOG.md（已查找：${candidates.join('、')}）`);
  }
  return { path: filePath, text: fs.readFileSync(filePath, 'utf8') };
}
