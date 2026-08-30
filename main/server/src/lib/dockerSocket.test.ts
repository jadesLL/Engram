import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

/**
 * fetchViaHostNetwork 的探针脚本在真实 node 进程里跑一遍：
 * 起本地 http 服务器当目标，用与容器内相同的环境变量注入方式执行脚本，
 * 断言单行 JSON 输出格式（status/body/error 三种形态）。
 * 容器创建/启停/清理由 e2e 预览环境用真实 docker.sock 验证。
 * 注意必须用异步 execFile：同步版本会阻塞父进程事件循环，
 * 父进程内的 http server 无法响应子进程的 fetch（探针 15s 超时假失败）。
 */

const run = promisify(execFile);

async function runProbe(url: string, auth = ''): Promise<unknown> {
  const { NET_PROBE_SCRIPT } = await import('./dockerSocket.js') as {
    NET_PROBE_SCRIPT: string;
  };
  const { stdout } = await run('node', ['-e', NET_PROBE_SCRIPT], {
    env: { ...process.env, ENGRAM_PROBE_URL: url, ENGRAM_PROBE_AUTH: auth },
    timeout: 30_000,
  });
  return JSON.parse(stdout.trim());
}

test('探针脚本请求成功路径输出 {status,body}（含鉴权头透传）', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'token t1');
    res.statusCode = 200;
    res.end('{"tag_name":"v9.9.9"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const parsed = (await runProbe(`http://127.0.0.1:${port}/api`, 'token t1')) as {
      status: number;
      body: string;
    };
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body, '{"tag_name":"v9.9.9"}');
  } finally {
    server.close();
  }
});

test('探针脚本非 2xx 状态码原样透传 status', async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const parsed = (await runProbe(`http://127.0.0.1:${port}/x`)) as { status: number; body: string };
    assert.equal(parsed.status, 404);
    assert.equal(parsed.body, 'not found');
  } finally {
    server.close();
  }
});

test('探针脚本网络失败输出 {error} 含底层原因', async () => {
  // 先占端口再释放，得到一个确定无人监听的端口（连接拒绝而非端口黑名单错误）
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  const parsed = (await runProbe(`http://127.0.0.1:${port}/x`)) as { error?: string };
  assert.ok(parsed.error, '应有 error 字段');
  assert.match(parsed.error, /ECONNREFUSED|fetch failed/);
});
