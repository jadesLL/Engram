import { db } from '../lib/db.js';
import { readPage, writePage } from '../lib/vault.js';
import { boardCards, isOverdue, parseTaskBoard, taskCardKey, taskCardTarget, type TaskCard } from './taskBoardModel.js';
import { emit } from '../lib/events.js';

const FALLBACK_PATH = 'Wiki/任务看板手动完成记录.md';
const MARKER = /<!-- engram-task-completed:([A-Za-z0-9_-]+) -->/g;

export class TaskCompletionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** 有明确 Markdown 依据就写回该文档；其他来源保留在专门的 Markdown 记录页。 */
function completionPath(card: TaskCard): string {
  const target = taskCardTarget(card);
  if (target.kind === 'file' && /\.(?:md|markdown)$/i.test(target.target)) return target.target;
  if (target.kind === 'page') {
    const rows = db.prepare('SELECT path FROM pages WHERE title = ? AND deleted = 0').all(target.target) as { path: string }[];
    if (rows.length !== 1) throw new TaskCompletionError('依据页面不存在或有同名页面，请先核对原文', 409);
    return rows[0].path;
  }
  return FALLBACK_PATH;
}

function records(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of content.matchAll(MARKER)) {
    try {
      const record = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      if (typeof record.key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date)) result.set(record.key, record.date);
    } catch { /* 损坏的记录不隐藏任务 */ }
  }
  return result;
}

export function completedTaskKeys(answer: string): string[] {
  const paths = new Set<string>([FALLBACK_PATH]);
  for (const card of boardCardsFromAnswer(answer)) {
    try { paths.add(completionPath(card)); } catch { /* 来源失效不影响看板读取 */ }
  }
  const keys = new Set<string>();
  for (const path of paths) {
    try {
      for (const key of records(readPage(path)?.content || '').keys()) keys.add(key);
    } catch { /* 非法或缺失来源留在待办里 */ }
  }
  return [...keys];
}

function boardCardsFromAnswer(answer: string): TaskCard[] {
  return boardCards(parseTaskBoard(answer));
}

function localDay(now: Date, timeZone: unknown): string {
  if (typeof timeZone !== 'string' || timeZone.length > 100) throw new TaskCompletionError('缺少有效的点击时区');
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch { throw new TaskCompletionError('点击时区无效'); }
}

export function completeTask(answer: string, key: unknown, timeZone: unknown, now = new Date()) {
  if (typeof key !== 'string') throw new TaskCompletionError('缺少任务标识');
  const card = boardCardsFromAnswer(answer).find((item) => taskCardKey(item) === key);
  if (!card) throw new TaskCompletionError('看板已更新，请刷新后再完成这条任务', 409);
  const date = localDay(now, timeZone);
  const path = completionPath(card);
  const page = readPage(path);
  if (!page && path !== FALLBACK_PATH) throw new TaskCompletionError('依据文档不存在，未标记完成', 409);
  const content = page?.content || '# 任务看板手动完成记录\n';
  const previous = records(content).get(key);
  if (previous) return { key, date: previous, path };
  if (!isOverdue(card, date)) throw new TaskCompletionError('只有已逾期的任务可以手动完成');
  // 不依赖模型摘要与原文逐字相同；追加独立记录，保留原文和已有 frontmatter。
  const escape = (value: string) => value.replace(/[\\`*_[\]<>]/g, '\\$&').replace(/\s+/g, ' ');
  const meta = [card.owner, card.date ? `原计划：${card.date}` : '', card.source ? `依据：${card.source}` : ''].filter(Boolean).map(escape).join(' / ');
  const marker = Buffer.from(JSON.stringify({ key, date })).toString('base64url');
  const heading = content.includes('\n## 任务手动完成记录') ? '' : '\n\n## 任务手动完成记录';
  writePage(path, `${content.trimEnd()}${heading}\n\n- [x] ${escape(card.text)}${meta ? ` —— ${meta}` : ''}（已手动完成：${date}）\n<!-- engram-task-completed:${marker} -->\n`);
  emit('board-changed', { reason: 'task-completed' });
  return { key, date, path };
}
