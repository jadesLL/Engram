import path from 'node:path';

/**
 * 同步条目的「人话描述」：把一次同步拆成「哪个文件 + 做了什么增量」。
 *
 * 旧日志只有「推送 2 项变更：页面 2 · 872 B」这种汇总——用户看不出动了哪个文件、
 * 改了些什么，等于没有记录。这里统一产出条目摘要（新增/修改/删除/改名 + 行数增量 +
 * 体积变化 + **改动正文采样**），成员端批次、中枢端逐条、本机广播三处共用同一套措辞：
 *  修改页面「会议纪要」（+3 −1 行，1.2 KB → 1.3 KB）
 *  新增文件「原始资料/演示附件.bin」（1.2 MB）
 *
 * 「+3 −1 行」还是回答不了「到底改了什么」：页面条目因此同时给出改动正文采样
 * （`+ 新增的那一行` / `- 被删掉的那一行`，见 diffContent），由 flattenChangeLines
 * 压成日志的 data.changes，抽屉直接列在条目下方。日志是记录不是备份：采样有条数与
 * 字符预算，装不下的只写「还有 N 行改动未记录」。
 *
 * 纯函数、无 IO，方便单测钉住措辞、采样与计数口径。
 */

export type SyncItemKind = 'page' | 'file' | 'delete' | 'move' | 'session' | 'board' | 'preference';
/** add=本端新增；update=覆盖已有；delete=删除；move=改名/移动；same=内容一致 */
export type SyncItemVerb = 'add' | 'update' | 'delete' | 'move' | 'same';

export interface SyncOpSummary {
  kind: SyncItemKind;
  verb: SyncItemVerb;
  /** brain 相对路径（文件条目即文件路径） */
  path: string;
  /** move 的原路径 */
  oldPath?: string;
  /** 页面标题（正文首个 H1，缺失时用文件名） */
  title?: string;
  /** 相对上一次同步版本新增/删除的行数（页面条目） */
  added?: number;
  removed?: number;
  beforeBytes?: number;
  afterBytes?: number;
  /**
   * 改动正文采样：`+ 新增行` / `- 被删行`（页面条目；新增页整页都算 + 行）。
   * 有它，用户才知道「这个文件到底改了什么」，而不只是「改了几行」。
   */
  changes?: string[];
  /** 采样时省略掉的改动行数（0 表示 changes 里已经全了） */
  changesOmitted?: number;
}

/** 字节数转人话（结构化字段里仍保留原始字节数） */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 「+3 −1 行」；只有增或只有删时不写多余的 0 */
export function formatLineDelta(added = 0, removed = 0): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  if (!parts.length) return '内容顺序调整（行数不变）';
  return `${parts.join(' ')} 行`;
}

