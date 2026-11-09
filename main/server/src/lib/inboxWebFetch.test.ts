import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Response, fetch as undiciFetch } from 'undici';
import { fetchInboxWebPage } from './inboxWebFetch.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-web-'));
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
const fakeFetch = (reply: Response) => (async () => reply) as typeof undiciFetch;
/** 取抓取失败时的错误对象（needs-render 这类分类在 code 字段上，message 断言不够） */
async function fetchFailure(operation: () => Promise<unknown>): Promise<any> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('预期抓取失败，但实际成功');
}

after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('网页抓取保存 HTML 原文、标题与最终来源地址', async () => {
  const target = path.join(temp, 'page.tmp');
  const html = '<!doctype html><title>甲 &amp; 乙</title><main>正文</main>';
  const result = await fetchInboxWebPage('https://example.com/story', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
  });
  assert.equal(result.title, '甲 & 乙');
  assert.equal(result.sourceUrl, 'https://example.com/story');
  assert.equal(result.bytes, Buffer.byteLength(html));
  const saved = fs.readFileSync(target, 'utf8');
  assert.ok(saved.startsWith(html));
  assert.match(saved, /Engram source URL: https:\/\/example.com\/story/);
});

test('每次重定向都重新校验地址，拒绝跳到私网', async () => {
  const target = path.join(temp, 'redirect.tmp');
  await assert.rejects(() => fetchInboxWebPage('https://example.com/', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } })),
  }), /私网|保留地址/);
  assert.equal(fs.existsSync(target), false);
});

test('重定向地址中的反斜杠不能借 URL 归一化绕过校验', async () => {
  const target = path.join(temp, 'backslash.tmp');
  await assert.rejects(() => fetchInboxWebPage('https://example.com/', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(null, { status: 302, headers: { location: 'http:\\127.0.0.1\\internal' } })),
  }), /重定向地址无效/);
  assert.equal(fs.existsSync(target), false);
});

test('非 HTML 响应不保存为网页', async () => {
  const target = path.join(temp, 'binary.tmp');
  await assert.rejects(() => fetchInboxWebPage('https://example.com/image', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response('binary', { headers: { 'content-type': 'application/octet-stream' } })),
  }), /没有返回 HTML/);
  assert.equal(fs.existsSync(target), false);
});

test('JS 空壳页（应用挂载点 + 没有正文）在抓取时就明确拒绝，不落盘', async () => {
  const target = path.join(temp, 'shell.tmp');
  const html = '<!doctype html><html><head><title>某站</title></head>'
    + '<body><div id="app"></div><script src="/assets/app.js"></script></body></html>';
  await assert.rejects(() => fetchInboxWebPage('https://example.com/post', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
  }), /JavaScript|正文/);
  assert.equal(fs.existsSync(target), false);
});

test('「导航/页脚也 SSR 出来」的壳页同样拒绝（实测 238 字符会骗过纯文字量判据）', async () => {
  const target = path.join(temp, 'chrome-shell.tmp');
  const nav = '首页 社区 加速器 语音 工坊 开放平台 加入我们 登录 返回 '.repeat(6); // ≈ 200+ 字符的壳
  const html = '<!doctype html><html><head><title>某站</title></head>'
    + `<body><div id="app" data-v-app=""><nav class="nav">${nav}</nav></div></body></html>`;
  await assert.rejects(() => fetchInboxWebPage('https://example.com/post', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
  }), /正文/);
  assert.equal(fs.existsSync(target), false);
});

test('空壳判定的对照：带应用挂载点但正文已经够长（服务端渲染）的页面照常保存', async () => {
  const target = path.join(temp, 'ssr.tmp');
  const sentences = '这篇帖子由服务端渲染，正文已经出现在静态 HTML 里，应当和普通网页一样保存下来。';
  const paragraph = sentences.repeat(30); // 远超 800 字符的下限
  const html = `<!doctype html><html><body><div id="app"><h1>标题</h1><p>${paragraph}</p></div></body></html>`;
  const result = await fetchInboxWebPage('https://example.com/post', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
  });
  assert.equal(result.bytes, Buffer.byteLength(html));
  assert.ok(fs.existsSync(target));
});

test('公众号页面 <title> 为空：用 og:title 命名，不再退化成 URL 随机串', async () => {
  const target = path.join(temp, 'wechat.tmp');
  const paragraph = '这是一篇公众号文章的正文，服务端渲染的静态 HTML 里已经包含完整内容。'.repeat(40);
  const html = '<!doctype html><html><head><title></title>'
    + '<meta property="og:title" content="IRT 对从站的要求"></head>'
    + '<body><h1 id="activity-name">IRT 对从站的要求</h1>'
    + '<div id="js_content"><p>' + paragraph + '</p></div></body></html>';
  const result = await fetchInboxWebPage('https://mp.weixin.qq.com/s/randomId', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
  });
  assert.equal(result.title, 'IRT 对从站的要求');
});

