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
