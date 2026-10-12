import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * 收集箱「渲染后抓取」网页侧胶水的契约测试。
 *
 * 真正跑 WebView / Electron 的是原生侧；这里只测网页侧最容易坏的部分：
 *  - 没有桥时不能假装有（纯浏览器/Docker 要保留服务端的明确报错）；
 *  - 手机端桥是「同步调用 + 一次性回调」，要包成 Promise、按 requestId 对上号、还要能超时；
 *  - 渲染结果上传的打包口径（文件名回退、sourceUrl 字段、HTML 内容原样）。
 */

type Win = {
  wikiDesktop?: { renderInboxUrl?: (url: string) => Promise<{ html: string; title: string; url: string }> };
  EngramInboxRender?: { render(requestId: string, url: string): void };
  __engramInboxRenderResult?: (requestId: string, payload: string) => void;
};

const fakeWindow = (globalThis as { window?: Win }).window ?? {};
(globalThis as { window?: Win }).window = fakeWindow;

const mod = await import('./inboxRender.ts');

function resetWindow() {
  delete fakeWindow.wikiDesktop;
  delete fakeWindow.EngramInboxRender;
  delete fakeWindow.__engramInboxRenderResult;
}

test('没有桥时 localRenderer 返回 null（纯浏览器/Docker 不假装能渲染）', () => {
  resetWindow();
  assert.equal(mod.localRenderer(), null);
  assert.equal(mod.desktopRenderer(), null);
  assert.equal(mod.androidRenderer(), null);
});

test('桌面端桥：标签与渲染结果原样透传，失败也原样抛出', async () => {
  resetWindow();
  const page = { html: '<html>desktop</html>', title: '标题', url: 'https://example.com/final' };
  fakeWindow.wikiDesktop = {
    renderInboxUrl: async (url: string) => {
      assert.equal(url, 'https://example.com/post');
      return page;
    },
  };
  const renderer = mod.desktopRenderer();
  assert.equal(renderer?.label, '桌面端');
  assert.deepEqual(await renderer!.render('https://example.com/post'), page);

  fakeWindow.wikiDesktop = {
    renderInboxUrl: async () => {
      throw new Error('页面渲染超时');
    },
  };
  await assert.rejects(() => mod.desktopRenderer()!.render('https://example.com/post'), /渲染超时/);
});

test('手机端桥：按 requestId 对上号才结算，错误结果与解析失败都报错', async () => {
  resetWindow();
  const calls: string[] = [];
  fakeWindow.EngramInboxRender = {
    render(requestId, url) {
      calls.push(`${requestId} ${url}`);
      // 先来一个不相干的 requestId（模拟并发或迟到的旧回调），再回正确的
      fakeWindow.__engramInboxRenderResult?.('别的请求', JSON.stringify({ ok: true, html: 'x' }));
      fakeWindow.__engramInboxRenderResult?.(requestId, JSON.stringify({ ok: true, html: '<html>mobile</html>', title: '手机页', url: 'https://example.com/m' }));
    },
  };
  const renderer = mod.androidRenderer();
  assert.equal(renderer?.label, '手机端');
  const page = await renderer!.render('https://example.com/post');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^inbox-render-\d+-[a-z0-9]+ https:\/\/example\.com\/post$/);
  assert.deepEqual(page, { html: '<html>mobile</html>', title: '手机页', url: 'https://example.com/m' });

  fakeWindow.EngramInboxRender = {
    render(requestId) {
      fakeWindow.__engramInboxRenderResult?.(requestId, JSON.stringify({ ok: false, error: '页面加载失败' }));
    },
  };
  await assert.rejects(() => mod.androidRenderer()!.render('https://example.com/post'), /页面加载失败/);

  fakeWindow.EngramInboxRender = {
    render(requestId) {
      fakeWindow.__engramInboxRenderResult?.(requestId, '不是 JSON');
    },
  };
  await assert.rejects(() => mod.androidRenderer()!.render('https://example.com/post'), /无法解析/);
});

test('手机端桥：原生一直不回调就超时，回调处理器会被回收', async () => {
  resetWindow();
  fakeWindow.EngramInboxRender = { render() {} };
  await assert.rejects(() => mod.androidRenderer(30)!.render('https://example.com/slow'), /渲染超时/);
  assert.equal(fakeWindow.__engramInboxRenderResult, undefined);
});

test('渲染结果打包上传：标题当文件名、无标题退回域名、sourceUrl 与 HTML 原样带上', async () => {
  const form = mod.renderedPageForm(
    { html: '<html lang="zh">正文</html>', title: '小黑盒：某帖子', url: 'https://www.xiaoheihe.cn/final' },
    'https://www.xiaoheihe.cn/original',
  );
  const file = form.get('files') as File;
  assert.equal(file.name, '小黑盒：某帖子.html');
  assert.equal(file.type, 'text/html');
  assert.equal(await file.text(), '<html lang="zh">正文</html>');
  assert.equal(form.get('sourceUrl'), 'https://www.xiaoheihe.cn/final');

  const fallback = mod.renderedPageForm(
    { html: '<html></html>', title: '   ', url: 'https://news.example.com/a/b' },
    'https://news.example.com/a/b',
  );
  assert.equal((fallback.get('files') as File).name, 'news.example.com.html');
  assert.equal(fallback.get('sourceUrl'), 'https://news.example.com/a/b');
});