/** 页面标题：优先正文第一个 H1，其次文件名（用户认标题，不认路径） */
export function pageTitle(relPath: string, raw?: string | null): string {
  const heading = String(raw || '').match(/^\s{0,3}#\s+(.+?)\s*$/m);
  if (heading?.[1]) return heading[1].replace(/[#*`]/g, '').trim().slice(0, 60);
  const base = path.posix.basename(relPath || '').replace(/\.(md|markdown)$/i, '');
  return base || relPath;
}

/**
 * 行级增量计数。
 *
 * 先剪掉公共前后缀（编辑器里绝大多数改动只动中段），再对中段做 LCS；
 * 中段过大（>25 万格）时退回「行多重集」口径——只求给用户一个量级正确的
 * 「改了多少行」，不值得为此把主线程卡住。
 */
export function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
  const diff = diffContent(before, after, 0);
  return { added: diff.added, removed: diff.removed };
}

/** 「这个文件改了什么」采样：一行改动正文最多留多少字符（日志不是 diff 工具） */
export const CHANGE_LINE_MAX = 160;
/** 单个改动块最多采样几行改动（+ / − 行）；超出的计入「还有 N 行改动未记录」 */
export const CHANGE_SAMPLE_LINES = 6;
/** 改动行上下各留几行「未改动」正文当上下文：灰底那几行，用户才看得出改在哪儿 */
export const CHANGE_CONTEXT_LINES = 5;
/** 单个文件最多采样几个改动块（改动散在一篇长文里时只挑最靠前的几处） */
export const CHANGE_MAX_HUNKS = 3;
/** 两个改动块相隔多少行未改动就切成两块；挨得近的合成一块，省行数 */
const CHANGE_HUNK_GAP = CHANGE_CONTEXT_LINES * 2;
/** 一条同步记录最多带几行（含文件路径、上下文与省略提示）：日志 data 的体积预算 */
export const CHANGE_LOG_MAX_LINES = 48;
/** 一条同步记录里改动正文的总字符预算：装不下的只写「还有 N 行改动未记录」 */
export const CHANGE_LOG_MAX_CHARS = 3600;

export interface ContentDiff {
  added: number;
  removed: number;
  /**
   * 采样出来的改动块，逐行形如：
   *   `@@ -18,11 +18,12 @@`  改动块头（原文件/新文件的起始行与行数）
   *   ` 21 上文（未改动）`    上下文行：行号 + 原文，行首一个空格
   *   `-23 被删掉的一行`      删除行：原文件行号
   *   `+23 新增的一行`        新增行：新文件行号
   * 老解析器会把 `@@` 与上下文行当成「文件路径行」显示（灰色一行），不会崩，只是不认得行号。
   */
  lines: string[];
  /** 采样省略掉的改动行数（空行改动也算在内） */
  omitted: number;
}

/** 行级编辑：下标是「剪掉公共前后缀后的中段」下标，格式化时再加全文偏移 */
interface NumberedEdit {
  op: '+' | '-' | '=';
  text: string;
  oldNo: number;
  newNo: number;
}

/** 一行改动正文 → 日志里的一行：去掉首尾空白，过长只留开头 */
function changeLine(op: '+' | '-', lineNo: number, text: string): string {
  const trimmed = text.trim();
  const body = trimmed.length > CHANGE_LINE_MAX ? `${trimmed.slice(0, CHANGE_LINE_MAX)}…` : trimmed;
  return `${op}${lineNo} ${body}`;
}

/** 上下文行：行首一个空格 + 行号，解析端与「文件路径行」区分得开 */
function contextLine(lineNo: number, text: string): string {
  const trimmed = text.trim();
  const body = trimmed.length > CHANGE_LINE_MAX ? `${trimmed.slice(0, CHANGE_LINE_MAX)}…` : trimmed;
  return ` ${lineNo} ${body}`;
}

/**
 * 逐行比对出「带行号的编辑序列」（LCS 回溯），顺序按文件从前到后、同一处先删后增（git diff 口径）。
 * 只在剪掉公共前后缀后的中段上做，中段 ≤ 25 万格才走回溯；再大就退回多重集：
 * 计数仍然准，采样只给「新增的行 / 删掉的行」，不给上下文（几万行的整页重写没有上下文价值）。
 *
 * 与旧实现的区别：相同的行也进序列（op='='），上下文才拿得到；每行带原/新两个行号。
 */
function diffEdits(midA: string[], midB: string[]): NumberedEdit[] {
  if (midA.length * midB.length <= 250_000) {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    // 后缀 LCS 长度表：dp[i * width + j] = a[i..] 与 b[j..] 的最长公共子序列长度
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = i * width;
      const next = row + width;
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[row + j] = midA[i] === midB[j]
          ? dp[next + j + 1] + 1
          : Math.max(dp[next + j], dp[row + j + 1]);
      }
    }
    const edits: NumberedEdit[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { edits.push({ op: '=', text: midA[i], oldNo: i, newNo: j }); i += 1; j += 1; continue; }
      if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { edits.push({ op: '-', text: midA[i], oldNo: i, newNo: j }); i += 1; }
      else { edits.push({ op: '+', text: midB[j], oldNo: i, newNo: j }); j += 1; }
    }
    while (i < n) { edits.push({ op: '-', text: midA[i], oldNo: i, newNo: j }); i += 1; }
    while (j < m) { edits.push({ op: '+', text: midB[j], oldNo: i, newNo: j }); j += 1; }
    return edits;
  }
  // 中段太大（整页重写/超大文件）：多重集口径，只挑「一边有一边没有」的行
  const counts = new Map<string, number>();
  for (const line of midA) counts.set(line, (counts.get(line) || 0) + 1);
  const addedLines: string[] = [];
  for (const line of midB) {
    const left = counts.get(line) || 0;
    if (left > 0) counts.set(line, left - 1);
    else addedLines.push(line);
  }
  const removedLines: string[] = [];
  for (const [line, left] of counts) {
    for (let k = 0; k < left; k += 1) removedLines.push(line);
  }
  return [
    ...removedLines.map((text, index) => ({ op: '-' as const, text, oldNo: index, newNo: 0 })),
    ...addedLines.map((text, index) => ({ op: '+' as const, text, oldNo: 0, newNo: index })),
  ];
}

