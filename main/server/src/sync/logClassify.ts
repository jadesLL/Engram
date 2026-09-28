/**
 * 同步日志的「人话分类」：把一堆英文事件名收成用户看得懂的两层标签。
 *
 * 旧界面按 level（信息 / 警告 / 错误）与 scope（中枢 / 成员 / 配置）筛，用户反馈看不懂，
 * 真正想知道的是两件事：
 *   ① 这条记录到底干了什么——**有改动**（同步成功且内容真的变了）/ **没改动**（对账、检查、
 *      连接这类跑完两边一致）/ **失败**（警告与错误，含自动重试、已自愈的降级）；
 *   ② 有改动的那些，动的是哪类内容——**原始资料 / 概念 / 实体 / 内置 Agent / 其他**。
 *
 * 分类只依赖日志里已存的 event / level / data（paths、path、kinds 都是现成字段），
 * 不改落盘格式：查询与统计时现算，历史记录同样能分对。
 *
 * 纯函数、无 IO，方便单测钉住口径。
 */

export type SyncLogOutcome = 'changed' | 'none' | 'failed';

/** 内容类型：与知识库目录一一对应，用户认这四个字，不认 `Wiki/概念/` */
export type SyncLogContent = '原始资料' | '概念' | '实体' | '内置 Agent' | '其他';

export const SYNC_LOG_OUTCOMES: SyncLogOutcome[] = ['changed', 'none', 'failed'];
export const SYNC_LOG_CONTENTS: SyncLogContent[] = ['原始资料', '概念', '实体', '内置 Agent', '其他'];

export const OUTCOME_LABELS: Record<SyncLogOutcome, string> = {
  changed: '有改动',
  none: '没改动',
  failed: '失败',
};

export const OUTCOME_HINTS: Record<SyncLogOutcome, string> = {
  changed: '同步成功，而且内容真的变了',
  none: '对账 / 检查 / 连接这类，跑完了两边一致，什么都没动',
  failed: '警告与错误，需要处理',
};

/**
 * 「会带来内容变化」的事件。
 *
 * 只有这些事件被记为成功时才可能算「有改动」；其余（连接、对账开始、成员上下线、配置变更…）
 * 即使成功也是「没改动」。事件名是服务端写入的稳定 id，安卓端逐条记录的事件名与桌面端一致。
 */
const CHANGED_EVENTS = new Set([
  // 本机 / 成员互推
  'local-broadcast',
  'push-ok',
  'push-received',
  'push-page',
  'push-file',
  'push-delete',
  'push-move',
  'push-merged',
  'move-superseded',
  // 拉取 / 补拉
  'pull-applied',
  'pull-page',
  'pull-file',
  'pull-delete',
  'pull-move',
  'file-pull-ok',
  'file-received',
  'file-pull-retry-ok',
  'session-pull-retry-ok',
  'replay',
  // 对账也要看数：只有真的拉了 / 补了账本才算改（见 hasVisibleChange）
  'reconcile-done',
]);

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * 这条记录的内容改动是不是「值得给用户看」。
 *
 * 三个批次事件带的是**过滤后**的条目（`items` / `paths` / `changes` 都只装用户可见项）：
 * 「应用中枢变更 12 项（均为系统页或无变化）」这类记录 count>0 却没有任何可见改动，
 * 不能算「有改动」，否则用户点进去看到的是空的。
 */
function hasVisibleChange(event: string, data: Record<string, unknown>): boolean {
  if (event === 'pull-applied') return count(data.items) + count(data.paths) + count(data.changes) > 0;
  if (event === 'reconcile-done') return Number(data.pulled) > 0 || Number(data.ledgerRepaired) > 0;
  if (event === 'replay') return Number(data.count) > 0 && count(data.items) + count(data.changes) > 0;
  return true;
}

/** 路径 → 内容类型：按知识库的一级/二级目录分；认不出的落「其他」，不猜 */
export function contentTypeOfPath(relPath: string): SyncLogContent {
  const path = String(relPath || '').replace(/^\.\//, '');
  if (!path) return '其他';
  if (path.startsWith('原始资料/')) return '原始资料';
  // Wiki 下的分类目录：概念 / 实体各算一类，归档等其余页面归「其他」
  if (path.startsWith('Wiki/概念/')) return '概念';
  if (path.startsWith('Wiki/实体/')) return '实体';
  // AIWorks/ 是内置 Agent 自己维护的系统区（索引、日志、关联表、提炼账本）
  if (path.startsWith('AIWorks/')) return '内置 Agent';
  return '其他';
}

/** 知识库里的路径（能按目录归类）；会话 id、看板 id 这类不是路径，别当文件归类 */
function isBrainPath(value: string): boolean {
  return value.startsWith('原始资料/') || value.startsWith('Wiki/') || value.startsWith('AIWorks/');
}

function pathsOf(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(data.paths)) for (const item of data.paths) if (typeof item === 'string' && item) out.push(item);
  if (typeof data.path === 'string' && data.path) out.push(data.path);
  if (typeof data.oldPath === 'string' && data.oldPath) out.push(data.oldPath);
  return out;
}

/** 条目涉及的内容类型（去重、按固定顺序） */
export function contentTypesOf(event: string, data: Record<string, unknown> = {}): SyncLogContent[] {
  const found = new Set<SyncLogContent>();
  let unclassified = false;
  for (const path of pathsOf(data)) {
    if (!isBrainPath(path)) { unclassified = true; continue; }
    found.add(contentTypeOfPath(path));
  }
  // 会话与任务看板不在 brain 目录里（path 是 id），按 kind 归类到「内置 Agent」
  const kinds: string[] = [];
  if (typeof data.kind === 'string') kinds.push(data.kind);
  if (data.kinds && typeof data.kinds === 'object') kinds.push(...Object.keys(data.kinds as Record<string, unknown>));
  if (kinds.some((kind) => kind === 'session' || kind === 'board')) found.add('内置 Agent');
  // 有改动但一条路径都没记（会话、看板、或老记录只留了文字）：落到「其他」，不空着
  if (!found.size && (unclassified || CHANGED_EVENTS.has(event))) found.add('其他');
  return SYNC_LOG_CONTENTS.filter((item) => found.has(item));
}

export interface ClassifiableEntry {
  level: string;
  event: string;
  data?: Record<string, unknown>;
}

/** 结果维度：失败（警告 + 错误）优先于「有没有改动」 */
export function outcomeOf(entry: ClassifiableEntry): SyncLogOutcome {
  if (entry.level === 'warn' || entry.level === 'error') return 'failed';
  if (!CHANGED_EVENTS.has(entry.event)) return 'none';
  return hasVisibleChange(entry.event, entry.data || {}) ? 'changed' : 'none';
}

export function matchesOutcome(entry: ClassifiableEntry, outcome: SyncLogOutcome): boolean {
  return outcomeOf(entry) === outcome;
}

export function matchesContent(entry: ClassifiableEntry, content: SyncLogContent): boolean {
  return contentTypesOf(entry.event, entry.data || {}).includes(content);
}
