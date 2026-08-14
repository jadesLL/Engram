import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFeishuEvent, isUrlVerification, parseEvent } from './feishu/events.js';
import { parseCardActions } from './feishu/message.js';
import { decodeFrame, encodeFrame, headersToRecord, type Frame } from './feishu/proto.js';

const sampleEvent = {
  schema: '2.0',
  header: {
    event_id: 'evt-abc',
    event_type: 'im.message.receive_v1',
    token: 'verify-token-xyz',
    app_id: 'cli_demo',
  },
  event: {
    sender: { sender_id: { open_id: 'ou_demo_user' }, sender_type: 'user' },
    message: {
      message_id: 'om_demo',
      chat_id: 'oc_demo',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"@_user_1 什么是 OpenClaw"}',
    },
  },
};

test('parseEvent 解析消息事件并剥离 @机器人 前缀', () => {
  const parsed = parseEvent(JSON.stringify(sampleEvent));
  assert.ok(isFeishuEvent(parsed));
  assert.equal(parsed.openId, 'ou_demo_user');
  assert.equal(parsed.messageId, 'om_demo');
  assert.equal(parsed.text, '什么是 OpenClaw');
  assert.equal(parsed.chatType, 'p2p');
});

test('parseEvent 解析 url_verification 校验挑战', () => {
  const parsed = parseEvent(JSON.stringify({ type: 'url_verification', challenge: 'cha-123' }));
  assert.ok(isUrlVerification(parsed));
  assert.equal(parsed.challenge, 'cha-123');
});

test('parseEvent 对非消息事件返回 null', () => {
  const parsed = parseEvent(
    JSON.stringify({ schema: '2.0', header: { event_type: 'contact.user.updated_v3' }, event: {} }),
  );
  assert.equal(parsed, null);
});

test('parseCardActions 解析审批/拒绝按钮 value', () => {
  const values = [
    JSON.stringify({ t: 'approve', runId: 'r1', toolCallId: 'tc1' }),
    JSON.stringify({ t: 'reject', runId: 'r1', toolCallId: 'tc2' }),
    'not-json',
    { invalid: true },
  ];
  const actions = parseCardActions(values);
  assert.equal(actions.length, 2);
  assert.equal(actions[0]!.t, 'approve');
  assert.equal(actions[1]!.t, 'reject');
  assert.equal(actions[0]!.toolCallId, 'tc1');
});

test('protobuf Frame 编解码往返', () => {
  const original: Frame = {
    seqId: 42,
    logId: 100,
    service: 7,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'msg-001' },
    ],
    payload: new TextEncoder().encode('{"hello":"world"}'),
    payloadEncoding: 'json',
  };
  const encoded = encodeFrame(original);
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.seqId, 42);
  assert.equal(decoded.logId, 100);
  assert.equal(decoded.service, 7);
  assert.equal(decoded.method, 1);
  assert.equal(decoded.headers.length, 2);
  assert.equal(decoded.headers[0]!.key, 'type');
  assert.equal(decoded.headers[0]!.value, 'event');
  assert.equal(decoded.headers[1]!.key, 'message_id');
  assert.equal(decoded.headers[1]!.value, 'msg-001');
  assert.equal(decoded.payloadEncoding, 'json');
  assert.deepEqual(Array.from(decoded.payload!), Array.from(original.payload!));
});

test('protobuf 控制帧（ping）编解码', () => {
  const ping: Frame = {
    seqId: 0,
    logId: 0,
    service: 0,
    method: 0,
    headers: [{ key: 'type', value: 'ping' }],
  };
  const decoded = decodeFrame(encodeFrame(ping));
  assert.equal(decoded.method, 0);
  const hdr = headersToRecord(decoded.headers);
  assert.equal(hdr.type, 'ping');
});

test('headersToRecord 把 header 数组转为 key→value', () => {
  const hdr = headersToRecord([
    { key: 'type', value: 'event' },
    { key: 'sum', value: '3' },
    { key: 'seq', value: '0' },
  ]);
  assert.equal(hdr.type, 'event');
  assert.equal(hdr.sum, '3');
  assert.equal(hdr.seq, '0');
});

test('protobuf 解码真实飞书帧（64 位 logID / service，曾报 varint too long）', () => {
  // 部署后从真实长连接抓到的数据帧头部（len=1273），logID 是 9 字节 varint，
  // 旧实现用 32 位移位在 shift=35 处抛 'varint too long'
  const head = Uint8Array.from([
    0x08, 0xad, 0x81, 0xab, 0xdd, 0x12, 0x10, 0x96, 0xc7, 0xa7, 0xc4, 0xee,
    0x83, 0xf0, 0xe5, 0x18, 0x18, 0xf6, 0x81, 0x80, 0x10, 0x20, 0x01,
  ]);
  const frame = decodeFrame(head);
  assert.equal(frame.seqId, 5027578029);
  assert.equal(frame.logId, 1786732916165436310);
  assert.equal(frame.service, 33554678);
  assert.equal(frame.method, 1);
});

test('protobuf 大 seqID 编码（ACK 回显 64 位值）', () => {
  const frame: Frame = {
    seqId: 5027578029,
    logId: 1786732916165436310,
    service: 33554678,
    method: 1,
    headers: [],
  };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.equal(decoded.seqId, 5027578029);
  assert.equal(decoded.logId, 1786732916165436310);
  assert.equal(decoded.service, 33554678);
  assert.equal(decoded.method, 1);
});