test('响应没声明字符集时按页面 meta 解码标题（GBK 老站不显示乱码）', async () => {
  const target = path.join(temp, 'gbk.tmp');
  const gbkTitle = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xea, 0xcc, 0xe2]); // 「中文标题」
  const gbkBody = Buffer.concat(Array.from({ length: 90 }, () => Buffer.from([0xd5, 0xfd, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd]))); // 「正文内容」×90
  const body = Buffer.concat([
    Buffer.from('<html><head><meta charset="gbk"><title>', 'latin1'),
    gbkTitle,
    Buffer.from('</title></head><body><p>', 'latin1'),
    gbkBody,
    Buffer.from('</p></body></html>', 'latin1'),
  ]);
  const result = await fetchInboxWebPage('https://example.com/gbk', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(body, { headers: { 'content-type': 'text/html' } })),
  });
  assert.equal(result.title, '中文标题');
  assert.equal(fs.existsSync(target), true);
});

test('反爬站点用 403/412/429/451 挡住服务端直抓：识别为 needs-render，不落临时文件', async () => {
  for (const status of [403, 412, 429, 451]) {
    const target = path.join(temp, 'anti-bot-' + status + '.tmp');
    const error = await fetchFailure(() => fetchInboxWebPage('https://www.zhihu.com/question/123456', target, {
      resolveHost: publicDns,
      fetchImpl: fakeFetch(new Response('<html><body>当前请求存在异常，暂时限制本次访问</body></html>', {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })),
    }));
    assert.equal(error.code, 'needs-render', 'HTTP ' + status + ' 应交给客户端内置浏览器渲染');
    assert.match(error.message, /反爬/);
    assert.match(error.message, /内置浏览器/);
    assert.match(error.message, new RegExp('HTTP ' + status));
    assert.equal(fs.existsSync(target), false, 'HTTP ' + status + ' 不应留下临时文件');
  }
});

test('404/410/500 是真实失败，仍然是 fetch-failed（不会被误判成反爬）', async () => {
  for (const status of [404, 410, 500]) {
    const target = path.join(temp, 'http-error-' + status + '.tmp');
    const error = await fetchFailure(() => fetchInboxWebPage('https://example.com/missing', target, {
      resolveHost: publicDns,
      fetchImpl: fakeFetch(new Response('not found', { status, headers: { 'content-type': 'text/html' } })),
    }));
    assert.equal(error.code, 'fetch-failed');
    assert.match(error.message, new RegExp('HTTP ' + status));
    assert.equal(fs.existsSync(target), false);
  }
});

test('200 的反爬拦截页（知乎 zse-ck / Cloudflare 挑战页）识别为 needs-render，不落盘', async () => {
  const pages = [
    '<!doctype html><html><head><meta id="zh-zse-ck" content="520-abc"><title>安全验证</title></head>'
      + '<body><div class="zse-ck-wrapper">请完成安全验证</div></body></html>',
    '<!doctype html><html><head><title>Just a moment...</title></head>'
      + '<body><div class="cf-browser-verification cf-im-under-attack">Checking your browser before accessing</div>'
      + '<script>window._cf_chl_opt={cvId:"3"}</script></body></html>',
  ];
  for (const [index, html] of pages.entries()) {
    const target = path.join(temp, 'interstitial-' + index + '.tmp');
    const error = await fetchFailure(() => fetchInboxWebPage('https://example.com/protected', target, {
      resolveHost: publicDns,
      fetchImpl: fakeFetch(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
    }));
    assert.equal(error.code, 'needs-render');
    assert.match(error.message, /反爬/);
    assert.equal(fs.existsSync(target), false);
  }
});

test('正常文章里出现「验证码 / 安全验证 / geetest」不会被误判为反爬拦截页', async () => {
  const target = path.join(temp, 'normal-captcha-words.tmp');
  const paragraph = '本文讲登录风控：先做安全验证，再输入验证码，站点用 geetest 组件做人机验证，这些都是正常产品流程的说明。';
  const html = '<!doctype html><html><head><title>登录风控设计 - 某技术站</title></head><body>'
    + '<main><h1>登录风控设计</h1><p>' + paragraph.repeat(20) + '</p></main></body></html>';
  const result = await fetchInboxWebPage('https://example.com/blog/captcha', target, {
    resolveHost: publicDns,
    fetchImpl: fakeFetch(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })),
  });
  // 其它站点的站名后缀保持原样（只有知乎分支会去掉）
  assert.equal(result.title, '登录风控设计 - 某技术站');
  assert.equal(result.bytes, Buffer.byteLength(html));
  assert.equal(fs.existsSync(target), true);
});
