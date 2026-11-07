import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_UPDATE_PENDING_KEY,
  SERVER_UPDATE_PENDING_TTL_MS,
  clearServerUpdatePending,
  evaluateServerUpdateOutcome,
  markServerUpdatePending,
  readServerUpdatePending,
  serverUpdateOutcomeText,
  shortCommit,
} from './serverUpdateFeedback.ts';

/** 只实现用到的三件事的内存版 localStorage */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key) as string : null),
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

test('更新前落的标记刷新后能读回来，过期/损坏自动丢弃', () => {
  const storage = fakeStorage();
  markServerUpdatePending({ fromVersion: '1.5.8', fromCommit: 'abcdef1234', source: 'settings' }, { storage, now: 1_000 });
  const pending = readServerUpdatePending({ storage, now: 2_000 });
  assert.equal(pending?.fromVersion, '1.5.8');
  assert.equal(pending?.fromCommit, 'abcdef1234');
  assert.equal(pending?.source, 'settings');
  assert.equal(pending?.at, 1_000);

  // 超过有效期：丢弃并清掉，避免几天后突然弹旧提示
  const expired = readServerUpdatePending({ storage, now: 1_000 + SERVER_UPDATE_PENDING_TTL_MS + 1 });
  assert.equal(expired, null);
  assert.equal(storage.map.has(SERVER_UPDATE_PENDING_KEY), false);

  // 损坏的 JSON 同样按「没有标记」处理
  storage.setItem(SERVER_UPDATE_PENDING_KEY, '{oops');
  assert.equal(readServerUpdatePending({ storage, now: 2_000 }), null);
  assert.equal(storage.map.has(SERVER_UPDATE_PENDING_KEY), false);
});

test('存储不可用时不抛错（隐私模式/禁用 localStorage 也要能正常更新）', () => {
  const storage = fakeStorage();
  storage.setItem = () => { throw new Error('QuotaExceeded'); };
  assert.doesNotThrow(() => markServerUpdatePending({ fromVersion: '', fromCommit: '', source: 'notice' }, { storage }));
  clearServerUpdatePending({ storage: null });
  assert.equal(readServerUpdatePending({ storage: null }), null);
});

test('版本号或提交号真的变了才算更新成功，没变只说可能回滚', () => {
  const pending = { at: 0, fromVersion: '1.5.8', fromCommit: 'aaa1111', source: 'settings' as const };
  assert.equal(evaluateServerUpdateOutcome(pending, { currentVersion: '1.5.8', commit: 'aaa1111' }).status, 'unchanged');
  assert.equal(evaluateServerUpdateOutcome(pending, { currentVersion: '1.5.9', commit: 'aaa1111' }).status, 'success');
  assert.equal(evaluateServerUpdateOutcome(pending, { currentVersion: '1.5.8', commit: 'bbb2222' }).status, 'success');
  // 没有标记 / 拿不到服务端状态：不猜
  assert.equal(evaluateServerUpdateOutcome(null, { currentVersion: '1.5.8' }).status, 'none');
  assert.equal(evaluateServerUpdateOutcome(pending, null).status, 'unresolved');
  // 入口没读到基线（基 Version/Commit 都为空）：更新流程已跑完，按成功处理
  assert.equal(
    evaluateServerUpdateOutcome({ at: 0, fromVersion: '', fromCommit: '', source: 'notice' }, { currentVersion: '1.5.8' }).status,
    'success',
  );
});

test('提示文案区分本机服务器与远程同步服务器，提交号只留 7 位', () => {
  assert.equal(shortCommit('abcdef1234567'), 'abcdef1');
  assert.equal(shortCommit(''), '');

  const success = evaluateServerUpdateOutcome(
    { at: 0, fromVersion: '1.5.8', fromCommit: 'aaa1111', source: 'settings' },
    { currentVersion: '1.5.9', commit: 'abcdef1234' },
  );
  assert.equal(serverUpdateOutcomeText(success, 'settings'), '服务器更新成功（v1.5.9 · abcdef1）');

  const hub = evaluateServerUpdateOutcome(
    { at: 0, fromVersion: '1.5.8', fromCommit: '', source: 'hub', hubHost: 'nas.local:18080' },
    { currentVersion: '1.5.9', commit: '' },
  );
  assert.equal(serverUpdateOutcomeText(hub, 'hub', 'nas.local:18080'), '同步服务器（nas.local:18080）更新成功（v1.5.9）');

  const unchanged = evaluateServerUpdateOutcome(
    { at: 0, fromVersion: '1.5.8', fromCommit: 'aaa1111', source: 'settings' },
    { currentVersion: '1.5.8', commit: 'aaa1111' },
  );
  assert.match(serverUpdateOutcomeText(unchanged, 'settings'), /版本未变化/);
  assert.match(serverUpdateOutcomeText(unchanged, 'settings'), /回滚/);
});
