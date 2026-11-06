import { db, now } from '../lib/db.js';

/**
 * 证据账本快照同步：把某个 Wiki 页面引用到的全部来源版本状态
 * （source_versions → ingest_runs → ingest_facts / page_contributions）
 * 作为整体物化复制到对端，而不是逐行回放——版本切换的副作用
 * （旧版本转 superseded、其他页面贡献退位）已经体现在快照行的最终状态里。
 *
 * 应用端按「只前进不后退」合并：快照里的行 upsert；版本状态与贡献状态以更晚的
 * 激活/更新时间者胜；只有快照确实带来了该路径「更新的 active 版本」时才清理本端
 * 不在快照里的旧版本。成员快照可能是陈旧/不完整的（离线、旧备份、本端重新提炼未提交），
 * 无条件精确替换会把中枢较新的账本顶回旧版甚至删光——用户可见「已提炼」被翻回「未提炼」。
 *
 * 两个收集锚点：
 *  - collectEvidenceForPage：随页面 op 实时携带（页面写入/合并广播用）
 *  - collectEvidenceForPath：全量对账按来源路径补齐（「已提炼」标记的同锚点视图，
 *    覆盖「页面 op 已被 oplog 裁剪因而账本从未到达对端」的缺口）
 */

type Row = Record<string, any>;

export interface ContributionRow extends Row {
  /** 收集时 join pages 得到：该贡献所属页面的路径（应用端按路径重映射 page_id） */
  __page_path?: string;
}

export interface EvidenceSnapshot {
  versions: Row[];
  runs: Row[];
  facts: Row[];
  contributions: ContributionRow[];
}

/** 由「版本集合」物化证据链快照：runs/facts/贡献按这些版本收集，贡献带 __page_path 供对端重映射 */
function collectEvidenceByVersions(versions: Row[]): EvidenceSnapshot | null {
  if (!versions.length) return null;
  const versionIdList = versions.map((v) => v.id);
  const versionPlaceholders = versionIdList.map(() => '?').join(',');

  const runs = db
    .prepare(`SELECT * FROM ingest_runs WHERE source_version_id IN (${versionPlaceholders})`)
    .all(...versionIdList) as Row[];
  const runIds = runs.map((r) => r.id);
  const facts = runIds.length
    ? (db
        .prepare(`SELECT * FROM ingest_facts WHERE run_id IN (${runIds.map(() => '?').join(',')})`)
        .all(...runIds) as Row[])
    : [];
  const contributions = db
    .prepare(
      `SELECT pc.*, p.path AS __page_path
       FROM page_contributions pc LEFT JOIN pages p ON p.id = pc.page_id
       WHERE pc.source_version_id IN (${versionPlaceholders})`
    )
    .all(...versionIdList) as ContributionRow[];
  return { versions, runs, facts, contributions };
}

/** 收集一个页面的证据链快照；该页没有任何证据时返回 null */
export function collectEvidenceForPage(pagePath: string): EvidenceSnapshot | null {
  const page = db.prepare(`SELECT id FROM pages WHERE path = ?`).get(pagePath) as
    | { id: string }
    | undefined;
  if (!page) return null;
  const versionIds = (
    db
      .prepare(`SELECT DISTINCT source_version_id AS id FROM page_contributions WHERE page_id = ?`)
      .all(page.id) as { id: string }[]
  )
    .map((r) => r.id)
    .filter(Boolean);
  if (!versionIds.length) return null;

  const placeholders = versionIds.map(() => '?').join(',');
  // 涉及版本所属的“来源路径”下的全部版本（不只本页引用的）——保证应用端能做整路径状态替换
  const versions = db
    .prepare(
      `SELECT * FROM source_versions WHERE path IN (
         SELECT DISTINCT path FROM source_versions WHERE id IN (${placeholders})
       )`
    )
    .all(...versionIds) as Row[];
  return collectEvidenceByVersions(versions);
}

/**
 * 按「来源路径」收集证据链快照（与「已提炼」标记同一个锚点）：
 * 页面 op 只带得动「自己引用过的来源」，标记却是来源路径自身的属性，两者并不等价——
 * 页面/文件同步过去、载体 op 却早已被 oplog 裁剪时，对端的账本就是空的。
 * 全量对账用本函数逐条补齐这些路径。
 */
