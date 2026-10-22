import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsoleRpcError, createConsoleRpc, type ConsoleTransport, type ConsoleHttpResponse } from './agentConsoleRpc.js';

const ORIGIN = 'http://127.0.0.1:18180';
const TARGET = { port: 45678, token: 'launch-token-abc' };

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

function makeTransport(handler: (request: Recorded) => ConsoleHttpResponse | Promise<ConsoleHttpResponse>) {
  const requests: Recorded[] = [];
  const transport: ConsoleTransport = async (options) => {
    const request: Recorded = {
      method: options.method,
      path: options.path,
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    };
    requests.push(request);
    return handler(request);
  };
  return { transport, requests };
}

function ok(value: unknown): ConsoleHttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value } }),
  };
}

function failure(code: string, message: string): ConsoleHttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: false, error: { code, message, details: {} } } }),
  };
}

function cookieResponse(): ConsoleHttpResponse {
  return {
    status: 303,
    headers: {
      location: './',
      'set-cookie': ['dsh-auth-abc=secret-cookie; Path=/; HttpOnly'],
    },
    body: '',
  };
}

test('token 兑换 cookie 后按 client-request 信封调用 endpoint', async () => {
  const { transport, requests } = makeTransport((request) => {
    if (request.method === 'GET') return cookieResponse();
    return ok({ hello: 'world' });
  });
  const rpc = createConsoleRpc({ getTarget: () => TARGET, transport });
  const value = await rpc.call(ORIGIN, 'settings/describe', {});
  assert.deepEqual(value, { hello: 'world' });
  assert.equal(requests.length, 2);
  const get = requests[0];
  assert.equal(get.method, 'GET');
  assert.equal(get.path, '/?token=launch-token-abc');
  assert.equal(get.headers.Host, '127.0.0.1:18180');
  const post = requests[1];
  assert.equal(post.method, 'POST');
  assert.equal(post.path, '/api/settings/describe');
  assert.equal(post.headers.Host, '127.0.0.1:18180');
  assert.equal(post.headers.Origin, ORIGIN);
  assert.equal(post.headers.Cookie, 'dsh-auth-abc=secret-cookie');
  const envelope = JSON.parse(post.body as string);
  assert.equal(envelope.type, 'client-request');
  assert.equal(envelope.method, 'settings/describe');
  assert.deepEqual(envelope.payload, { args: {} });
  assert.equal(typeof envelope.rpcId, 'string');
});

test('同一 authority 复用 cookie，不重复兑换', async () => {
  const { transport, requests } = makeTransport((request) => (request.method === 'GET' ? cookieResponse() : ok(1)));
  const rpc = createConsoleRpc({ getTarget: () => TARGET, transport });
  await rpc.call(ORIGIN, 'settings/describe', {});
  await rpc.call(ORIGIN, 'pluginManager/listBundles', {});
  assert.equal(requests.filter((item) => item.method === 'GET').length, 1);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 2);
});

test('401 时重新兑换 cookie 并重试一次', async () => {
  let postCount = 0;
  const { transport, requests } = makeTransport((request) => {
    if (request.method === 'GET') return cookieResponse();
    postCount += 1;
    return postCount === 1
      ? { status: 401, headers: {}, body: 'unauthorized' }
      : ok('retried');
  });
  const rpc = createConsoleRpc({ getTarget: () => TARGET, transport });
  assert.equal(await rpc.call(ORIGIN, 'settings/describe', {}), 'retried');
  assert.equal(requests.filter((item) => item.method === 'GET').length, 2);
});

test('连续 401 抛 console-auth', async () => {
  const { transport } = makeTransport((request) => (request.method === 'GET'
    ? cookieResponse()
    : { status: 401, headers: {}, body: 'unauthorized' }));
  const rpc = createConsoleRpc({ getTarget: () => TARGET, transport });
  await assert.rejects(
    () => rpc.call(ORIGIN, 'settings/describe', {}),
    (error: unknown) => error instanceof ConsoleRpcError && error.code === 'console-auth',
  );
});

test('DSH 业务错误透传；revision 冲突映射成 409', async () => {
  const { transport } = makeTransport((request) => (request.method === 'GET'
    ? cookieResponse()
    : failure('settings/conflict', 'settings were modified by another writer')));
  const rpc = createConsoleRpc({ getTarget: () => TARGET, transport });
  await assert.rejects(
    () => rpc.call(ORIGIN, 'settings/mutate', { ns: 'x', ops: [] }),
    (error: unknown) => error instanceof ConsoleRpcError && error.status === 409 && error.code === 'revision-conflict',
  );
});

test('控制台未启动时直接 503，不发请求', async () => {
  const { transport, requests } = makeTransport(() => ok(1));
  const rpc = createConsoleRpc({ getTarget: () => null, transport });
  await assert.rejects(
    () => rpc.call(ORIGIN, 'settings/describe', {}),
    (error: unknown) => error instanceof ConsoleRpcError && error.status === 503 && error.code === 'console-unavailable',
  );
  assert.equal(requests.length, 0);
});

test('非法 endpoint 直接 400', async () => {
  const { transport } = makeTransport(() => ok(1));
  const rpc = createConsoleRpc({ getTarget: () => TARGET, transport });
  await assert.rejects(
    () => rpc.call(ORIGIN, '../etc/passwd', {}),
    (error: unknown) => error instanceof ConsoleRpcError && error.status === 400 && error.code === 'bad-endpoint',
  );
});
