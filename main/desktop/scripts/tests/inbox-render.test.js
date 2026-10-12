// 收集箱渲染后抓取（桌面端）单测（node 原生 assert，无第三方依赖）：
//   node desktop/scripts/tests/inbox-render.test.js
// 覆盖：地址校验、等正文「比基线长出来」的判定、首轮没正文时重载一轮、异常时窗口一定被销毁。
const assert = require('node:assert/strict');
const { renderInboxUrl, assertRenderableUrl, CONTENT_GROWTH } = require('../../lib/inbox-render');

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/** 假窗口：按脚本顺序返回「可见文字长度」，取值脚本之外的调用返回快照。 */
function fakeWindow({ textLengths = [], snapshot = { html: '<html>ok</html>', title: 'T', url: 'https://example.com/final' }, loadError } = {}) {
  const state = { destroyed: false, loads: 0, loaded: null, probes: 0 };
  let index = 0;
  const win = {
    loadURL: async (url) => {
      state.loads += 1;
      state.loaded = url;
      if (loadError) throw loadError;
    },
    webContents: {
      executeJavaScript: async (expr) => {
        if (expr.includes('innerText')) {
          state.probes += 1;
          const value = textLengths[Math.min(index, textLengths.length - 1)];
          index += 1;
          return value;
        }
        return snapshot;
      },
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
  return { win, state };
}

const noSleep = async () => {};

test('只接受 http/https 地址，其它协议与带凭据的地址拒绝', () => {
  assert.equal(assertRenderableUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.throws(() => assertRenderableUrl('file:///C:/Windows/win.ini'), /http\/https/);
  assert.throws(() => assertRenderableUrl('javascript:alert(1)'), /http\/https/);
  assert.throws(() => assertRenderableUrl('https://user:pass@example.com/'), /用户名或密码/);
  assert.throws(() => assertRenderableUrl('不是地址'), /无效/);
});

test('等正文比基线长出来（0 不当基线、壳页导航文字当基线）：一轮就取快照并销毁窗口', async () => {
  // 0 = loadURL 刚返回时 body 还没就绪；238 = 壳页自带的导航/页脚文字；500 才说明正文渲染出来了
  const { win, state } = fakeWindow({ textLengths: [0, 238, 238, 238, 238 + CONTENT_GROWTH + 20] });
  const page = await renderInboxUrl({ createWindow: () => win, url: 'https://example.com/post', sleep: noSleep });
  assert.equal(state.loaded, 'https://example.com/post');
  assert.equal(state.loads, 1, '第一轮就拿到正文不该重载');
  assert.equal(page.html, '<html>ok</html>');
  assert.equal(page.url, 'https://example.com/final');
  assert.equal(state.destroyed, true);
  assert.ok(state.probes >= 5, '没长出来之前不能提前收工');
});

test('首轮只有壳（会话未建立）：自动重载一轮，第二轮拿到正文', async () => {
  // 首轮的轮询全是壳的 238；重载后正文才出现（实测：同一持久会话第二次访问才给正文）。
  // 这一例用真实计时（不注入 noSleep），让两轮的等待窗口真的分开。
  const filler = new Array(10).fill(238);
  const { win, state } = fakeWindow({ textLengths: [...filler, 238 + CONTENT_GROWTH + 1] });
  const page = await renderInboxUrl({
    createWindow: () => win,
    url: 'https://example.com/post',
    contentWaitMs: 40,
    pollMs: 5,
  });
  assert.equal(state.loads, 2, '首轮没等到正文要重载一次');
  assert.equal(page.html, '<html>ok</html>');
  assert.equal(state.destroyed, true);
});

test('两轮都等不到正文：取快照交给服务端判（不在这里硬失败）', async () => {
  const { win, state } = fakeWindow({ textLengths: [238] });
  const page = await renderInboxUrl({
    createWindow: () => win,
    url: 'https://example.com/expired-share',
    contentWaitMs: 20,
    pollMs: 1,
    sleep: noSleep,
  });
  assert.equal(state.loads, 2, '重载过一轮才放弃');
  assert.equal(page.html, '<html>ok</html>');
  assert.equal(state.destroyed, true);
});

test('加载失败时抛出原始错误且窗口销毁', async () => {
  const { win, state } = fakeWindow({ loadError: new Error('ERR_CONNECTION_RESET') });
  await assert.rejects(
    () => renderInboxUrl({ createWindow: () => win, url: 'https://example.com/', sleep: noSleep }),
    /ERR_CONNECTION_RESET/,
  );
  assert.equal(state.destroyed, true);
});

test('加载一直不返回（网络挂住）也算超时，窗口销毁', async () => {
  const state = { destroyed: false };
  const win = { loadURL: () => new Promise(() => {}), webContents: { executeJavaScript: async () => 0 }, destroy: () => { state.destroyed = true; } };
  await assert.rejects(
    () => renderInboxUrl({ createWindow: () => win, url: 'https://example.com/hang', timeoutMs: 20, sleep: noSleep }),
    /加载超时/,
  );
  assert.equal(state.destroyed, true);
});

test('渲染完成但没有 HTML 也算失败', async () => {
  const { win, state } = fakeWindow({
    textLengths: [0, 999],
    snapshot: { html: '', title: '', url: '' },
  });
  await assert.rejects(
    () => renderInboxUrl({ createWindow: () => win, url: 'https://example.com/', sleep: noSleep }),
    /没有拿到 HTML/,
  );
  assert.equal(state.destroyed, true);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${c.name}\n    ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`);
  if (failed) process.exit(1);
})();
