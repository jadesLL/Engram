import crypto from 'node:crypto';
import { db, getSetting, setSetting, now } from '../lib/db.js';

/**
 * 多端同步的持久化状态：全局 revision 发号（hub）、变更日志、
 * 每页版本快照（三方合并祖先）、节点游标。
 * revision 与游标只增不减；oplog 定期裁剪，落后过多的节点走全量对账。
 */

/** oplog 最大保留条数；超出后最老的被裁剪，对应节点需全量对账 */
const OPLOG_KEEP = 5000;
/**
 * 每页保留的版本快照数（三方合并祖先来源）。
 *
 * 原来是 10：编辑器自动保存动辄几秒一版，一篇正在写的页面半小时就能攒出几十版，
 * 把另一台设备上次同步的基准挤出窗口；那台设备休眠/离线回来补推时中枢找不到祖先，
 * 只能整页按 mtime 裁决，于是凭空多出「原名-时间戳.md」冲突副本。50 版足够覆盖
 * 一次正常的编辑时段，配合 page_body_hashes 的旧稿识别，纯落后不再产生副本。
 */
const PAGE_REVISION_KEEP = 50;
/** 每页保留的正文 hash 条数（只存 hash，不存正文；用于识别「没改过的旧稿」） */
const PAGE_BODY_HASH_KEEP = 500;

/**
 * 同步对象类型：
 *  - page/file/delete/move：brain 目录下的文件（target 即 brain 相对路径）
 *  - session：内置 Agent 会话（target = 会话 id，载荷是完成态快照）
 *  - board：任务看板（target 恒为 default，全端唯一一份）
 *  - research：客户调研任务（target = 任务 id，载荷是完成态快照）
 * 会话、看板与调研任务在 DATA_DIR/wiki.db 里，safeJoin 到不了，所以单独几类而不是复用 file。
 */
export type SyncKind = 'page' | 'file' | 'delete' | 'move' | 'session' | 'board' | 'preference' | 'research';

export interface SyncOp {
  seq: number;
  kind: SyncKind;
  target: string;
  old_path: string;
  revision: number;
  node_id: string;
  ts: string;
  /** file op 的内容 hash（其它 kind 为空）：成员端按它判断是否需要拉文件。
   *  旧 oplog 行没有这一列，读出来是空串，成员端走兼容路径。 */
  hash?: string;
}

export function nextRevision(): number {
  const seq = Number(getSetting('sync_seq') || '0') + 1;
  setSetting('sync_seq', String(seq));
  return seq;
}

export function currentRevision(): number {
  return Number(getSetting('sync_seq') || '0');
}

/** 本端节点 id（首次使用时生成；hub 用它排除广播回声，节点用它标识来源） */
export function currentNodeId(): string {
  let id = getSetting('sync_node_id');
  if (!id) {
    id = crypto.randomUUID();
    setSetting('sync_node_id', id);
  }
  return id;
}

export function appendOplog(
  kind: SyncKind,
  target: string,
  revision: number,
  nodeId: string,
  oldPath = '',
  hash = '',
): number {
  const result = db
    .prepare(
      `INSERT INTO sync_oplog(kind, target, old_path, revision, node_id, ts, hash) VALUES(?,?,?,?,?,?,?)`
    )
    .run(kind, target, oldPath, revision, nodeId, now(), hash);
  const seq = Number(result.lastInsertRowid);
  // 逢 256 裁剪一次，避免每次写入都做 COUNT
  if (seq % 256 === 0) trimOplog();
  return seq;
}

function trimOplog(): void {
  db.prepare(
    `DELETE FROM sync_oplog WHERE seq <= (SELECT MAX(seq) FROM sync_oplog) - ?`
  ).run(OPLOG_KEEP);
}

export function minOplogSeq(): number {
  const row = db.prepare(`SELECT MIN(seq) AS min_seq FROM sync_oplog`).get() as { min_seq: number | null };
  return row.min_seq ?? 0;
}

/**
 * 游标需要的那条 op 是否已被裁剪（即「落后超过保留窗口」，该走全量对账）。
 * 判据是「保留区最老的 op 比游标的下一条还新」，不能只看本轮取回 0 条：
 * 缺口之后仍有新 op 时同样会取回若干条，只看条数会把缺口当成正常增量静默跳过，
 * 缺口里的删除/移动 op 与证据账本再也取不回来。
 * 空 oplog（min=0）视为无缺口——此时没有可重放的 op，也不会无限触发对账。
 */
export function needsResync(since: number): boolean {
  return minOplogSeq() > since + 1;
}

