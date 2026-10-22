import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildVideoLinkMarkdown,
  detectVideoLink,
  findLocalBrowser,
  parseVideoLinkMarkdown,
  prepareBilibiliMedia,
  resolveVideoLink,
  type VideoLinkInfo,
} from './videoLink.js';

/**
 * 视频链接模块：识别/归一化、占位稿 frontmatter 往返、B站元数据、清晰度降档与下载。
 * 网络与媒体响应全部用注入的 fetch 假实现（不联网、不依赖真实 B站）。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: new Headers({ location }),
    text: async () => '',
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

function binaryResponse(bytes: Buffer): Response {
  return new Response(bytes as any, {
    status: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) },
  });
}

test('detectVideoLink：B站完整地址/BV/av/b23 与抖音长链短链，普通网页返回 null', () => {
  assert.deepEqual(detectVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7'), {
    platform: 'bilibili',
    normalized: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  });
  assert.deepEqual(detectVideoLink('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&t=12'), {
    platform: 'bilibili',
    normalized: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2',
  });
  assert.deepEqual(detectVideoLink('https://m.bilibili.com/video/av170001'), {
    platform: 'bilibili',
    normalized: 'https://www.bilibili.com/video/av170001',
  });
  assert.deepEqual(detectVideoLink('BV1GJ411x7h7'), {
    platform: 'bilibili',
    normalized: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  });
  assert.deepEqual(detectVideoLink('av170001'), {
    platform: 'bilibili',
    normalized: 'https://www.bilibili.com/video/av170001',
  });
  assert.deepEqual(detectVideoLink('https://b23.tv/abc123'), {
    platform: 'bilibili',
    normalized: 'https://b23.tv/abc123',
  });
  assert.deepEqual(detectVideoLink('b23.tv/abc123'), {
    platform: 'bilibili',
    normalized: 'https://b23.tv/abc123',
  });

  assert.deepEqual(detectVideoLink('https://www.douyin.com/video/7298145681699622182'), {
    platform: 'douyin',
    normalized: 'https://www.douyin.com/video/7298145681699622182',
  });
  assert.deepEqual(detectVideoLink('https://v.douyin.com/iRNBho6u/'), {
    platform: 'douyin',
    normalized: 'https://v.douyin.com/iRNBho6u/',
  });
  assert.deepEqual(detectVideoLink('v.douyin.com/iRNBho6u/'), {
    platform: 'douyin',
    normalized: 'https://v.douyin.com/iRNBho6u/',
  });
  assert.equal(detectVideoLink('https://www.iesdouyin.com/share/video/7298145681699622182/')?.platform, 'douyin');

  // 普通网页/文章/空间页/非 http 链接都不是视频链接
  assert.equal(detectVideoLink('https://example.com/post/1'), null);
  assert.equal(detectVideoLink('https://www.bilibili.com/read/cv123456'), null);
  assert.equal(detectVideoLink('https://space.bilibili.com/123456'), null);
  assert.equal(detectVideoLink('随便一段文字'), null);
  assert.equal(detectVideoLink(''), null);
  assert.equal(detectVideoLink('javascript:alert(1)'), null);
  assert.equal(detectVideoLink('ftp://www.bilibili.com/video/BV1GJ411x7h7'), null);
});

test('占位稿 frontmatter：build 与 parse 往返一致，标题里的换行被压平', () => {
  const markdown = buildVideoLinkMarkdown({
    platform: 'bilibili',
    link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    title: '测试视频：标题带冒号',
  });
  assert.match(markdown, /^---\n类型: video-link\n平台: bilibili\n链接: https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7\n标题: 测试视频：标题带冒号\n---\n/);
  assert.match(markdown, /视频链接：https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7/);
  assert.deepEqual(parseVideoLinkMarkdown(markdown), {
    platform: 'bilibili',
    link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    title: '测试视频：标题带冒号',
  });

  const douyin = buildVideoLinkMarkdown({
    platform: 'douyin',
    link: 'https://www.douyin.com/video/7298145681699622182',
    title: '第一行\n第二行',
  });
  assert.equal(parseVideoLinkMarkdown(douyin)?.title, '第一行 第二行');
  assert.equal(parseVideoLinkMarkdown(douyin)?.platform, 'douyin');

  // CRLF 的 frontmatter 也能读（Windows 上手工编辑过的占位稿）
  const crlf = markdown.replace(/\n/g, '\r\n');
  assert.equal(parseVideoLinkMarkdown(crlf)?.title, '测试视频：标题带冒号');

  // 不是视频链接稿
  assert.equal(parseVideoLinkMarkdown('# 普通笔记\n\n没有 frontmatter'), null);
  assert.equal(parseVideoLinkMarkdown('---\n类型: note\n标题: x\n---\n'), null);
  assert.equal(parseVideoLinkMarkdown('---\n类型: video-link\n平台: youtube\n链接: https://x\n标题: x\n---\n'), null);
  assert.equal(parseVideoLinkMarkdown('---\n类型: video-link\n平台: bilibili\n链接: 不是链接\n标题: x\n---\n'), null);
});

test('resolveVideoLink：B站 view 接口取标题/UP主/时长/cid，并带 referer', async () => {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
      code: 0,
      message: '0',
      data: {
        bvid: 'BV1GJ411x7h7',
        aid: 170001,
        cid: 137649199,
        duration: 213,
        title: '测试视频标题',
        owner: { name: '测试UP主' },
        pages: [{ cid: 137649199 }],
      },
    });
  }) as unknown as typeof fetch;

  const info = await resolveVideoLink('BV1GJ411x7h7', { fetchImpl });
  assert.equal(info.platform, 'bilibili');
  assert.equal(info.title, '测试视频标题');
  assert.equal(info.author, '测试UP主');
  assert.equal(info.durationSec, 213);
  assert.equal(info.bvid, 'BV1GJ411x7h7');
  assert.equal(info.cid, 137649199);
  assert.equal(info.link, 'https://www.bilibili.com/video/BV1GJ411x7h7');

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.bilibili\.com\/x\/web-interface\/view\?bvid=BV1GJ411x7h7$/);
  assert.equal(calls[0].init.headers.referer, 'https://www.bilibili.com');
});

test('resolveVideoLink：b23.tv 短链先解跳转再取元数据', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('b23.tv')) return redirectResponse('https://www.bilibili.com/video/BV1GJ411x7h7');
    return jsonResponse({
      code: 0,
      data: { bvid: 'BV1GJ411x7h7', cid: 137649199, duration: 60, title: '短链视频', owner: { name: 'UP' } },
    });
  }) as unknown as typeof fetch;

  const info = await resolveVideoLink('https://b23.tv/abc123', { fetchImpl });
  assert.equal(info.bvid, 'BV1GJ411x7h7');
  assert.equal(info.title, '短链视频');
  assert.equal(urls.length, 2, '一次解短链 + 一次 view 接口');
  assert.match(urls[1], /web-interface\/view\?bvid=BV1GJ411x7h7/);
});

test('resolveVideoLink：B站接口报错时给中文可操作原因', async () => {
  const fetchImpl = (async () => jsonResponse({ code: -404, message: '啥都木有', data: null })) as unknown as typeof fetch;
  await assert.rejects(() => resolveVideoLink('BV1GJ411x7h7', { fetchImpl }), (error: any) => {
    assert.match(error.message, /B站接口返回失败/);
    assert.match(error.message, /啥都木有/);
    assert.match(error.message, /已删除|仅登录可见|风控/);
    return true;
  });
});

test('resolveVideoLink：抖音直链不联网即可得到 aweme_id，短链靠 302 解出', async () => {
  const noNetwork = (async () => {
    throw new Error('直链不应该联网');
  }) as unknown as typeof fetch;
  const direct = await resolveVideoLink('https://www.douyin.com/video/7298145681699622182', { fetchImpl: noNetwork });
  assert.equal(direct.platform, 'douyin');
  assert.equal(direct.awemeId, '7298145681699622182');
  assert.equal(direct.link, 'https://www.douyin.com/video/7298145681699622182');

  const calls: string[] = [];
  const fetchImpl = (async (input: any) => {
    calls.push(String(input));
    return redirectResponse('https://www.douyin.com/video/7298145681699622182?previous_page=app_code_link');
  }) as unknown as typeof fetch;
  const short = await resolveVideoLink('https://v.douyin.com/iRNBho6u/', { fetchImpl });
  assert.equal(short.platform, 'douyin');
  assert.equal(short.awemeId, '7298145681699622182');
  assert.equal(calls.length, 1);
});

test('resolveVideoLink：抖音短链解析不出 id 时给中文原因', async () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => '<html></html>',
    body: { cancel: async () => undefined },
  })) as unknown as typeof fetch;
  await assert.rejects(
    () => resolveVideoLink('https://v.douyin.com/broken-link/', { fetchImpl }),
    /没能从抖音链接解析出视频 id/
  );
});

test('prepareBilibiliMedia：durl.size 超过上限时自动降档（64 → 32）并下载合并 mp4', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-video-link-'));
  const destPath = path.join(temp, 'BV1GJ411x7h7.mp4');
  const media = Buffer.from('fake-mp4-bytes-for-download-test');
  const playurlCalls: number[] = [];
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    if (url.includes('/x/player/playurl')) {
      const qn = Number(new URL(url).searchParams.get('qn'));
      playurlCalls.push(qn);
      if (qn === 64) {
        return jsonResponse({ code: 0, data: { durl: [{ url: 'https://cdn.example/64.mp4', size: 2 * 1024 * 1024 }] } });
      }
      return jsonResponse({ code: 0, data: { durl: [{ url: 'https://cdn.example/32.mp4', size: 300 * 1024 }] } });
    }
    if (url === 'https://cdn.example/32.mp4') return binaryResponse(media);
    throw new Error('不该请求：' + url);
  }) as unknown as typeof fetch;

  const info: VideoLinkInfo = {
    platform: 'bilibili',
    link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    title: '降档测试',
    durationSec: 213,
    author: 'UP',
    bvid: 'BV1GJ411x7h7',
    cid: 137649199,
  };
  try {
    const prepared = await prepareBilibiliMedia(info, {
      quality: 64,
      destPath,
      fetchImpl,
      maxBytes: 1024 * 1024,
    });
    assert.deepEqual(playurlCalls, [64, 32], '64 超限后应尝试 32');
    assert.equal(prepared.bytes, media.length);
    assert.equal(prepared.mime, 'video/mp4');
    assert.equal(prepared.platform, 'bilibili');
    assert.equal(prepared.durationSec, 213);
    assert.match(prepared.note || '', /480P/, '降档后 note 要说明实际清晰度');
    assert.match(prepared.note || '', /自动降档/);
    assert.deepEqual(fs.readFileSync(destPath), media);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('prepareBilibiliMedia：所有清晰度都超限时给中文建议（换 360P/更短视频）', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-video-link-'));
  const destPath = path.join(temp, 'too-large.mp4');
  const fetchImpl = (async () =>
    jsonResponse({ code: 0, data: { durl: [{ url: 'https://cdn.example/big.mp4', size: 10 * 1024 * 1024 }] } })) as unknown as typeof fetch;
  try {
    await assert.rejects(
      () =>
        prepareBilibiliMedia(
          {
            platform: 'bilibili',
            link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
            title: '超大视频',
            durationSec: 600,
            author: '',
            bvid: 'BV1GJ411x7h7',
            cid: 1,
          },
          { quality: 32, destPath, fetchImpl, maxBytes: 1024 }
        ),
      (error: any) => {
        assert.match(error.message, /超过下载上限/);
        assert.match(error.message, /360P|更短的视频/);
        return true;
      }
    );
    assert.equal(fs.existsSync(destPath), false, '失败不应留下半截文件');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('prepareBilibiliMedia：缺少 cid 时给出可操作中文原因', async () => {
  await assert.rejects(
    () =>
      prepareBilibiliMedia(
        { platform: 'bilibili', link: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: 'x', durationSec: 1, author: '', bvid: 'BV1GJ411x7h7' },
        { quality: 64, destPath: path.join(os.tmpdir(), 'never-written.mp4') }
      ),
    /缺少 B站 cid/
  );
});

test('findLocalBrowser：返回本机浏览器路径或 null（不抛错）', () => {
  const browser = findLocalBrowser();
  assert.ok(browser === null || (typeof browser === 'string' && browser.length > 0));
});