interface HunkBuild {
  lines: string[];
  omitted: number;
}

/**
 * 编辑序列 → 改动块文本（带上下文）。
 *
 * 相邻改动块之间隔得远（超过 CHANGE_HUNK_GAP 行未改动）就切成两块；每块上下各带
 * CHANGE_CONTEXT_LINES 行未改动正文。空白行不占行数（也不计入「没记下的改动」）；
 * 超出块数 / 行数的改动只计数，最后由调用方写成「还有 N 行改动未记录」。
 * 传入的行号都是「全文行号」（0 基），不再需要偏移。
 */
function buildHunks(edits: NumberedEdit[]): HunkBuild {
  const changedIndexes: number[] = [];
  for (let index = 0; index < edits.length; index += 1) if (edits[index].op !== '=') changedIndexes.push(index);
  if (!changedIndexes.length) return { lines: [], omitted: 0 };

  // 把改动按「相隔多远」分组
  const groups: { from: number; to: number }[] = [];
  let from = changedIndexes[0];
  let to = changedIndexes[0];
  for (const index of changedIndexes.slice(1)) {
    if (index - to > CHANGE_HUNK_GAP) {
      groups.push({ from, to });
      from = index;
    }
    to = index;
  }
  groups.push({ from, to });

  const lines: string[] = [];
  let omitted = 0;
  let emittedChanges = 0;
  let hunks = 0;
  for (const group of groups) {
    if (hunks >= CHANGE_MAX_HUNKS) {
      // 这个块整块不采样：里面的改动行都算「没记下」
      for (let index = group.from; index <= group.to; index += 1) if (edits[index].op !== '=') omitted += 1;
      continue;
    }
    const head = Math.max(0, group.from - CHANGE_CONTEXT_LINES);
    const tail = Math.min(edits.length - 1, group.to + CHANGE_CONTEXT_LINES);
    const slice = edits.slice(head, tail + 1);
    const body: string[] = [];
    let changesInHunk = 0;
    // 块头里的行数按「真正写进 body 的行」算：空行被跳过，不能算进去
    let oldCount = 0;
    let newCount = 0;
    let firstLineNo: { oldNo: number; newNo: number } | null = null;
    for (const edit of slice) {
      if (!edit.text.trim()) continue; // 空行不占预算
      if (!firstLineNo) firstLineNo = { oldNo: edit.oldNo, newNo: edit.newNo };
      if (edit.op === '=') {
        body.push(contextLine(edit.newNo + 1, edit.text));
        oldCount += 1;
        newCount += 1;
        continue;
      }
      if (changesInHunk >= CHANGE_SAMPLE_LINES || emittedChanges >= CHANGE_LOG_MAX_LINES) {
        omitted += 1;
        continue;
      }
      changesInHunk += 1;
      emittedChanges += 1;
      body.push(changeLine(edit.op, (edit.op === '-' ? edit.oldNo : edit.newNo) + 1, edit.text));
      if (edit.op === '-') oldCount += 1;
      else newCount += 1;
    }
    // 一行改动都没留下的块不写（只改了空行、或全局预算已用尽）：光给上下文等于没记录改动
    if (!body.length || !firstLineNo || !changesInHunk) continue;
    lines.push(`@@ -${firstLineNo.oldNo + 1},${oldCount} +${firstLineNo.newNo + 1},${newCount} @@`);
    lines.push(...body);
    hunks += 1;
  }
  return { lines, omitted };
}