export function collectEvidenceForPath(sourcePath: string): EvidenceSnapshot | null {
  const versions = db.prepare(`SELECT * FROM source_versions WHERE path = ?`).all(sourcePath) as Row[];
  return collectEvidenceByVersions(versions);
}

/** 快照行的「新旧」判据：优先激活时刻，其次创建时刻；解析失败按最旧（0） */
function rankOfEvidenceRow(row: Record<string, any>): number {
  const value = Date.parse(String(row?.activated_at || row?.created_at || ''));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 版本状态只前进不后退：陈旧/不完整快照不能把本地 active 顶回旧版，
 * 也不能把已 superseded/processing 的旧版本重新激活。
 * 「版本切换」只允许由快照里更新的 active 版本驱动（snapshotActiveRank）。
 *
 * @param pathHasLocalActive 本路径在应用快照前**本地是否已有 active 版本**：
 *   - 本地没有任何 active（新成员首次收到提炼账本、或本端只留下 superseded 旧行）时，
 *     允许快照里的 active 版本直接落地——否则时钟偏慢/只有旧行的成员永远拿不到标记；
 *   - 本地已有 active 时，只允许 rank 更高（激活时间更晚）的 active 替换。
 */
function guardedVersionState(
  local: Record<string, any>,
  incoming: Record<string, any>,
  snapshotActiveRank: number,
  pathHasLocalActive: boolean,
): [string, string | null, string | null] {
  const localStatus = String(local.status || '');
  const incomingStatus = String(incoming.status || '');
  const localActive = localStatus === 'active';
  const incomingActive = incomingStatus === 'active';
  const localRank = rankOfEvidenceRow(local);
  const incomingRank = rankOfEvidenceRow(incoming);
  if (localActive && incomingActive && incomingRank < localRank) {
    // 双方都是 active：以更晚激活者为准，陈旧快照里的旧 active 不能把本端较新的 active 顶掉
    return [localStatus, local.activated_at ?? null, local.error ?? null];
  }
  if (localActive && !incomingActive && snapshotActiveRank <= localRank) {
    // 快照想取消本端 active，但带不来更新的 active：保留本端现状（陈旧快照/部分快照）
    return [localStatus, local.activated_at ?? null, local.error ?? null];
  }
  if (!localActive && incomingActive && pathHasLocalActive && incomingRank <= localRank) {
    // 本地该路径已有 active 版本、且快照这条 active 不比本端记录新：不采纳（陈旧快照）。
    // 本地该路径没有任何 active 时（pathHasLocalActive=false）放行，让首次提炼的标记能落地。
    return [localStatus, local.activated_at ?? null, local.error ?? null];
  }
  return [incomingStatus, incoming.activated_at ?? null, incoming.error ?? null];
}

/**
 * 应用一份证据快照：按「只前进不后退」合并（见文件头注释）。
 * 返回应用的贡献条数（0 表示无可应用内容）。
 */
export function applyEvidenceSnapshot(snapshot: EvidenceSnapshot): number {
  const versions = snapshot.versions || [];
  const runs = snapshot.runs || [];
  const facts = snapshot.facts || [];
  const contributions = snapshot.contributions || [];
  if (!versions.length) return 0;

  const paths = [...new Set(versions.map((v) => String(v.path)))];
  return db.transaction((): number => {
    // 贡献的 page_id/pages 行与版本行可能先插子表后补父表，FK 检查统一推迟到 COMMIT
    db.pragma('defer_foreign_keys = ON');
    const findVersionById = db.prepare(
      `SELECT id, path, content_hash, status, created_at, activated_at, error FROM source_versions WHERE id = ?`
    );
    const findVersionByHash = db.prepare(
      `SELECT id, path, content_hash, status, created_at, activated_at, error FROM source_versions WHERE path = ? AND content_hash = ?`
    );
    const idMap = new Map<string, string>(); // 快照版本 id → 本地版本 id
    const upsertVersion = db.prepare(
      `INSERT INTO source_versions(id, path, content_hash, previous_id, status, created_at, activated_at, error)
       VALUES(@id, @path, @content_hash, @previous_id, @status, @created_at, @activated_at, @error)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, activated_at=excluded.activated_at, error=excluded.error`
    );
    const updateVersionState = db.prepare(
      `UPDATE source_versions SET status=?, activated_at=?, error=? WHERE id=?`
    );
    // 应用前本地哪些来源路径已经存在 active 版本（用于 guardedVersionState 的放行判断）
    const localActivePaths = new Set(
      (db.prepare(`SELECT DISTINCT path FROM source_versions WHERE status = 'active'`).all() as { path: string }[])
        .map((row) => String(row.path)),
    );
    // 快照里每个来源路径上「最新 active 版本」的激活时刻：版本切换与旧行清理只允许由它驱动
    const snapshotActiveRank = new Map<string, number>();
    for (const v of versions) {
      if (String(v.status) !== 'active') continue;
      const path = String(v.path);
      snapshotActiveRank.set(path, Math.max(snapshotActiveRank.get(path) || 0, rankOfEvidenceRow(v)));
    }
    for (const v of versions) {
      const path = String(v.path);
      const local = ((findVersionById.get(v.id) as Record<string, any> | undefined)
        || (findVersionByHash.get(path, v.content_hash) as Record<string, any> | undefined));
      if (local) {
        // 两端独立为同一 (path, content_hash) 建过版本：归并到本地既有 id
        const [status, activatedAt, error] = guardedVersionState(
          local, v, snapshotActiveRank.get(path) || 0, localActivePaths.has(path),
        );
        idMap.set(String(v.id), String(local.id));
        updateVersionState.run(status, activatedAt, error, local.id);
      } else {
        upsertVersion.run({
          id: v.id,
          path: v.path,
          content_hash: v.content_hash,
          previous_id: v.previous_id ?? null,
          status: v.status,
          created_at: v.created_at,
          activated_at: v.activated_at ?? null,
          error: v.error ?? null,
        });
        idMap.set(String(v.id), String(v.id));
      }
    }
    // 快照中没有的本路径版本：只有「快照确实带来更新的 active 版本」时才清理，
    // 且被 active 贡献引用的版本不动（否则会连带删掉证据抽屉里的现行引用）。
    const keepIdByPath = new Map<string, Set<string>>();
    for (const v of versions) {
      const path = String(v.path);
      const keep = keepIdByPath.get(path) || new Set<string>();
      keep.add(String(idMap.get(String(v.id)) || v.id));
      keepIdByPath.set(path, keep);
    }
    const activeContributionVersions = new Set(
      (db.prepare(`SELECT DISTINCT source_version_id AS id FROM page_contributions WHERE active = 1`).all() as { id: string }[])
        .map((row) => String(row.id))
        .filter(Boolean),
    );
    const deleteVersion = db.prepare(`DELETE FROM source_versions WHERE id = ?`);
    for (const path of paths) {
      const keep = keepIdByPath.get(path) || new Set<string>();
      const snapshotRank = snapshotActiveRank.get(path) || 0;
      // 快照没有该路径的 active 版本（陈旧/部分快照）：一行都不删
      if (snapshotRank <= 0) continue;
      const locals = db.prepare(
        `SELECT id, status, created_at, activated_at FROM source_versions WHERE path = ?`
      ).all(path) as Record<string, any>[];
      for (const row of locals) {
        const id = String(row.id);
        if (keep.has(id)) continue;
        // 本端 active 比快照的 active 还新：快照是旧的，不能删
        if (String(row.status) === 'active' && snapshotRank <= rankOfEvidenceRow(row)) continue;
        if (activeContributionVersions.has(id)) continue;
        deleteVersion.run(id);
      }
    }
    // 归并后被替换掉的旧 id 上可能还挂着本页贡献（先于版本删除迁走）
    for (const [fromId, toId] of idMap) {
      if (fromId === toId) continue;
      db.prepare(
        `UPDATE page_contributions SET source_version_id = ? WHERE source_version_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM page_contributions p2
           WHERE p2.source_version_id = ? AND p2.page_id = page_contributions.page_id
         )`
      ).run(toId, fromId, toId);
    }

    const upsertRun = db.prepare(
      `INSERT INTO ingest_runs(id, path, content_hash, source_version_id, status, commit_status, derived_status, started_at, finished_at, stats, error)
       VALUES(@id, @path, @content_hash, @source_version_id, @status, @commit_status, @derived_status, @started_at, @finished_at, @stats, @error)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, commit_status=excluded.commit_status, derived_status=excluded.derived_status,
         finished_at=excluded.finished_at, stats=excluded.stats, error=excluded.error
       WHERE COALESCE(excluded.finished_at, '') >= COALESCE(ingest_runs.finished_at, '')`
    );
    for (const r of runs) {
      upsertRun.run({
        id: r.id,
        path: r.path,
        content_hash: r.content_hash,
        source_version_id: r.source_version_id ? idMap.get(r.source_version_id) || r.source_version_id : null,
        status: r.status,
        commit_status: r.commit_status,
        derived_status: r.derived_status,
        started_at: r.started_at,
        finished_at: r.finished_at ?? null,
        stats: r.stats || '{}',
        error: r.error ?? null,
      });
    }
    const upsertFact = db.prepare(
      `INSERT INTO ingest_facts(run_id, fact_id, statement, sources) VALUES(@run_id, @fact_id, @statement, @sources)
       ON CONFLICT(run_id, fact_id) DO UPDATE SET statement=excluded.statement, sources=excluded.sources`
    );
    for (const f of facts) upsertFact.run(f);

    const upsertContribution = db.prepare(
      `INSERT INTO page_contributions(
         id, page_id, source_version_id, run_id, contribution_key, fact_ids, relations, content,
         summary, domain, confidence, source_ref, managed, active, created_at, updated_at
       ) VALUES(@id, @page_id, @source_version_id, @run_id, @contribution_key, @fact_ids, @relations, @content,
         @summary, @domain, @confidence, @source_ref, @managed, @active, @created_at, @updated_at)
       ON CONFLICT(page_id, source_version_id) DO UPDATE SET
         run_id=excluded.run_id, contribution_key=excluded.contribution_key, fact_ids=excluded.fact_ids,
         content=excluded.content, summary=excluded.summary, domain=excluded.domain,
         confidence=excluded.confidence, managed=excluded.managed, active=excluded.active,
         updated_at=excluded.updated_at
       WHERE COALESCE(excluded.updated_at, '') >= COALESCE(page_contributions.updated_at, '')`
    );
    // 贡献按 (本地图面 id, 版本 id) 落位：page_id 按页路径重映射，缺失页面跳过（页面随后由页面同步补齐）
    const pageIdByPath = new Map<string, string>();
    const findPageId = db.prepare(`SELECT id FROM pages WHERE path = ?`);
    let applied = 0;
    for (const c of contributions) {
      const pagePath = String(c.__page_path || '');
      if (!pagePath) continue;
      let localPageId = pageIdByPath.get(pagePath);
      if (!localPageId) {
        const row = findPageId.get(pagePath) as { id: string } | undefined;
        if (!row) continue;
        localPageId = row.id;
        pageIdByPath.set(pagePath, localPageId);
      }
      try {
        upsertContribution.run({
          id: c.id,
          page_id: localPageId,
          source_version_id: idMap.get(c.source_version_id) || c.source_version_id,
          run_id: c.run_id,
          contribution_key: c.contribution_key,
          fact_ids: c.fact_ids || '[]',
          relations: c.relations || '[]',
          content: c.content || '',
          summary: c.summary || '',
          domain: c.domain || '',
          confidence: c.confidence || '中',
          source_ref: c.source_ref || '',
          managed: c.managed ?? 0,
          active: c.active ?? 0,
          created_at: c.created_at,
          updated_at: c.updated_at || now(),
        });
        applied++;
      } catch {
        // 单条失败（FK 悬挂等）不阻塞其余行；全量对账可兜底
      }
    }
    return applied;
  })();
}
