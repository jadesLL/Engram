import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDesktopInstallerUpdate, applyServerUpdate, isServerAlreadyLatest } from './applyUpdate.ts';

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

test('「已是最新」只认「版本没落后 + 镜像 digest 一致」，未知一律不谎报', () => {
  // 真正能确定不需要更新的组合
  assert.equal(isServerAlreadyLatest({ hasUpdate: false, digestMatch: true }), true);
  // main 通道：版本号与本地相同（hasUpdate=false），但镜像 digest 变了 —— 仍要更新
  assert.equal(isServerAlreadyLatest({ hasUpdate: false, digestMatch: false }), false);
  // digest 未知（Registry 没查成）时不能断言「已是最新」
  assert.equal(isServerAlreadyLatest({ hasUpdate: false, digestMatch: null }), false);
  assert.equal(isServerAlreadyLatest({ hasUpdate: false }), false);
  assert.equal(isServerAlreadyLatest({ hasUpdate: true, digestMatch: true }), false);
  assert.equal(isServerAlreadyLatest(null), false);
  assert.equal(isServerAlreadyLatest(undefined), false);
});

/** 临时挂上桌面桥（Node 里没有 window；结束后必须摘掉，避免影响其他测试） */
function stubDesktop(bridge: Record<string, any>): () => void {
  (globalThis as any).window = { wikiDesktop: bridge };
  return () => {
    delete (globalThis as any).window;
  };
}

test('后台自动更新正在下载时，手动「下载并安装」接手它的进度而不是报错', async () => {
  let downloaded = 0;
  let installed = 0;
  const restore = stubDesktop({
    desktopUpdateCheck: async () => { throw new Error('不该再检查一次'); },
    desktopUpdateDownload: async () => { downloaded += 1; return { ok: true, path: 'x.exe' }; },
    desktopUpdateRunInstaller: async () => { installed += 1; return true; },
    desktopUpdateGetState: async () => ({ phase: 'downloading', percent: 42, latestVersion: '1.5.21' }),
  });
  const lines: string[] = [];
  try {
    const result = await applyDesktopInstallerUpdate({ log: (line) => lines.push(line) });
    assert.equal(result.ok, true);
    assert.equal(result.busy, 'auto');
    assert.equal(result.error, undefined, '这不是失败，不能给用户看错误');
    assert.equal(result.state.percent, 42);
    assert.equal(downloaded, 0, '不能发起第二次下载（两者落盘同一个文件）');
    assert.equal(installed, 0, '自动更新会自己安装，不能再调一次安装器');
    assert.equal(lines.some((line) => line.includes('正在后台下载 42%')), true);
  } finally {
    restore();
  }
});

test('下载请求碰到忙标记时按「已有下载」处理，不报下载失败', async () => {
  const restore = stubDesktop({
    desktopUpdateCheck: async () => ({
      ok: true,
      hasUpdate: true,
      latestVersion: '1.5.21',
      exe: { url: 'https://example.invalid/x.exe' },
    }),
    desktopUpdateDownload: async () => ({ ok: false, busy: 'auto', state: { phase: 'downloading', percent: 7 } }),
    desktopUpdateRunInstaller: async () => true,
    desktopUpdateGetState: async () => ({ phase: 'idle' }),
  });
  try {
    const result = await applyDesktopInstallerUpdate({ log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.busy, 'auto');
    assert.equal(result.error, undefined, '主进程的 busy 是提示，不是错误');
    assert.equal(result.state.percent, 7);
  } finally {
    restore();
  }
});