/**
 * 内容 → 「改了几行」+「改了哪几行（带上下文）」。
 *
 * before 传 '' 表示整页都是新增（新建页面）；maxLines=0 时只算计数、不采样
 * （lineDiffCounts 走这条路径，回溯与多重集两种口径都只算不改）。
 *
 * 公共前后缀先剪掉再跑 LCS（长文件里改动往往只在中段），但会各自留回最多
 * CHANGE_CONTEXT_LINES 行当上下文——否则「只改了一行」的小改动在界面上没有参照系。
 */
export function diffContent(before: string, after: string, maxLines = CHANGE_SAMPLE_LINES): ContentDiff {
  if (before === after) return { added: 0, removed: 0, lines: [], omitted: 0 };
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);

  const edits: NumberedEdit[] = [];
  // 上文：改动点之前最多 CHANGE_CONTEXT_LINES 行未改动正文
  if (start > 0) {
    for (let index = Math.max(0, start - CHANGE_CONTEXT_LINES); index < start; index += 1) {
      edits.push({ op: '=', text: a[index], oldNo: index, newNo: index });
    }
  }
  if (!midA.length) {
    // 纯新增（末尾追加）：整块都是 + 行
    midB.forEach((text, index) => edits.push({ op: '+', text, oldNo: start + index, newNo: start + index }));
  } else if (!midB.length) {
    // 纯删除：整块都是 − 行
    midA.forEach((text, index) => edits.push({ op: '-', text, oldNo: start + index, newNo: start + index }));
  } else {
    for (const edit of diffEdits(midA, midB)) {
      edits.push({ ...edit, oldNo: start + edit.oldNo, newNo: start + edit.newNo });
    }
  }
  // 下文：改动点之后最多 CHANGE_CONTEXT_LINES 行未改动正文
  const suffixA = endA + 1;
  const suffixB = endB + 1;
  const suffixLen = a.length - suffixA;
  for (let k = 0; k < Math.min(CHANGE_CONTEXT_LINES, suffixLen); k += 1) {
    edits.push({ op: '=', text: a[suffixA + k], oldNo: suffixA + k, newNo: suffixB + k });
  }

  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    if (edit.op === '+') added += 1;
    else if (edit.op === '-') removed += 1;
  }
  const sample = maxLines > 0 ? buildHunks(edits) : { lines: [], omitted: 0 };
  return { added, removed, ...sample };
}

/**
 * 采样用的正文：去掉文件头部的 frontmatter（`---` 包起来的 id / 创建日期 / 标题）。
 *
 * 这几行由应用自己写，不是用户改的内容；更麻烦的是新建页面时它们会把 6 行采样预算吃光，
 * 用户展开看到的全是 `+ id: …`，等于还是没看到「我改了什么」。只认第一行就是 `---` 的块，
 * 正文里以 `---` 开头的内容（分隔线）不会被误吃。
 */