export function getOpsSince(since: number, limit = 500): SyncOp[] {
  return db
    .prepare(`SELECT * FROM sync_oplog WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
    .all(since, limit) as SyncOp[];
}

/**
 * 页面正文的内容指纹：去掉 frontmatter 里随每次保存都会变的更新日期，
 * 只比较用户真正写下的内容。行尾差异（CRLF/LF）与首尾空行也一并抹平。
 */
export function pageBodyHash(content: string): string {
  return crypto.createHash('sha256').update(pageBodyOf(content), 'utf8').digest('hex');
}

function pageBodyOf(content: string): string {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return text.trim();
  const meta = match[1]
    .split('\n')
    .filter((line) => !/^\s*(更新日期|修改日期|更新|updated|updated_at)\s*:/.test(line));
  return `${meta.join('\n')}\n${text.slice(match[0].length)}`.trim();
}

/**
 * 记录该页正文出现过的一个版本（只存 hash）。旧库在首次用到时从 page_revisions 回填，
 * 覆盖最近保留的若干版；之后每次提交都会补进来。
 */
function rememberPageBodyHash(path: string, content: string): void {
  const hash = pageBodyHash(content);
  db.prepare(
    `INSERT INTO page_body_hashes(path, hash, ts) VALUES(?,?,?)
     ON CONFLICT(path, hash) DO UPDATE SET ts=excluded.ts`
  ).run(path, hash, now());
  db.prepare(
    `DELETE FROM page_body_hashes WHERE path = ? AND hash NOT IN (
       SELECT hash FROM page_body_hashes WHERE path = ? ORDER BY ts DESC LIMIT ?
     )`
  ).run(path, path, PAGE_BODY_HASH_KEEP);
}

let bodyHashesBackfilled = false;
function ensurePageBodyHashes(): void {
  if (bodyHashesBackfilled) return;
  bodyHashesBackfilled = true;
  try {
    const rows = db.prepare(`SELECT path, content, ts FROM page_revisions`).all() as {
      path: string;
      content: string;
      ts: string;
    }[];
    const insert = db.prepare(
      `INSERT INTO page_body_hashes(path, hash, ts) VALUES(?,?,?)
       ON CONFLICT(path, hash) DO UPDATE SET ts=CASE WHEN excluded.ts > ts THEN excluded.ts ELSE ts END`
    );
    db.transaction(() => {
      for (const row of rows) insert.run(row.path, pageBodyHash(row.content), row.ts);
    })();
  } catch {
    // 老库还没跑迁移等异常：下次进程启动再试，不能阻塞同步
    bodyHashesBackfilled = false;
  }
}

/** 这个正文版本该页历史上是否出现过（出现过 = 推送方只是旧稿，没有本地改动） */
export function isKnownPageBody(path: string, content: string): boolean {
  ensurePageBodyHashes();
  const hit = db
    .prepare(`SELECT 1 FROM page_body_hashes WHERE path = ? AND hash = ?`)
    .get(path, pageBodyHash(content));
  return Boolean(hit);
}

export function savePageRevision(path: string, revision: number, content: string, nodeId: string): void {
  ensurePageBodyHashes();
  db.prepare(
    `INSERT INTO page_revisions(path, revision, content, node_id, ts) VALUES(?,?,?,?,?)
     ON CONFLICT(path, revision) DO UPDATE SET content=excluded.content, node_id=excluded.node_id, ts=excluded.ts`
  ).run(path, revision, content, nodeId, now());
  db.prepare(
    `DELETE FROM page_revisions WHERE path = ? AND revision NOT IN (
       SELECT revision FROM page_revisions WHERE path = ? ORDER BY revision DESC LIMIT ?
     )`
  ).run(path, path, PAGE_REVISION_KEEP);
  // hash 表不随正文快照裁剪：祖先版本被高频保存挤掉后，仍能认出「没改过的旧稿」
  rememberPageBodyHash(path, content);
}

export function getPageRevision(path: string, revision: number): string | null {
  const row = db
    .prepare(`SELECT content FROM page_revisions WHERE path = ? AND revision = ?`)
    .get(path, revision) as { content: string } | undefined;
  return row?.content ?? null;
}

export function setPageSyncRevision(path: string, revision: number): void {
  db.prepare(`UPDATE pages SET sync_revision = ? WHERE path = ?`).run(revision, path);
}

export function getPageSyncRevision(path: string): number {
  const row = db.prepare(`SELECT sync_revision FROM pages WHERE path = ?`).get(path) as
    | { sync_revision: number }
    | undefined;
  return row?.sync_revision ?? 0;
}

export function getCursor(): number {
  return Number(getSetting('sync_cursor') || '0');
}

export function setCursor(seq: number): void {
  if (seq > getCursor()) setSetting('sync_cursor', String(seq));
}

/**
 * 换中枢 / 解除绑定：游标归零。
 *
 * cursor 是本端对「某个中枢的事件序号」的记忆，序号只在同一中枢内可比。换到 seq
 * 更小的新中枢后仍拿旧游标去问 changes?since=，新中枢只会回 0 条，直播 op 也会被
 * `seq <= cursor` 丢掉——界面仍显示「已连接」，实时同步却永久不工作。
 */
export function resetCursor(): void {
  setSetting('sync_cursor', '0');
}

/**
 * 换中枢 / 解除绑定：把页面同步基线与三方合并历史清掉。
 *
 * sync_revision / page_revisions / page_body_hashes 都来自旧中枢；新中枢的 revision
 * 从 1 开始，旧基线会让对账把本机当成「已同步过的旧稿」直接推上去，或按旧祖先
 * 做错误的三方合并。清掉后下一轮按新中枢全量对齐（空中枢则以本机内容播种）。
 */
export function resetSyncBaselines(): void {
  db.prepare(`UPDATE pages SET sync_revision = 0`).run();
  db.prepare(`DELETE FROM page_revisions`).run();
  db.prepare(`DELETE FROM page_body_hashes`).run();
}

// ---------- 同步群组成员（中枢端） ----------

export interface SyncPeer {
  id: string;
  name: string;
  token: string;
  node_label: string;
  /** 成员设备上报的节点 id（会话行的 origin_node_id 记的是它，不是这里的 id） */
  node_id: string;
  last_seen_at: string | null;
  last_seq: number;
  revoked: number;
  created_at: string;
}

export function createPeer(name: string, token: string): SyncPeer {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO sync_peers(id, name, token, created_at) VALUES(?,?,?,?)`
  ).run(id, name, token, now());
  return getPeer(id)!;
}

