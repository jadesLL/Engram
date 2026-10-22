import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDouyinDetailQuery,
  chooseDouyinMedia,
  DouyinApiError,
  estimateGearBytes,
  fetchDouyinDetail,
  parseDouyinDetail,
  probeDouyinMediaBytes,
  resetDouyinIdentityCache,
  signDouyinQuery,
} from './douyin.js';

/**
 * 抖音接口直取（无浏览器）：签名已知向量、detail 解析、匿名身份与重试、清晰度选择。
 * 全部用注入的 fetch 假实现，不联网。
 */

beforeEach(() => {
  resetDouyinIdentityCache();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function cookieResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'set-cookie': 'ttwid=ttwid-abc; Path=/; Domain=douyin.com' }),
    text: async () => JSON.stringify({ status_code: 0, message: 'register success' }),
  } as unknown as Response;
}

function homeResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'x-tt-trace-host': 'uifid-trace-123' }),
    body: { cancel: async () => undefined },
    text: async () => '<html></html>',
  } as unknown as Response;
}

function probeResponse(totalBytes: number): Response {
  return {
    ok: true,
    status: 206,
    headers: new Headers({ 'content-range': 'bytes 0-0/' + totalBytes, 'content-type': 'video/mp4' }),
    body: { cancel: async () => undefined },
    text: async () => '',
  } as unknown as Response;
}

const detailJson = {
  status_code: 0,
  aweme_detail: {
    desc: '测试抖音视频',
    author: { nickname: '作者A' },
    video: {
      duration: 120000,
      play_addr: { url_list: ['https://cdn.example.com/default.mp4'] },
      cover: { url_list: ['https://cdn.example.com/cover.jpg'] },
      bit_rate: [
        {
          gear_name: 'normal_1080_0',
          quality_type: 1,
          bit_rate: 3000000,
          play_addr: { url_list: ['https://cdn.example.com/1080.mp4'], width: 1920, height: 1080 },
        },
        {
          gear_name: 'normal_720_0',
          quality_type: 10,
          bit_rate: 500000,
          play_addr: { url_list: ['https://cdn.example.com/720.mp4'], width: 1280, height: 720 },
        },
        {
          gear_name: 'normal_480_0',
          quality_type: 4,
          bit_rate: 200000,
          play_addr: { url_list: ['https://cdn.example.com/480.mp4'], width: 854, height: 480 },
        },
      ],
    },
    images: [],
  },
};

test('buildDouyinDetailQuery / signDouyinQuery：参数顺序固定，签名是已知向量', () => {
  const query = buildDouyinDetailQuery('123456789', 'uifid-test', '1700000000');
  assert.equal(query, 'aweme_id=123456789&aid=6383&uifid=uifid-test&timestamp=1700000000');
  assert.equal(signDouyinQuery('uifid-test', '1700000000', query), '078386b4a4f7496bb665710b651a0841');
});

test('parseDouyinDetail：标题/作者/毫秒时长/清晰度/封面/图文都归一化', () => {
  const detail = parseDouyinDetail(detailJson, '7640385127511641382');
  assert.equal(detail.title, '测试抖音视频');
  assert.equal(detail.author, '作者A');
  assert.equal(detail.durationSec, 120);
  assert.equal(detail.defaultUrl, 'https://cdn.example.com/default.mp4');
  assert.equal(detail.coverUrl, 'https://cdn.example.com/cover.jpg');
  assert.deepEqual(
    detail.gears.map((gear) => gear.height),
    [1080, 720, 480]
  );
  assert.equal(detail.images.length, 0);

  const withImages = parseDouyinDetail(
    {
      status_code: 0,
      aweme_detail: {
        desc: '图文作品',
        video: { duration: 0, play_addr: { url_list: [] }, bit_rate: [] },
        images: [{ url_list: ['https://cdn.example.com/1.jpg'] }, { url_list: [] }],
      },
    },
    '1'
  );
  assert.deepEqual(withImages.images, ['https://cdn.example.com/1.jpg']);
  assert.equal(withImages.gears.length, 0);
});

test('parseDouyinDetail：没有详情（删除/私密）给可读错误', () => {
  assert.throws(
    () => parseDouyinDetail({ status_code: 0, aweme_detail: null }, '1'),
    (error: any) => error instanceof DouyinApiError && error.kind === 'not-found' && /没有返回视频详情/.test(error.message)
  );
});

