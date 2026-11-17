import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 办公本登录凭据同步（sync/doxentSync.ts）的核心状态机。
 *
 * 用真实的临时数据库 + 临时凭据目录，只替换「准备官方技能/CLI」与「关闭聊天运行时」，
 * 覆盖：镜像 → 应用（含阶段）→ 清除（远端解绑）→ 远端较新时不覆盖本机。
 */

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-doxent-sync-data-'));
const tempCred = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-doxent-sync-cred-'));
process.env.DATA_DIR = tempData;

let dbModule: typeof import('../lib/db.js');
let preferences: typeof import('./preferences.js');
let credentials: typeof import('../lib/doxentCredentials.js');
let categories: typeof import('./categories.js');
let makeSync: typeof import('./doxentSync.js')['createDoxentSessionSync'];
let sync: import('./doxentSync.js').DoxentSessionSync;

const LOCAL = {
  userId: 'user-1',
  token: 'bearer local-token',
  secret: '',
  sn: 'sn-local',
  userToken: 'user-token-1',
  refreshToken: 'refresh-token-1',
  account: '',
  updatedAt: Date.now(),
};
const REMOTE = {
  ...LOCAL,
  userToken: 'user-token-2',
  refreshToken: 'refresh-token-2',
  updatedAt: LOCAL.updatedAt + 10_000,
};

const credentialOptions = { env: {}, home: tempCred };
const dshHome = path.join(tempData, 'dsh');
let prepared = 0;
let stopped = 0;
let closed = 0;
let releasePrepare: (() => void) | null = null;

function waitFor(what: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('等待超时：' + what));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function localSessionPath(): string {
  return credentials.doxentCredentialPaths(credentialOptions).session;
}

function oplogCount(): number {
  const row = dbModule.db
    .prepare("SELECT COUNT(*) AS c FROM sync_oplog WHERE kind = 'preference' AND target = 'doxent_session'")
    .get() as { c: number };
  return Number(row.c);
}

before(async () => {
  dbModule = await import('../lib/db.js');
  dbModule.migrate();
  categories = await import('./categories.js');
  categories.saveSyncCategories({ settings: true });
  preferences = await import('./preferences.js');
  credentials = await import('../lib/doxentCredentials.js');
  const syncModule = await import('./doxentSync.js');
  makeSync = syncModule.createDoxentSessionSync;
  sync = makeSync({
    home: () => dshHome,
    credentials: credentialOptions,
    prepare: async () => {
      prepared += 1;
      if (releasePrepare) await new Promise<void>((resolve) => { releasePrepare = resolve; });
      return { state: 'logged-in' };
    },
    stopCli: async () => {
      stopped += 1;
    },
    resetCaches: () => {},
    closeRuntimes: () => {
      closed += 1;
    },
  });
});

after(() => {
  // Windows 上 sqlite 句柄不关会 EBUSY，临时目录清理失败会让整个测试文件报 hookFailed
  try {
    dbModule.db.close();
  } catch {
    /* 已关闭 */
  }
  fs.rmSync(tempData, { recursive: true, force: true });
  fs.rmSync(tempCred, { recursive: true, force: true });
});

test('镜像：本机会话写入偏好、stamp、oplog；digest 未变不重复上传', () => {
  credentials.writeDoxentSession(LOCAL, credentialOptions);
  assert.equal(sync.mirror(), true);
  const value = dbModule.getSetting('doxent_session');
  assert.equal(value, credentials.serializeDoxentSession(LOCAL));
  const preference = preferences.preferenceValue('doxent_session');
  assert.ok(preference);
  assert.equal(preference?.value, value);
  assert.ok(preference!.updatedAt > 0);
  assert.equal(oplogCount(), 1);
  assert.equal(sync.mirror(), false, 'digest 未变时不应重复入队');
});

test('应用：远端偏好写入本机会话，阶段 applying → preparing → idle，并准备/关闭运行时', async () => {
  const remoteRaw = credentials.serializeDoxentSession(REMOTE);
  // 模拟同步层合并：设置分类已开，远端 updatedAt 明显更新
  const changed = preferences.mergePreference('doxent_session', {
    value: remoteRaw,
    updatedAt: REMOTE.updatedAt + 1,
    nodeId: 'remote-node',
  });
  assert.equal(changed, true);

  releasePrepare = () => {};
  prepared = 0;
  closed = 0;
  sync.apply();
  await waitFor('进入准备阶段', () => sync.state().phase === 'preparing' && prepared === 1);
  // 凭据已经落盘，只是官方技能/CLI 还在准备
  const written = credentials.readDoxentSession(credentialOptions);
  assert.deepEqual(written?.data, REMOTE);
  assert.equal(stopped, 1, '应用前应停掉旧 daemon');

  const release = releasePrepare as () => void;
  releasePrepare = null;
  release();
  await waitFor('准备完成', () => sync.state().phase === 'idle' && prepared === 1);
  assert.equal(closed, 1, '登录确认后应回收聊天运行时');
  assert.equal(sync.mirror(), false, '应用后 digest 已同步，不应回推');
});

test('远端解绑：空偏好清掉本机会话并停止 daemon', () => {
  const beforeStops = stopped;
  preferences.mergePreference('doxent_session', {
    value: '',
    updatedAt: REMOTE.updatedAt + 5_000,
    nodeId: 'remote-node',
  });
  sync.apply();
  // apply 是异步队列；清文件在首个同步段内完成，等待会话文件消失
  return waitFor('本机会话被清除', () => !fs.existsSync(localSessionPath())).then(() => {
    assert.equal(fs.existsSync(localSessionPath()), false);
    assert.ok(stopped > beforeStops, '解绑后应停止官方 CLI');
  });
});

test('冲突：远端偏好比本机文件新时，mirror 不覆盖远端，align 应用远端', async () => {
  credentials.writeDoxentSession(LOCAL, credentialOptions);
  const remoteRaw = credentials.serializeDoxentSession(REMOTE);
  dbModule.setSetting('doxent_session', remoteRaw);
  dbModule.setSetting(
    'sync_preference:doxent_session',
    JSON.stringify({ updatedAt: REMOTE.updatedAt + 20_000, nodeId: 'remote-node' }),
  );
  assert.equal(sync.mirror(), false, '远端更新时不能用本机旧凭据覆盖');
  assert.equal(credentials.readDoxentSession(credentialOptions)?.data.userToken, LOCAL.userToken);

  prepared = 0;
  releasePrepare = () => {};
  sync.align();
  await waitFor('远端偏好被应用', () => credentials.readDoxentSession(credentialOptions)?.data.userToken === REMOTE.userToken);
  const release = releasePrepare as () => void;
  releasePrepare = null;
  release();
  await waitFor('准备完成', () => sync.state().phase === 'idle' && prepared === 1);
});