export function getPeer(id: string): SyncPeer | undefined {
  return db.prepare(`SELECT * FROM sync_peers WHERE id = ?`).get(id) as SyncPeer | undefined;
}

export function findPeerByToken(token: string): SyncPeer | undefined {
  return db
    .prepare(`SELECT * FROM sync_peers WHERE token = ? AND revoked = 0`)
    .get(token) as SyncPeer | undefined;
}

export function listPeers(): SyncPeer[] {
  return db.prepare(`SELECT * FROM sync_peers WHERE revoked = 0 ORDER BY created_at ASC`).all() as SyncPeer[];
}

export function revokePeer(id: string): void {
  db.prepare(`UPDATE sync_peers SET revoked = 1 WHERE id = ?`).run(id);
}

/** 成员活动上报：在线标记、节点设备名与节点 id、已应用水位 */
export function touchPeer(
  id: string,
  opts: { nodeLabel?: string; nodeId?: string; seq?: number } = {}
): void {
  const peer = getPeer(id);
  if (!peer) return;
  db.prepare(
    `UPDATE sync_peers SET last_seen_at = ?, last_seq = MAX(last_seq, ?),
       node_label = COALESCE(NULLIF(?, ''), node_label),
       node_id = COALESCE(NULLIF(?, ''), node_id)
     WHERE id = ?`
  ).run(now(), opts.seq ?? peer.last_seq, opts.nodeLabel ?? '', opts.nodeId ?? '', id);
}

/**
 * 按来源 id 找成员设备名：老会话行的来源记的是设备**节点 id**，广播里记的是**成员 id**，
 * 两种都认。找不到（成员已被移除、从没上报过设备名）返回空串，由上层退化成「其他设备」。
 */
export function peerDeviceLabel(originId: string): string {
  const id = String(originId || '');
  if (!id) return '';
  const row = db
    .prepare(
      `SELECT node_label FROM sync_peers
       WHERE node_label <> '' AND (id = ? OR (node_id <> '' AND node_id = ?))
       LIMIT 1`
    )
    .get(id, id) as { node_label: string } | undefined;
  return String(row?.node_label || '');
}

/**
 * 按来源 id 找**用户在同步中枢上给这台设备起的成员名**（设置 → 多端同步 → 群组成员）。
 *
 * 界面上的「来自 <设备>」用这个而不是设备上报的主机名：Docker 上主机名是容器 ID，
 * 桌面端上是机器名，都不是用户认得的那台设备。来源记的可能是成员 id（广播）或节点 id（会话行），
 * 两种都认；找不到（成员已被移除）返回空串，由上层退化成设备名 / 「其他设备」。
 */
export function peerDisplayName(originId: string): string {
  const id = String(originId || '');
  if (!id) return '';
  const row = db
    .prepare(
      `SELECT name FROM sync_peers
       WHERE revoked = 0 AND (id = ? OR (node_id <> '' AND node_id = ?))
       LIMIT 1`
    )
    .get(id, id) as { name: string } | undefined;
  return String(row?.name || '').trim();
}
