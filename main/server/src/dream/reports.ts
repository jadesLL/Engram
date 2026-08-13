import { db, now } from '../lib/db.js';
import { deriveReportIdentity } from './reportIdentity.js';

export interface ReportInput {
  kind: string;
  payload: Record<string, any>;
  issueKey?: string;
  fingerprint?: string;
}

/**
 * Insert a finding once per condition. If the same open issue changes, refresh it in place;
 * if it was already closed, a changed fingerprint creates a new finding.
 */
export function addReports(items: ReportInput[]): number {
  let changed = 0;
  const tx = db.transaction(() => {
    for (const item of items) {
      const identity = deriveReportIdentity(item.kind, item.payload);
      const issueKey = item.issueKey || identity.issueKey;
      const condition = item.fingerprint || identity.fingerprint;
      const active = db.prepare(
        `SELECT id, fingerprint, status FROM reports
         WHERE kind = ? AND issue_key = ? AND status IN ('open', 'applying')
         ORDER BY id DESC LIMIT 1`
      ).get(item.kind, issueKey) as { id: number; fingerprint: string; status: string } | undefined;
      const same = db.prepare(
        `SELECT id FROM reports WHERE kind = ? AND issue_key = ? AND fingerprint = ? LIMIT 1`
      ).get(item.kind, issueKey, condition) as { id: number } | undefined;
      if (same) {
        if (active && active.id !== same.id && active.fingerprint !== condition) {
          db.prepare(`UPDATE reports SET status = 'dismissed' WHERE id = ? AND status = 'open'`).run(active.id);
        }
        continue;
      }
      if (active?.status === 'applying') continue;
      const serialized = JSON.stringify(item.payload);
      if (active) {
        db.prepare(
          `UPDATE reports SET run_at = ?, payload = ?, fingerprint = ?, status = 'open' WHERE id = ?`
        ).run(now(), serialized, condition, active.id);
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO reports(run_at, kind, payload, status, issue_key, fingerprint)
           VALUES(?, ?, ?, 'open', ?, ?)`
        ).run(now(), item.kind, serialized, issueKey, condition);
      }
      changed++;
    }
  });
  tx();
  return changed;
}
