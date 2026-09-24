import test from 'node:test';
import assert from 'node:assert/strict';
import { applyServerUpdate } from './applyUpdate.ts';

function stubFetch(impl: () => Promise<unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('更新接口在 HTTP 层拒绝时按服务端原因报错，不谎报「连接中断」', async () => {
  const reason = '未挂载 Docker socket，无法自更新（需在 compose 中挂载 /var/run/docker.sock）';
  const restore = stubFetch(async () => new Response(JSON.stringify({ error: reason }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }));
  const lines: string[] = [];
  try {
    const result = await applyServerUpdate({ log: (line) => lines.push(line) });
    assert.equal(result.ok, false);
    assert.equal(result.error, reason);
    assert.equal(lines.some((line) => line.includes('连接中断')), false, 'HTTP 拒绝不该走「连接中断」文案');
  } finally {
    restore();
  }
});

test('请求体非 JSON 时仍给出可读的失败原因', async () => {
  const restore = stubFetch(async () => new Response('boom', { status: 502 }));
  try {
    const result = await applyServerUpdate({ log: () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'boom');
  } finally {
    restore();
  }
});

test('流真的断了才提示「可能仍在服务端执行」，避免重复触发更新', async () => {
  const restore = stubFetch(async () => {
    throw new TypeError('fetch failed');
  });
  try {
    const result = await applyServerUpdate({ log: () => {} });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /连接中断/);
  } finally {
    restore();
  }
});
