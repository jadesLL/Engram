import crypto from 'node:crypto';
import os from 'node:os';
import { db, now } from '../lib/db.js';
import * as repo from '../assistant/repository.js';
import {
  BOARD_SYNC_ID,
  BOARD_SYSTEM_KEY,
  latestBoardAnswer,
  readSyncedBoard,
  type SyncedBoardPayload,
} from '../assistant/boardCore.js';
import { currentNodeId, peerDeviceLabel } from './store.js';

/**
 * 会话与任务看板的跨端同步（**仅完成态**）。
 *
 * 与页面/文件同步的差别都写在这里：
 *  - 会话不做字符级合并：消息是 append-only 的，按 id 取并集就是"合并"；轮次各自是 UUID，
 *    两端不会写同一行，按 id upsert 即可。
 *  - 只同步"完成态"：正在跑的轮次（running/queued）连同那一轮的消息都不出去。用户在对话中看到的是
 *    本机过程，轮次收口后才推给其他端——避免半截内容跨端、也避免边跑边刷流量。
 *  - 推理段（metadata.kind=reasoning）不同步：它是过程不是内容，体积最大而跨端价值最低
 *    （「沉淀到原始资料」同样跳过它）。
 *  - 任务看板全端唯一一份（BOARD_SYNC_ID），按答案生成时刻"最新者胜"整体替换；看板自带的
 *    task_board 系统会话不参与会话同步，否则每端会多出一份同名会话。
 *  - 会话删除用墓碑（assistant_session_tombstones）：否则对端留着的旧副本会在全量对账时
 *    把已删会话"复活"回来（与页面同步里的 stale 路径同一个原因）。
 *
 * 两种 hash 分工：
 *  - 清单指纹（fingerprint）：一条 SQL 聚合算出（条数/字节数/最新时间），对账时逐会话比对，
 *    不做内容传输；几百个会话也是一次查询。
 *  - 快照 hash（snapshotHash）：按内容投影精确计算，用于"这一条 op 到底要不要拉"，
 *    只对单个会话算，代价可控。
 */

/** 快照最多带多少条消息（取最近 N 条）。确定性截断：同样的消息集合必须算出同样的 hash */
export const SESSION_MESSAGE_LIMIT = 800;
/** 对账清单最多列多少个会话（按最近更新排序），避免会话很多时清单本身变成负担 */
export const SESSION_MANIFEST_LIMIT = 200;
/** 清单里最长带的标题长度（标题只用于展示，不必传全文） */
const TITLE_LIMIT = 120;

/** 非终态轮次：这些轮次的内容不参与同步（「正在对话」不同步） */
const ACTIVE_RUN_STATUSES = ['running', 'queued'];

/** 本机设备名：与成员注册上报的口径一致（client.ts 用同一写法） */
export function deviceLabel(): string {
  return os.hostname().slice(0, 60);
}

