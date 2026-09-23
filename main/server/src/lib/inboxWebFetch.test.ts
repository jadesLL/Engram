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