test('fetchDouyinDetail：匿名身份 + secsdk 签名请求详情并解析', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/ttwid/register')) return cookieResponse();
    if (url === 'https://www.douyin.com/') return homeResponse();
    if (url.startsWith('https://www.douyin.com/aweme/v1/web/aweme/detail/')) return jsonResponse(detailJson);
    throw new Error('unexpected url: ' + url);
  }) as unknown as typeof fetch;

  const detail = await fetchDouyinDetail('7640385127511641382', {
    fetchImpl,
    now: () => 1700000000000,
  });
  assert.equal(detail.title, '测试抖音视频');
  assert.equal(detail.durationSec, 120);

  const detailCall = calls.find((call) => call.url.includes('/aweme/detail/'));
  assert.ok(detailCall, '应该请求详情接口');
  const parsed = new URL(detailCall!.url);
  assert.equal(parsed.searchParams.get('aweme_id'), '7640385127511641382');
  assert.equal(parsed.searchParams.get('aid'), '6383');
  assert.equal(parsed.searchParams.get('uifid'), 'uifid-trace-123');
  assert.equal(parsed.searchParams.get('timestamp'), '1700000000');
  const expectedSign = signDouyinQuery(
    'uifid-trace-123',
    '1700000000',
    buildDouyinDetailQuery('7640385127511641382', 'uifid-trace-123', '1700000000')
  );
  assert.equal(parsed.searchParams.get('x-secsdk-web-signature'), expectedSign);

  const headers = new Headers(detailCall!.init?.headers as any);
  assert.equal(headers.get('cookie'), 'ttwid=ttwid-abc');
  assert.equal(headers.get('uifid'), 'uifid-trace-123');
  assert.equal(headers.get('referer'), 'https://www.douyin.com/');
});

test('fetchDouyinDetail：403 Uifid Not Found 时刷新匿名身份重试一次', async () => {
  let detailAttempts = 0;
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    if (url.includes('/ttwid/register')) return cookieResponse();
    if (url === 'https://www.douyin.com/') return homeResponse();
    if (url.includes('/aweme/detail/')) {
      detailAttempts += 1;
      if (detailAttempts === 1) {
        return jsonResponse('Blocked by ArgusSecurityPlugin Uifid Not Found', 403);
      }
      return jsonResponse(detailJson);
    }
    throw new Error('unexpected url: ' + url);
  }) as unknown as typeof fetch;

  const detail = await fetchDouyinDetail('123456789', { fetchImpl, now: () => 1700000000000 });
  assert.equal(detail.title, '测试抖音视频');
  assert.equal(detailAttempts, 2, '身份被拒后应换身份重试一次');
});

test('fetchDouyinDetail：作品不可见（没有 aweme_detail）不重试，直接给可读错误', async () => {
  let detailAttempts = 0;
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    if (url.includes('/ttwid/register')) return cookieResponse();
    if (url === 'https://www.douyin.com/') return homeResponse();
    detailAttempts += 1;
    return jsonResponse({ status_code: 0, aweme_detail: null, filter_detail: { detail_msg: '作品不存在' } });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => fetchDouyinDetail('123456789', { fetchImpl, now: () => 1700000000000 }),
    (error: any) => error instanceof DouyinApiError && error.kind === 'not-found'
  );
  assert.equal(detailAttempts, 1);
});

test('estimateGearBytes / chooseDouyinMedia：按上限选不超体积的清晰度，优先目标高度', async () => {
  const detail = parseDouyinDetail(detailJson, '1');
  assert.equal(estimateGearBytes(detail.gears[1], detail.durationSec), 60_000_000);

  const fetchImpl = (async (input: any) => {
    const url = String(input);
    const size = url.includes('720') ? 60_000_000 : url.includes('480') ? 10_000_000 : 200_000_000;
    return probeResponse(size);
  }) as unknown as typeof fetch;

  const chosen = await chooseDouyinMedia(detail, {
    quality: 64,
    maxBytes: 90 * 1024 * 1024,
    fetchImpl,
  });
  assert.equal(chosen.gear?.height, 720);
  assert.equal(chosen.bytes, 60_000_000);
  assert.match(chosen.note, /抖音接口抓取/);
});

test('chooseDouyinMedia：估算超限时用 Range 探测校准，选更小档位', async () => {
  const detail = parseDouyinDetail(detailJson, '1');
  // 估算 720P 为 60MB，但真实体积 120MB（超 90MB 上限）；480P 真实 10MB
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    return probeResponse(url.includes('480') ? 10_000_000 : 120_000_000);
  }) as unknown as typeof fetch;

  const chosen = await chooseDouyinMedia(detail, {
    quality: 64,
    maxBytes: 90 * 1024 * 1024,
    fetchImpl,
  });
  assert.equal(chosen.gear?.height, 480);
  assert.equal(chosen.bytes, 10_000_000);
});

test('chooseDouyinMedia：最低清晰度也超上限时提前报内联上限，不下载', async () => {
  const detail = parseDouyinDetail(detailJson, '1');
  const fetchImpl = (async () => probeResponse(500_000_000)) as unknown as typeof fetch;
  await assert.rejects(
    () => chooseDouyinMedia(detail, { quality: 64, maxBytes: 90 * 1024 * 1024, fetchImpl }),
    (error: any) => error instanceof DouyinApiError && error.kind === 'too-large' && /超过内联上限/.test(error.message)
  );
});

test('probeDouyinMediaBytes：解析 Content-Range 总体积；失败返回 0', async () => {
  const okFetch = (async () => probeResponse(12_345_678)) as unknown as typeof fetch;
  assert.equal(await probeDouyinMediaBytes('https://cdn.example.com/a.mp4', { fetchImpl: okFetch }), 12_345_678);

  const failFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  assert.equal(await probeDouyinMediaBytes('https://cdn.example.com/a.mp4', { fetchImpl: failFetch }), 0);
});