export function stripLeadingFrontmatter(text: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

export function summarizePageChange(target: string, before: string | null, after: string): SyncOpSummary {
  const isNew = before === null;
  const diff = diffContent(isNew ? '' : before, after);
  const verb: SyncItemVerb = isNew ? 'add' : before === after ? 'same' : 'update';
  // 采样只看正文；正文逐字相同（只动了 frontmatter）时回退看整篇，
  // 免得条目写着「+1 行」却一行改动都不显示
  let sample: ContentDiff = { added: 0, removed: 0, lines: [], omitted: 0 };
  if (verb !== 'same') {
    sample = diffContent(isNew ? '' : stripLeadingFrontmatter(before), stripLeadingFrontmatter(after));
    if (!sample.lines.length && !isNew) sample = diff;
  }
  return {
    kind: 'page',
    verb,
    path: target,
    title: pageTitle(target, after),
    // 新建页的行数按非空行计（空行不算用户写了内容），与 describeOpSummary 的口径一致
    added: isNew ? countLines(after) : diff.added,
    removed: isNew ? 0 : diff.removed,
    beforeBytes: isNew ? 0 : Buffer.byteLength(before, 'utf8'),
    afterBytes: Buffer.byteLength(after, 'utf8'),
    changes: verb === 'same' || !sample.lines.length ? undefined : sample.lines,
    changesOmitted: verb === 'same' ? 0 : sample.omitted,
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').filter((line) => line.length > 0).length;
}

export function summarizeFileChange(target: string, beforeBytes: number, afterBytes: number): SyncOpSummary {
  return {
    kind: 'file',
    verb: beforeBytes > 0 ? 'update' : 'add',
    path: target,
    beforeBytes,
    afterBytes,
  };
}

export function summarizeDelete(target: string, beforeBytes: number, isPage: boolean): SyncOpSummary {
  return {
    kind: 'delete',
    verb: 'delete',
    path: target,
    title: isPage ? pageTitle(target) : undefined,
    beforeBytes,
  };
}

export function summarizeMove(oldPath: string, newPath: string): SyncOpSummary {
  return {
    kind: 'move',
    verb: 'move',
    path: newPath,
    oldPath,
    title: pageTitle(newPath),
  };
}

/**
 * 会话同步条目：path 是会话 id（不是 brain 路径），title 供界面显示；
 * added 记本次带上路的消息条数（用「N 条消息」说明这次动了多少）。
 */
export function summarizeSessionChange(sessionId: string, title: string, messages = 0, deleted = false): SyncOpSummary {
  return {
    kind: 'session',
    verb: deleted ? 'delete' : 'update',
    path: sessionId,
    title: title || '',
    added: messages,
  };
}

/** 看板同步条目：全端唯一一份，不分路径 */
export function summarizeBoardChange(): SyncOpSummary {
  return { kind: 'board', verb: 'update', path: 'default', title: '任务看板' };
}

/** 条目的「主体」写法：页面用标题、文件用路径（用户认标题，不认 hash 路径） */
function subjectOf(item: SyncOpSummary): string {
  if (item.kind === 'file') return `文件「${item.path}」`;
  if (item.kind === 'delete' && !item.title) return `文件「${item.path}」`;
  if (item.kind === 'session') return `会话「${item.title || item.path}」`;
  if (item.kind === 'preference') return item.path === 'home_layout' ? '主页卡片' : '设置';
  if (item.kind === 'board') return '任务看板';
  return `页面「${item.title || pageTitle(item.path)}」`;
}

/** 条目 → 一行中文（列表里直接展示，用户不用展开也能看懂） */
export function describeOpSummary(item: SyncOpSummary): string {
  // 会话与看板不在 brain 目录里，措辞也要自成一套（不套用「页面/文件」）
  if (item.kind === 'session') {
    if (item.verb === 'delete') return `删除会话「${item.title || item.path}」`;
    const count = Number(item.added || 0);
    return `同步会话「${item.title || item.path}」${count > 0 ? `（${count} 条消息）` : ''}`;
  }
  if (item.kind === 'preference') return `同步${item.path === 'home_layout' ? '主页卡片' : '设置'}「${item.path}」`;
  if (item.kind === 'board') return '同步任务看板（全端取最新一版）';

  const name = subjectOf(item);
  switch (item.verb) {
    case 'add': {
      if (item.kind === 'file') return `新增文件「${item.path}」（${formatBytes(item.afterBytes)}）`;
      // 新建的空页面没有行增量可写，别硬凑一句「内容顺序调整」
      const delta = Number(item.added || 0) > 0 ? `${formatLineDelta(item.added, 0)}，` : '';
      return `新增${name}（${delta}${formatBytes(item.afterBytes)}）`;
    }
    case 'update':
      if (item.kind === 'file') {
        return `更新文件「${item.path}」（${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}）`;
      }
      return `修改${name}（${formatLineDelta(item.added, item.removed)}，${formatBytes(item.beforeBytes)} → ${formatBytes(item.afterBytes)}）`;
    case 'delete':
      return `删除${name}（删除前 ${formatBytes(item.beforeBytes)}）`;
    case 'move':
      return `改名「${pageTitle(item.oldPath || '')}」→「${pageTitle(item.path)}」（${item.oldPath} → ${item.path}）`;
    default:
      return `${name}内容无变化`;
  }
}

/** 批次 → 半句话列表：「新增页面「A」（+6 行）；修改页面「B」（+2 −1 行）；等 3 项」 */
export function describeOpList(items: SyncOpSummary[], limit = 3): string {
  const visible = items.slice(0, limit).map(describeOpSummary);
  const rest = items.length - visible.length;
  const head = visible.join('；');
  return rest > 0 ? `${head}；等 ${rest} 项` : head;
}

/**
 * 一批条目 → 写进同步日志的改动正文（`data.changes`）。
 *
 * 每个文件先写一行文件路径，再写它的改动块（`@@ 行号 @@` + 上下文行 + `+ / −` 改动行）：
 * 界面据此按「原始资料 / 概念 / 实体 / 内置 Agent」分组，并画出带上下文的行级 diff。
 * 日志有预算：超过条数或字符上限就收尾写「还有 N 行改动未记录」，绝不为了记全改动把日志文件撑爆。
 */
export function flattenChangeLines(ops: SyncOpSummary[]): string[] | undefined {
  const withChanges = ops.filter((op) => op.changes?.length);
  if (!withChanges.length) return undefined;
  const candidates: string[] = [];
  let omittedBySample = 0;
  let lastHeader = '';
  for (const op of withChanges) {
    // 同一批里同一个文件可能有多条（新建后紧接着编辑）：文件路径只写一次
    if (lastHeader !== op.path) {
      candidates.push(op.path);
      lastHeader = op.path;
    }
    candidates.push(...(op.changes as string[]));
    omittedBySample += Number(op.changesOmitted || 0);
  }
  const kept: string[] = [];
  let chars = 0;
  for (const line of candidates) {
    if (kept.length >= CHANGE_LOG_MAX_LINES - 1) break;
    if (chars + line.length > CHANGE_LOG_MAX_CHARS) break;
    kept.push(line);
    chars += line.length + 1;
  }
  // 截断只截在块的边界上：留着孤零零一行 `@@` 头的改动块没法渲染
  while (kept.length && kept[kept.length - 1].startsWith('@@')) kept.pop();
  const omitted = candidates.length - kept.length + omittedBySample;
  if (omitted > 0) {
    if (kept.length >= CHANGE_LOG_MAX_LINES) kept.pop();
    kept.push(`…（还有 ${omitted} 行改动未记录）`);
  }
  return kept.length ? kept : undefined;
}

/**
 * 一批补拉 op 的采样选择。
 *
 * oplog 里同一个页面往往有多个版本（逐版重放），只有**最后一条**相对本端当前正文比较才是
 * 「这一批把文件改成了什么样」；中间版本会把稍后又被加回来的内容显示成删除，用户看了会以为
 * 同步把内容删了。非页面条目（文件/删除/改名）不受此影响，按原顺序保留。
 * AIWorks/ 系统页不进用户记录，直接跳过。
 */
export function pickReplaySamples<T extends { kind?: unknown; target?: unknown }>(ops: T[], limit = 5): T[] {
  const lastPageIndex = new Map<string, number>();
  ops.forEach((op, index) => {
    if (String(op.kind ?? '') === 'page') lastPageIndex.set(String(op.target ?? ''), index);
  });
  const picked: T[] = [];
  for (const [index, op] of ops.entries()) {
    if (picked.length >= limit) break;
    const target = String(op.target ?? '');
    if (target.startsWith('AIWorks/')) continue;
    if (String(op.kind ?? '') === 'page' && lastPageIndex.get(target) !== index) continue;
    picked.push(op);
  }
  return picked;
}

/** 条目是否值得写进同步记录：内部系统页（AIWorks/）不打扰用户，内容没变也不记 */
export function isNoteworthyOp(item: SyncOpSummary | null | undefined): item is SyncOpSummary {
  if (!item) return false;
  if (item.verb === 'same') return false;
  if (item.path.startsWith('AIWorks/')) return false;
  if (item.kind === 'move' && (item.oldPath || '').startsWith('AIWorks/')) return false;
  return true;
}
