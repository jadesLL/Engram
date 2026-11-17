import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearDoxentSession,
  describeDoxentAccount,
  doxentAccountDisplay,
  doxentCliDir,
  doxentCredentialPaths,
  doxentSessionDigest,
  parseDoxentSession,
  parseDoxentSessionValue,
  readDoxentSession,
  serializeDoxentSession,
  writeDoxentSession,
} from './doxentCredentials.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doxent-credentials-'));
}

const SESSION = {
  userId: '211029004152330250',
  token: 'bearer 9c75f154d60d495bba552508934c859b',
  secret: '',
  sn: 'nsn_27fdf183f7d94134929c17e30dff6bbb',
  userToken: 'ac8c0a51a908481ab016c58f04a8705d',
  refreshToken: '40b00e12a8d74da187ef2e2d083052c4',
  account: '',
  updatedAt: 1794881087411,
};

test('官方 CLI 会话目录：APPDATA 优先，否则 HOME，固定 doxent/cli', () => {
  assert.equal(doxentCliDir({ env: { APPDATA: '/tmp/appdata' }, home: '/home/u' }), path.join('/tmp/appdata', 'doxent', 'cli'));
  assert.equal(doxentCliDir({ env: {}, home: '/home/u' }), path.join('/home/u', 'doxent', 'cli'));
  const paths = doxentCredentialPaths({ env: {}, home: '/home/u' });
  assert.equal(paths.session, path.join('/home/u', 'doxent', 'cli', 'offline_info.json'));
  assert.equal(paths.identity, path.join('/home/u', 'doxent', 'cli', 'remote_login_identity.json'));
});

test('会话解析：官方字段齐全时接受；缺必填 / 超长 / 类型不对拒绝', () => {
  assert.deepEqual(parseDoxentSessionValue(SESSION), SESSION);
  const missing = { ...SESSION, refreshToken: '' };
  assert.equal(parseDoxentSessionValue(missing), null);
  const tooLong = { ...SESSION, userToken: 'x'.repeat(1201) };
  assert.equal(parseDoxentSessionValue(tooLong), null);
  assert.equal(parseDoxentSessionValue(null), null);
  assert.equal(parseDoxentSessionValue([]), null);
  assert.deepEqual(parseDoxentSession(JSON.stringify(SESSION)), SESSION);
  assert.equal(parseDoxentSession(`{"x":"${'x'.repeat(20_000)}"}`), null);
});

test('会话序列化：只保留官方契约字段，未知字段不随同步外流', () => {
  const raw = serializeDoxentSession({ ...SESSION, unexpected: 'secret-from-new-version' } as typeof SESSION);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(parsed.unexpected, undefined);
  assert.equal(parsed.userId, SESSION.userId);
  assert.equal(parsed.updatedAt, SESSION.updatedAt);
});

test('会话文件读写：原子写 + identity 重建 + 0600（POSIX）+ 清除', () => {
  const home = tempHome();
  const options = { env: {}, home };
  const written = writeDoxentSession(SESSION, options);
  const paths = doxentCredentialPaths(options);
  assert.equal(fs.existsSync(paths.session), true);
  assert.equal(fs.existsSync(paths.identity), true);
  assert.equal(fs.readFileSync(paths.session, 'utf8'), written.raw);
  const identity = JSON.parse(fs.readFileSync(paths.identity, 'utf8')) as { version?: number; sn?: string };
  assert.deepEqual(identity, { version: 1, sn: SESSION.sn });
  if (process.platform !== 'win32') {
    const mode = fs.statSync(paths.session).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const read = readDoxentSession(options);
  assert.ok(read);
  assert.deepEqual(read?.data, SESSION);
  assert.equal(read?.raw, written.raw);
  assert.equal(read?.digest, doxentSessionDigest(written.raw));

  clearDoxentSession(options);
  assert.equal(fs.existsSync(paths.session), false);
  assert.equal(fs.existsSync(paths.identity), false);
  assert.equal(readDoxentSession(options), null);
});

test('会话文件读坏数据返回 null（不能把坏 JSON 当登录态）', () => {
  const home = tempHome();
  const options = { env: {}, home };
  const paths = doxentCredentialPaths(options);
  fs.mkdirSync(path.dirname(paths.session), { recursive: true });
  fs.writeFileSync(paths.session, '{not-json', 'utf8');
  assert.equal(readDoxentSession(options), null);
  fs.writeFileSync(paths.session, '{"userId":"u"}', 'utf8');
  assert.equal(readDoxentSession(options), null);
});

test('当前账号展示：手机号/邮箱/用户名脱敏，旧会话用用户 ID 尾号兜底', () => {
  assert.deepEqual(describeDoxentAccount({ account: '13812345678', userId: 'u' }), {
    display: '138 **** 5678',
    recorded: true,
  });
  assert.deepEqual(describeDoxentAccount({ account: '+86 138-1234-5678', userId: 'u' }), {
    display: '138 **** 5678',
    recorded: true,
  });
  assert.deepEqual(describeDoxentAccount({ account: 'alice@example.com', userId: 'u' }), {
    display: 'al***@example.com',
    recorded: true,
  });
  assert.deepEqual(describeDoxentAccount({ account: '刘子谕', userId: 'u' }), {
    display: '刘子谕',
    recorded: true,
  });
  // 扫码 / 旧版会话没有 account：用 userId 尾号兜底，并明确标记不是官方记录的账号
  assert.deepEqual(describeDoxentAccount({ account: '', userId: '211029004152330250' }), {
    display: '用户 ID 2110 **** 0250',
    recorded: false,
  });
  assert.equal(describeDoxentAccount({ account: '', userId: '' }), null);
});

test('doxentAccountDisplay 从会话文件派生展示值；没有会话文件时返回 null', () => {
  const home = tempHome();
  const options = { env: {}, home };
  assert.equal(doxentAccountDisplay(options), null);

  writeDoxentSession({ ...SESSION, account: '13812345678' }, options);
  assert.deepEqual(doxentAccountDisplay(options), { display: '138 **** 5678', recorded: true });

  clearDoxentSession(options);
  assert.equal(doxentAccountDisplay(options), null);
});