export interface SessionSnapshotSession {
  id: string;
  title: string;
  summary: string;
  archived: number;
  titleSource: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSnapshotMessage {
  id: string;
  runId: string;
  role: string;
  content: string;
  metadata: string;
  createdAt: string;
}

export interface SessionSnapshotRun {
  id: string;
  userMessageId: string;
  assistantMessageId: string;
  status: string;
  stepCount: number;
  context: string;
  usage: string;
  error: string;
  ingestedPath: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface SessionSnapshot {
  session: SessionSnapshotSession;
  messages: SessionSnapshotMessage[];
  runs: SessionSnapshotRun[];
  /** 消息被截断（只带了最近 N 条） */
  truncated?: boolean;
  /** 删除标记：对端据此删掉本地副本并记墓碑，不再复活 */
  deleted?: boolean;
}

export interface MergeResult {
  created: boolean;
  messages: number;
  runs: number;
}

function isReasoning(metadata: string): boolean {
  try {
    return JSON.parse(metadata || '{}')?.kind === 'reasoning';
  } catch {
    return false;
  }
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 本端会话首次进入同步链路时补上来源标记（界面据此显示「来自哪台设备」） */
export function stampSessionOrigin(sessionId: string): void {
  db.prepare(
    `UPDATE assistant_sessions SET origin_node_id = ?, origin_node_label = ?
     WHERE id = ? AND COALESCE(origin_node_id, '') = ''`
  ).run(currentNodeId(), deviceLabel(), sessionId);
}

/**
 * 来源设备名：行里存下来的优先，缺了按来源端补。
 *
 * 早先的广播只带来源节点 id、不带设备名，成员端因此只记住「来自某个节点」——界面就成了
 * 光秃秃的「来自」。这里兜底：中枢本端的写入记成设备名，成员推来的按 sync_peers 里注册的
 * 设备名（SSE 连接时上报）补；两头都没有就返回空串，界面退化成「其他设备」。
 */
export function resolveOriginLabel(nodeId: string, storedLabel: string): string {
  const id = str(nodeId);
  if (str(storedLabel)) return str(storedLabel);
  if (!id) return '';
  // 中枢本端写入的来源是 'hub'（hub.ts 的 HUB_ACTOR）；历史行里也可能是中枢自己的节点 id
  if (id === 'hub' || id === currentNodeId()) return deviceLabel();
  return peerDeviceLabel(id);
}

/**
 * 给「已知是别端来的、但没记住设备名」的会话补上名字（旧版中枢的广播只有 id 没有 node_label）。
 * 只改一行标签、不搬会话正文；本端原生会话（origin 为空）一概不碰，已有名字不覆盖。
 */
export function repairSessionOriginLabel(sessionId: string, nodeId: string, label: string): boolean {
  const id = str(nodeId);
  const name = str(label);
  if (!id || !name) return false;
  const row = db
    .prepare(`SELECT origin_node_id, origin_node_label FROM assistant_sessions WHERE id = ?`)
    .get(sessionId) as { origin_node_id: string | null; origin_node_label: string | null } | undefined;
  if (!row) return false;
  // origin 为空 = 本端自己聊出来的会话：补名字等于把它错标成「来自别端」，宁可不标
  if (!str(row.origin_node_id) || str(row.origin_node_label)) return false;
  db.prepare(`UPDATE assistant_sessions SET origin_node_label = ? WHERE id = ?`).run(name, sessionId);
  return true;
}

/** 该会话是否是本端的系统会话（任务看板）：是则不参与会话同步 */
export function isSystemSession(sessionId: string): boolean {
  const row = db.prepare(`SELECT system_key FROM assistant_sessions WHERE id = ?`).get(sessionId) as
    | { system_key: string | null }
    | undefined;
  return Boolean(row && str(row.system_key));
}

/**
 * 收集一个会话的完成态快照。
 *
 * 只带终态轮次（及其消息）与没有归属轮次的消息；正在跑的轮次连同那一轮的消息全部留在本机。
 * 没有任何终态轮次时仍然返回快照（会话本身也是要同步的对象）。
 */
export function collectSessionSnapshot(sessionId: string): SessionSnapshot | null {
  const row = db
    .prepare(
      `SELECT id, title, summary, archived, title_source, created_at, updated_at
       FROM assistant_sessions WHERE id = ?`
    )
    .get(sessionId) as any;
  if (!row) return null;

  const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
  const runRows = db
    .prepare(
      `SELECT id, user_message_id, assistant_message_id, status, step_count, context, usage, error,
              ingested_path, created_at, updated_at, completed_at
       FROM assistant_runs
       WHERE session_id = ? AND status NOT IN (${placeholders})
       ORDER BY created_at, id`
    )
    .all(sessionId, ...ACTIVE_RUN_STATUSES) as any[];
  const terminalRunIds = new Set(runRows.map((run) => String(run.id)));

  const messageRows = db
    .prepare(
      `SELECT id, run_id, role, content, metadata, created_at
       FROM assistant_messages WHERE session_id = ? ORDER BY created_at, id`
    )
    .all(sessionId) as any[];
  // 尚未收口的轮次（含排队中）：那一轮的消息一条都不出去
  const kept = messageRows.filter(
    (message) =>
      (!message.run_id || terminalRunIds.has(String(message.run_id))) && !isReasoning(str(message.metadata))
  );
  const truncated = kept.length > SESSION_MESSAGE_LIMIT;
  const messages = (truncated ? kept.slice(-SESSION_MESSAGE_LIMIT) : kept).map((message) => ({
    id: str(message.id),
    runId: str(message.run_id),
    role: str(message.role),
    content: str(message.content),
    metadata: str(message.metadata) || '{}',
    createdAt: str(message.created_at),
  }));
  const runs = runRows.map((run) => ({
    id: str(run.id),
    userMessageId: str(run.user_message_id),
    assistantMessageId: str(run.assistant_message_id),
    status: str(run.status),
    stepCount: Number(run.step_count || 0),
    context: str(run.context) || '{}',
    usage: str(run.usage),
    error: str(run.error),
    ingestedPath: str(run.ingested_path),
    createdAt: str(run.created_at),
    updatedAt: str(run.updated_at),
    completedAt: str(run.completed_at),
  }));

  return {
    session: {
      id: str(row.id),
      title: str(row.title),
      summary: str(row.summary),
      archived: Number(row.archived || 0),
      titleSource: str(row.title_source),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    },
    messages,
    runs,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** 参与 hash 的投影：只含会同步的字段（来源标记、dsh 会话 id 等本机字段不参与，否则两端永远算不出同一个 hash） */
function projectionOf(snapshot: SessionSnapshot): string {
  return JSON.stringify({
    s: snapshot.session,
    m: snapshot.messages.map((m) => [m.id, m.runId, m.role, m.content, m.metadata, m.createdAt]),
    r: snapshot.runs.map((r) => [
      r.id, r.userMessageId, r.assistantMessageId, r.status, r.stepCount,
      r.context, r.usage, r.error, r.ingestedPath, r.createdAt, r.updatedAt, r.completedAt,
    ]),
    t: snapshot.truncated ? 1 : 0,
  });
}

export function snapshotHash(snapshot: SessionSnapshot): string {
  return sha256(projectionOf(snapshot));
}

/** 本端某会话的内容 hash（精确，只用于单个会话）；会话不存在返回空串 */
export function sessionContentHash(sessionId: string): string {
  const snapshot = collectSessionSnapshot(sessionId);
  return snapshot ? snapshotHash(snapshot) : '';
}

/** 指纹的投影：会话元数据 + 消息条数/正文字节/最新时间（都不含正文，所以可以一条 SQL 算完） */
function fingerprintOf(session: {
  id: string;
  title: string;
  updated_at: string;
  archived: number;
  title_source: string;
  n: number;
  bytes: number;
  last_at: string;
}): string {
  return sha256(
    JSON.stringify([
      str(session.id),
      str(session.title),
      str(session.updated_at),
      Number(session.archived || 0),
      str(session.title_source),
      Number(session.n || 0),
      Number(session.bytes || 0),
      str(session.last_at),
    ])
  );
}

/**
 * 清单指纹：一条 SQL 聚合出「条数 / 正文字节 / 最新时间」，不搬内容。
 * 对账时用它逐会话比对（对不上才拉快照）；单条 op 仍用精确的 sessionContentHash。
 */
export function sessionFingerprint(sessionId: string): string {
  const row = db
    .prepare(
      `SELECT s.id, s.title, s.updated_at, s.archived, s.title_source,
              (SELECT COUNT(*) FROM assistant_messages m WHERE m.session_id = s.id) AS n,
              (SELECT COALESCE(SUM(LENGTH(m.content)), 0) FROM assistant_messages m WHERE m.session_id = s.id) AS bytes,
              (SELECT COALESCE(MAX(m.created_at), '') FROM assistant_messages m WHERE m.session_id = s.id) AS last_at
       FROM assistant_sessions s WHERE s.id = ?`
    )
    .get(sessionId) as any;
  return row ? fingerprintOf(row) : '';
}

/** 本端某会话的更新时间（用于和远端墓碑比较：本端副本更旧就该被删）；不存在返回空串 */
export function sessionUpdatedAt(sessionId: string): string {
  const row = db.prepare(`SELECT updated_at FROM assistant_sessions WHERE id = ?`).get(sessionId) as
    | { updated_at: string }
    | undefined;
  return str(row?.updated_at);
}

export function listSessionTombstones(): Array<{ sessionId: string; deletedAt: string }> {
  const rows = db
    .prepare(`SELECT session_id, deleted_at FROM assistant_session_tombstones ORDER BY deleted_at DESC`)
    .all() as any[];
  return rows.map((row) => ({ sessionId: str(row.session_id), deletedAt: str(row.deleted_at) }));
}

export function upsertSessionTombstone(sessionId: string, nodeId: string, deletedAt = now()): void {
  db.prepare(
    `INSERT INTO assistant_session_tombstones(session_id, deleted_at, node_id) VALUES(?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET
       deleted_at = MAX(assistant_session_tombstones.deleted_at, excluded.deleted_at),
       node_id = excluded.node_id`
  ).run(sessionId, deletedAt, nodeId);
}

/** 该会话在本端已被删（且删除时间不早于给定版本）→ 不应被远端快照复活 */
export function isLocallyDeleted(sessionId: string, updatedAt: string): boolean {
  const row = db
    .prepare(`SELECT deleted_at FROM assistant_session_tombstones WHERE session_id = ?`)
    .get(sessionId) as { deleted_at: string } | undefined;
  if (!row) return false;
  return str(row.deleted_at) >= str(updatedAt);
}

/**
 * 本端删掉一个会话并留下墓碑（级联清子表交给 repository，与手动删除同一套）。
 * 删除动作本身也要广播：否则对端手里的副本会在对账时把会话推回来。
 */
export function deleteSessionWithTombstone(sessionId: string, nodeId: string): void {
  repo.deleteSession(sessionId);
  upsertSessionTombstone(sessionId, nodeId);
}

/**
 * 合并一份远端会话快照：会话行 upsert、消息按 id 取并集、轮次按 id upsert。
 * 幂等——同一份快照应用两次结果一致（对账反复拉取同一会话不会长出新行）。
 */
export function mergeSessionSnapshot(
  snapshot: SessionSnapshot,
  fromNodeId: string,
  fromNodeLabel: string
): MergeResult {
  const session = snapshot?.session;
  if (!session?.id) throw new Error('会话快照缺少 id');
  // 本端的系统会话（任务看板）不跨端流动，也不该被远端同名会话顶替
  if (isSystemSession(session.id) || session.id === localBoardSessionId()) {
    return { created: false, messages: 0, runs: 0 };
  }
  if (isLocallyDeleted(session.id, session.updatedAt)) return { created: false, messages: 0, runs: 0 };

  const existing = db.prepare(`SELECT updated_at FROM assistant_sessions WHERE id = ?`).get(session.id) as
    | { updated_at: string }
    | undefined;
  const created = !existing;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO assistant_sessions(id, title, summary, archived, title_source, created_at, updated_at,
                                      origin_node_id, origin_node_label)
       VALUES(@id, @title, @summary, @archived, @titleSource, @createdAt, @updatedAt, @origin, @originLabel)
       ON CONFLICT(id) DO UPDATE SET
         title = CASE WHEN excluded.updated_at >= assistant_sessions.updated_at THEN excluded.title ELSE assistant_sessions.title END,
         summary = CASE WHEN excluded.updated_at >= assistant_sessions.updated_at THEN excluded.summary ELSE assistant_sessions.summary END,
         archived = CASE WHEN excluded.updated_at >= assistant_sessions.updated_at THEN excluded.archived ELSE assistant_sessions.archived END,
         title_source = CASE WHEN excluded.updated_at >= assistant_sessions.updated_at THEN excluded.title_source ELSE assistant_sessions.title_source END,
         updated_at = MAX(assistant_sessions.updated_at, excluded.updated_at),
         origin_node_id = CASE WHEN COALESCE(assistant_sessions.origin_node_id, '') = '' THEN excluded.origin_node_id ELSE assistant_sessions.origin_node_id END,
         -- 设备名可以被后来的合并补上（早先的广播只带 id）：已记住的名字不覆盖，
         -- 空着的就用这次带的补——否则「来自 」会一直空着，再没有第二次机会
         origin_node_label = CASE WHEN COALESCE(assistant_sessions.origin_node_label, '') <> '' THEN assistant_sessions.origin_node_label ELSE excluded.origin_node_label END`
    ).run({
      id: session.id,
      title: session.title || '未命名会话',
      summary: session.summary || '',
      archived: Number(session.archived || 0),
      titleSource: session.titleSource || 'default',
      createdAt: session.createdAt || now(),
      updatedAt: session.updatedAt || now(),
      origin: fromNodeId || '',
      originLabel: fromNodeLabel || '',
    });

    const upsertMessage = db.prepare(
      `INSERT INTO assistant_messages(id, session_id, run_id, role, content, metadata, created_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, metadata = excluded.metadata`
    );
    for (const message of snapshot.messages || []) {
      upsertMessage.run(
        message.id,
        session.id,
        message.runId || null,
        message.role,
        message.content || '',
        message.metadata || '{}',
        message.createdAt || now()
      );
    }

    const upsertRun = db.prepare(
      `INSERT INTO assistant_runs(id, session_id, user_message_id, assistant_message_id, status, context,
                                  step_count, error, ingested_path, usage, created_at, updated_at, completed_at)
       VALUES(@id, @sessionId, @userMessageId, @assistantMessageId, @status, @context,
              @stepCount, @error, @ingestedPath, @usage, @createdAt, @updatedAt, @completedAt)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         assistant_message_id = excluded.assistant_message_id,
         step_count = excluded.step_count,
         error = excluded.error,
         ingested_path = excluded.ingested_path,
         usage = excluded.usage,
         updated_at = excluded.updated_at,
         completed_at = excluded.completed_at`
    );
    for (const run of snapshot.runs || []) {
      // 轮次挂的提问消息必须先在（FK user_message_id → assistant_messages）；快照按时间序已保证
      upsertRun.run({
        id: run.id,
        sessionId: session.id,
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantMessageId || null,
        status: run.status,
        context: run.context || '{}',
        stepCount: Number(run.stepCount || 0),
        error: run.error || null,
        ingestedPath: run.ingestedPath || null,
        usage: run.usage || null,
        createdAt: run.createdAt || now(),
        updatedAt: run.updatedAt || now(),
        completedAt: run.completedAt || null,
      });
    }
  })();

  return { created, messages: (snapshot.messages || []).length, runs: (snapshot.runs || []).length };
}

export interface SessionManifestEntry {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  /** 清单指纹（廉价）；对不上就拉这个会话的完整快照 */
  hash: string;
  /** 来源端节点 id 与设备名（成员端据此显示「来自 <设备>」；空 = 本端原生会话） */
  originNodeId: string;
  originNodeLabel: string;
}

/** 本端任务看板会话 id（参与同步时要排除） */
function localBoardSessionId(): string {
  const row = db
    .prepare(`SELECT id FROM assistant_sessions WHERE system_key = ? LIMIT 1`)
    .get(BOARD_SYSTEM_KEY) as { id: string } | undefined;
  return str(row?.id);
}

/**
 * 参与同步的会话清单（排除看板这类系统会话），按最近更新倒序、最多 SESSION_MANIFEST_LIMIT 条。
 *
 * 来源端与设备名随清单一并给出：成员端拿到「本端记的是别端会话、却没有设备名」时，
 * 不必为一行标签再拉整份会话正文，直接补名即可（旧版广播丢下 label 的历史行靠这里自愈）。
 */
export function sessionManifest(): SessionManifestEntry[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.updated_at, s.archived, s.title_source, s.origin_node_id, s.origin_node_label,
              (SELECT COUNT(*) FROM assistant_messages m WHERE m.session_id = s.id) AS n,
              (SELECT COALESCE(SUM(LENGTH(m.content)), 0) FROM assistant_messages m WHERE m.session_id = s.id) AS bytes,
              (SELECT COALESCE(MAX(m.created_at), '') FROM assistant_messages m WHERE m.session_id = s.id) AS last_at
       FROM assistant_sessions s
       WHERE COALESCE(s.system_key, '') = ''
       ORDER BY s.updated_at DESC
       LIMIT ?`
    )
    .all(SESSION_MANIFEST_LIMIT) as any[];
  return rows.map((row) => ({
    id: str(row.id),
    title: str(row.title).slice(0, TITLE_LIMIT),
    updatedAt: str(row.updated_at),
    messageCount: Number(row.n || 0),
    hash: fingerprintOf(row),
    originNodeId: str(row.origin_node_id),
    originNodeLabel: resolveOriginLabel(str(row.origin_node_id), str(row.origin_node_label)),
  }));
}

// ---------------------------------------------------------------------------
// 任务看板：全端唯一一份
// ---------------------------------------------------------------------------

/** 看板同步载荷：形状定义在叶子模块 boardCore（看板状态也要读它，不能反向依赖同步层） */
export type BoardPayload = SyncedBoardPayload;
/** 已同步下来的那份看板（转出给同步层其他模块用） */
export { readSyncedBoard };

/** 本端看板当前内容 → 同步载荷；本端还没有答案时返回 null */
export function collectBoardPayload(): BoardPayload | null {
  const local = latestBoardAnswer();
  if (!local) return null;
  return {
    id: BOARD_SYNC_ID,
    answer: local.answer,
    generatedAt: local.generatedAt,
    windowStart: local.windowStart,
    windowEnd: local.windowEnd,
    nodeId: currentNodeId(),
    nodeLabel: deviceLabel(),
    updatedAt: now(),
  };
}

/** 两端都有看板时的胜者判定：先生成时刻、再写入时刻、最后设备 id */
export function boardWins(candidate: BoardPayload, incumbent: BoardPayload): boolean {
  if (str(candidate.generatedAt) !== str(incumbent.generatedAt)) {
    return str(candidate.generatedAt) > str(incumbent.generatedAt);
  }
  if (str(candidate.updatedAt) !== str(incumbent.updatedAt)) {
    return str(candidate.updatedAt) > str(incumbent.updatedAt);
  }
  return str(candidate.nodeId) > str(incumbent.nodeId);
}

/**
 * 合并一份远端看板：只有更新的那份才落地（整体替换，不做逐行融合——看板是模型一次提炼的整份产物）。
 * @returns 是否真的换了（false = 本端这份一样新或更新）
 */
export function mergeBoardPayload(payload: BoardPayload): boolean {
  if (!payload || typeof payload.answer !== 'string') return false;
  const incumbent = readSyncedBoard();
  if (incumbent && !boardWins(payload, incumbent)) return false;
  db.prepare(
    `INSERT INTO task_board_sync(id, payload, generated_at, node_id, node_label, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       payload = excluded.payload, generated_at = excluded.generated_at,
       node_id = excluded.node_id, node_label = excluded.node_label, updated_at = excluded.updated_at`
  ).run(
    BOARD_SYNC_ID,
    JSON.stringify(payload),
    str(payload.generatedAt),
    str(payload.nodeId),
    str(payload.nodeLabel),
    str(payload.updatedAt) || now()
  );
  return true;
}

/** 本端这份看板是不是本机生成的（界面按 boardState().local 展示，这里留给排障/后续调用） */
export function boardIsLocal(payload: BoardPayload | null): boolean {
  if (!payload) return false;
  return !payload.nodeId || payload.nodeId === currentNodeId();
}
