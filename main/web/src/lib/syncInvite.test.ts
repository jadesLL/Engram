import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInviteLink,
  describeInvite,
  maskInviteToken,
  normalizeHubUrl,
  parseInviteLink,
} from './syncInvite.ts';

/**
 * 邀请链接的编解码：中枢生成、成员端粘贴/扫码消费。
 *
 * 这里钉住的是「免手抄」这件事的底线——**解析不出来就返回 null**，绝不把半截值填进表单；
 * 同时要容忍真实粘贴场景里带的前后文字与中文标点（聊天软件、截图 OCR 都会带）。
 * 令牌是真令牌：54 个字符，错一位就绑定失败，所以解析必须严进宽出。
 */

const TOKEN = 'lsync_' + 'a1b2c3d4'.repeat(6);
const HUB = 'http://192.168.31.100:18080';

test('生成 → 解析：往返得到同样的地址与令牌', () => {
  const link = buildInviteLink({ hubUrl: HUB, token: TOKEN, name: 'B 电脑' });
  assert.match(link, /^engram:\/\/join\?/);
  const parsed = parseInviteLink(link);
  assert.ok(parsed);
  assert.equal(parsed.hubUrl, HUB);
  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.name, 'B 电脑');
});

test('链接固定以 hub → token → name → v 排序：同样信息永远是同一条链接', () => {
  const a = buildInviteLink({ hubUrl: HUB, token: TOKEN });
  const b = buildInviteLink({ hubUrl: HUB + '/', token: TOKEN });
  assert.equal(a, b);
  assert.ok(a.indexOf('hub=') < a.indexOf('token='));
  assert.ok(!a.includes('name='));
});

test('地址归一化：补默认协议、去结尾斜杠、丢掉查询串与 fragment', () => {
  assert.equal(normalizeHubUrl('192.168.31.100:18080'), 'http://192.168.31.100:18080');
  assert.equal(normalizeHubUrl('http://192.168.31.100:18080/'), 'http://192.168.31.100:18080');
  assert.equal(normalizeHubUrl('https://engram.xxx.com/engram/?a=1#b'), 'https://engram.xxx.com/engram');
});

test('粘贴的链接夹在说明文字里也能认出来（微信/备忘录复制常态）', () => {
  const link = buildInviteLink({ hubUrl: HUB, token: TOKEN, name: '手机' });
  const text = `【Engram 邀请】把这台设备加入同步群组：${link} ，点开或粘贴到「绑定中枢」。`;
  const parsed = parseInviteLink(text);
  assert.ok(parsed);
  assert.equal(parsed!.hubUrl, HUB);
  assert.equal(parsed!.token, TOKEN);
});

test('容忍短参数名与「只复制了查询串」两种情况', () => {
  const shortName = parseInviteLink(`engram://join?u=${encodeURIComponent(HUB)}&t=${TOKEN}`);
  assert.equal(shortName?.hubUrl, HUB);
  assert.equal(shortName?.token, TOKEN);

  const queryOnly = parseInviteLink(`hub=${encodeURIComponent(HUB)}&token=${TOKEN}`);
  assert.equal(queryOnly?.hubUrl, HUB);
  assert.equal(queryOnly?.token, TOKEN);
});

test('不是邀请链接的输入一律返回 null（不往表单里填半截值）', () => {
  assert.equal(parseInviteLink(''), null);
  assert.equal(parseInviteLink('   '), null);
  assert.equal(parseInviteLink('随便一段话'), null);
  assert.equal(parseInviteLink('http://192.168.31.100:18080'), null);
  // 只有地址、没有令牌
  assert.equal(parseInviteLink(`engram://join?hub=${encodeURIComponent(HUB)}`), null);
  // 令牌里有空白 / 太短
  assert.equal(parseInviteLink(`engram://join?hub=${encodeURIComponent(HUB)}&token=lsync aa`), null);
  assert.equal(parseInviteLink(`engram://join?hub=${encodeURIComponent(HUB)}&token=abc`), null);
  // 中枢地址不是 http/https，或带账号密码
  assert.equal(parseInviteLink(`engram://join?hub=ftp%3A%2F%2F192.168.31.100&token=${TOKEN}`), null);
  assert.equal(parseInviteLink(`engram://join?hub=${encodeURIComponent('http://user:pass@192.168.31.100:18080')}&token=${TOKEN}`), null);
  // 超长输入直接判非链接
  assert.equal(parseInviteLink('engram://join?' + 'hub=x&'.repeat(500)), null);
});

test('摘要与掩码：默认不暴露完整令牌', () => {
  const link = buildInviteLink({ hubUrl: HUB, token: TOKEN, name: 'B 电脑' });
  const parsed = parseInviteLink(link)!;
  const summary = describeInvite(parsed);
  assert.ok(summary.includes(HUB));
  assert.ok(summary.includes('B 电脑'));
  assert.ok(!summary.includes(TOKEN));
  assert.equal(maskInviteToken(TOKEN), `${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}`);
  assert.equal(maskInviteToken('short'), '•••••');
});
