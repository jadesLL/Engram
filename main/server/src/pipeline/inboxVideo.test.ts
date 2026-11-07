import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVideoLinkMarkdown } from '../lib/videoLink.js';
import { resetDouyinIdentityCache } from '../lib/douyin.js';

/**
 * 视频提炼管线：提示词结构、data URL MIME、内联上限文案、配置/占位稿的前置报错。
 * 不联网：所有转换用例都在「模型请求之前」失败，或只调纯函数。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-video-'));
process.env.DATA_DIR = temp;

let BRAIN_DIR = '';
let db: any;
let convertVideoInboxItem: typeof import('./inboxVideo.js').convertVideoInboxItem;
let buildVideoMessages: typeof import('./inboxVideo.js').buildVideoMessages;
let buildSubtitleMessages: typeof import('./inboxVideo.js').buildSubtitleMessages;
let buildImageMessages: typeof import('./inboxVideo.js').buildImageMessages;
let videoMime: typeof import('./inboxVideo.js').videoMime;
let assertVideoInlineable: typeof import('./inboxVideo.js').assertVideoInlineable;
let videoInlineLimitBytes: typeof import('./inboxVideo.js').videoInlineLimitBytes;

/** 可用的视频理解开关（模型来自 dsh 配置，测试里直接注入解析结果，不真正发请求） */
const readyConfig = { enabled: true } as any;

/** 解析后的模型配置（等价于内置 Agent 控制台里的 DashScope / qwen3.8-omni-flash） */
const readyModel = {
  providerId: 'dashscope',
  providerName: '阿里云百炼（DashScope）',
  baseUrl: 'https://video.example.com/v1',
  api: 'openai-completions',
  model: 'mock-video',
  apiKey: 'test-key',
  keyRef: 'DASHSCOPE_API_KEY',
} as any;

/** 任一网络调用都直接失败：用来证明前置错误发生在网络请求之前 */
const noNetwork = (async () => {
  throw new Error('这个用例不应该发起网络请求');
}) as unknown as typeof fetch;

before(async () => {
  const configModule = await import('../config.js');
  BRAIN_DIR = configModule.BRAIN_DIR;
  configModule.ensureDirs();
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({
    convertVideoInboxItem,
    buildVideoMessages,
    buildSubtitleMessages,
    buildImageMessages,
    videoMime,
    assertVideoInlineable,
    videoInlineLimitBytes,
  } = await import('./inboxVideo.js'));
});

after(async () => {
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(BRAIN_DIR, '收集箱', '转换结果'), { recursive: true, force: true });
  fs.mkdirSync(path.join(BRAIN_DIR, '收集箱', '转换结果'), { recursive: true });
});

function plant(relPath: string, content: string | Buffer): string {
  const abs = path.join(BRAIN_DIR, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return relPath;
}

test('videoMime：按扩展名给出正确的 data URL MIME（音频/video 各自正确）', () => {
  assert.equal(videoMime('收集箱/现场.mp4'), 'video/mp4');
  assert.equal(videoMime('收集箱/现场.MOV'), 'video/quicktime');
  assert.equal(videoMime('收集箱/录屏.webm'), 'video/webm');
  assert.equal(videoMime('收集箱/会议.mkv'), 'video/x-matroska');
  assert.equal(videoMime('收集箱/录音.mp3'), 'audio/mpeg');
  assert.equal(videoMime('收集箱/录音.m4a'), 'audio/mp4');
  assert.equal(videoMime('收集箱/未知扩展.xyz'), 'video/mp4', '未知扩展名按 video/mp4 兜底');
});

test('buildVideoMessages：system 是固定结构，user 带元信息与 video_url data URL', () => {
  const messages = buildVideoMessages(
    {
      title: '测试视频',
      author: '测试UP',
      durationSec: 213,
      platform: 'bilibili',
      link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
      bytes: 1024,
    },
    { mime: 'video/mp4', base64: 'QUJD' }
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  const system = String(messages[0].content);
  for (const heading of [
    '## 一句话总结',
    '## 内容脉络',
    '## 关键要点',
    '## 待办 / 行动项',
    '## 金句与关键数据',
    '## 不确定或听不清',
  ]) {
    assert.ok(system.includes(heading), '系统提示词缺少固定结构：' + heading);
  }
  assert.match(system, /\[mm:ss\]/);
  assert.match(system, /只写视频里真实存在的信息/);
  assert.match(system, /宁缺勿造/);

  assert.equal(messages[1].role, 'user');
  const parts = messages[1].content as any[];
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, 'text');
  const userText = String(parts[0].text);
  assert.match(userText, /标题：测试视频/);
  assert.match(userText, /作者：测试UP/);
  assert.match(userText, /时长：3 分 33 秒/);
  assert.match(userText, /平台：B站/);
  assert.match(userText, /链接：https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7/);
  assert.match(userText, /视频随消息附上/);

  assert.equal(parts[1].type, 'video_url');
  assert.equal(parts[1].video_url.url, 'data:video/mp4;base64,QUJD');
});

test('buildVideoMessages：音频原件用 audio/* 的 data URL，本地视频平台标注正确', () => {
  const messages = buildVideoMessages(
    { title: '会议录音', platform: 'upload', bytes: 10 },
    { mime: 'audio/mpeg', base64: 'AAAA' }
  );
  const parts = messages[1].content as any[];
  assert.equal(parts[1].video_url.url, 'data:audio/mpeg;base64,AAAA');
  assert.match(String(parts[0].text), /平台：本地视频/);
});

test('内联上限：默认 90MB、VIDEO_INLINE_MB 可覆盖；超限给可操作中文错误', () => {
  assert.equal(videoInlineLimitBytes({}), 90 * 1024 * 1024);
  assert.equal(videoInlineLimitBytes({ VIDEO_INLINE_MB: '1' }), 1024 * 1024);
  assert.equal(videoInlineLimitBytes({ VIDEO_INLINE_MB: '12.5' }), Math.floor(12.5 * 1024 * 1024));
  assert.equal(videoInlineLimitBytes({ VIDEO_INLINE_MB: '0' }), 90 * 1024 * 1024, '非法值回退默认');
  assert.equal(videoInlineLimitBytes({ VIDEO_INLINE_MB: 'abc' }), 90 * 1024 * 1024);

  const limit = 90 * 1024 * 1024;
  assert.doesNotThrow(() => assertVideoInlineable(limit, limit));
  assert.throws(
    () => assertVideoInlineable(limit + 1, limit),
    (error: any) => {
      assert.match(error.message, /超过内联上限/);
      assert.match(error.message, /缩短视频时长|360P|截取片段/);
      return true;
    }
  );
});

test('未启用视频理解：直接抛设置提示，不读媒体也不联网', async () => {
  await assert.rejects(
    () =>
      convertVideoInboxItem('收集箱/任意.mp4', {
        config: { enabled: false },
        model: readyModel,
        fetchImpl: noNetwork,
      }),
    /视频理解未启用/
  );
});

test('抖音占位稿：接口抓取失败时给出可操作提示，不发起模型请求', async () => {
  const placeholder = plant(
    '收集箱/抖音测试.md',
    buildVideoLinkMarkdown({
      platform: 'douyin',
      link: 'https://www.douyin.com/video/7298145681699622182',
      title: '抖音测试',
    })
  );
  await assert.rejects(
    () =>
      convertVideoInboxItem(placeholder, {
        config: readyConfig,
        model: readyModel,
        fetchImpl: noNetwork,
      }),
    (error: any) => {
      assert.match(error.message, /抖音接口抓取失败/);
      assert.match(error.message, /抖音接口可能已变更/);
      return true;
    }
  );
});

test('本地音视频超过内联上限：转换前就报错，不发起模型请求', async () => {
  const rel = plant('收集箱/大视频.mp4', Buffer.alloc(2048));
  const previous = process.env.VIDEO_INLINE_MB;
  process.env.VIDEO_INLINE_MB = '0.000001';
  try {
    await assert.rejects(
      () => convertVideoInboxItem(rel, { config: readyConfig, model: readyModel, fetchImpl: noNetwork }),
      (error: any) => {
        assert.match(error.message, /超过内联上限/);
        assert.match(error.message, /缩短视频时长|360P|截取片段/);
        return true;
      }
    );
  } finally {
    if (previous === undefined) delete process.env.VIDEO_INLINE_MB;
    else process.env.VIDEO_INLINE_MB = previous;
  }
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, '收集箱', '转换结果')), true);
  assert.deepEqual(
    fs.readdirSync(path.join(BRAIN_DIR, '收集箱', '转换结果')),
    [],
    '失败不能留下空产物'
  );
});

test('占位稿损坏（平台不认识）：给出重新粘贴链接的提示，不联网', async () => {
  const rel = plant(
    '收集箱/坏链接.md',
    ['---', '类型: video-link', '平台: youtube', '链接: https://youtu.be/abc', '标题: 外部视频', '---', '', '视频链接：https://youtu.be/abc', ''].join('\n')
  );
  await assert.rejects(
    () => convertVideoInboxItem(rel, { config: readyConfig, model: readyModel, fetchImpl: noNetwork }),
    /占位稿已损坏/
  );
});


function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

test('buildSubtitleMessages：system 是纪要结构，user 带元信息与字幕全文（纯文本，无 media 块）', () => {
  const messages = buildSubtitleMessages(
    {
      title: '有字幕的视频',
      author: '测试UP',
      durationSec: 213,
      platform: 'bilibili',
      link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    },
    { text: '[00:01] 第一句\n[00:05] 第二句', lang: 'zh-CN' }
  );
  assert.equal(messages.length, 2);
  const system = String(messages[0].content);
  for (const heading of ['## 一句话总结', '## 内容脉络', '## 关键要点', '## 不确定或听不清']) {
    assert.ok(system.includes(heading), '字幕通道提示词缺少结构：' + heading);
  }
  assert.match(system, /不要描述画面/, '字幕通道要明说看不到画面');
  assert.equal(messages[1].role, 'user');
  const userText = String(messages[1].content);
  assert.equal(typeof messages[1].content, 'string', '字幕通道是纯文本消息');
  assert.match(userText, /标题：有字幕的视频/);
  assert.match(userText, /- 字幕语言：zh-CN/);
  assert.match(userText, /字幕全文/);
  assert.match(userText, /\[00:01\] 第一句/);
});

test('buildImageMessages：多图按序成为 image_url 内容块（data URL），文案与元信息在前', () => {
  const messages = buildImageMessages(
    { title: '图文笔记', author: '作者', platform: 'douyin', link: 'https://www.douyin.com/video/1' },
    [
      { mime: 'image/jpeg', base64: 'QUJD' },
      { mime: 'image/png', base64: 'REVG' },
    ]
  );
  assert.equal(messages.length, 2);
  assert.match(String(messages[0].content), /图文\/实况笔记/);
  const parts = messages[1].content as any[];
  assert.equal(parts.length, 3);
  assert.equal(parts[0].type, 'text');
  assert.match(String(parts[0].text), /共 2 张图片/);
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/jpeg;base64,QUJD');
  assert.equal(parts[2].image_url.url, 'data:image/png;base64,REVG');
});

test('B站有 CC 字幕：走字幕通道，不下载整段视频，产物 frontmatter 记录依据', async () => {
  const planted = plant(
    '收集箱/B站字幕测试.md',
    buildVideoLinkMarkdown({
      platform: 'bilibili',
      link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
      title: 'B站字幕测试',
    })
  );
  const calls: string[] = [];
  const modelBodies: any[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('api.bilibili.com/x/web-interface/view')) {
      return jsonResponse({
        code: 0,
        data: {
          bvid: 'BV1GJ411x7h7',
          cid: 137649199,
          duration: 60,
          title: '有字幕的视频',
          owner: { name: '测试UP' },
          pic: '//i0.example/cover.jpg',
        },
      });
    }
    if (url.includes('/x/player/wbi/v2')) {
      return jsonResponse({
        code: 0,
        data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//sub.example/137649199.json' }] } },
      });
    }
    if (url === 'https://sub.example/137649199.json') {
      const body = Array.from({ length: 20 }, (_, index) => ({
        from: index * 3,
        to: index * 3 + 2.5,
        content: '第 ' + (index + 1) + ' 句字幕内容，讲了一些真实存在的要点',
      }));
      return jsonResponse({ body });
    }
    if (url === 'https://video.example.com/v1/chat/completions') {
      modelBodies.push(JSON.parse(String(init.body)));
      return jsonResponse({
        choices: [{ message: { content: '# 测试纪要\n\n## 一句话总结\n字幕测试' }, finish_reason: 'stop' }],
        usage: {},
      });
    }
    throw new Error('不该请求：' + url);
  }) as unknown as typeof fetch;

  const result = await convertVideoInboxItem(planted, { config: readyConfig, model: readyModel, fetchImpl });
  assert.equal(result.source, 'subtitle');
  assert.equal(result.media.platform, 'bilibili');
  assert.equal(
    calls.some((url) => url.includes('/x/player/playurl')),
    false,
    '有字幕时不应再去取视频播放地址'
  );
  assert.equal(modelBodies.length, 1);
  const content = modelBodies[0].messages[0].content;
  assert.ok(Array.isArray(content), '字幕通道仍以内容块数组发请求');
  const hasVideo = content.some((part: any) => part.type === 'video_url');
  assert.equal(hasVideo, false, '字幕通道不应内联视频');

  const derived = fs.readFileSync(path.join(BRAIN_DIR, ...result.derivedPath.split('/')), 'utf8');
  assert.match(derived, /提炼依据: B站CC字幕/);
  assert.match(derived, /视频平台: bilibili/);
  assert.match(derived, /视频作者: 测试UP/);
  assert.match(derived, /视频时长: 1 分 0 秒/);
  assert.match(derived, /封面链接: https:\/\/i0\.example\/cover\.jpg/);
  assert.match(derived, /## 一句话总结/);
});

test('抖音图文笔记：多图送 image_url 通道，产物 frontmatter 记录图片数量与依据', async () => {
  resetDouyinIdentityCache();
  const planted = plant(
    '收集箱/抖音图文测试.md',
    buildVideoLinkMarkdown({
      platform: 'douyin',
      link: 'https://www.douyin.com/video/7298145681699622182',
      title: '抖音图文测试',
    })
  );
  const imageBytes = Buffer.from('fake-image');
  const modelBodies: any[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = String(input);
    if (url.includes('/ttwid/register')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': 'ttwid=ttwid-test; Path=/' }),
        text: async () => '{}',
      } as unknown as Response;
    }
    if (url === 'https://www.douyin.com/') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-tt-trace-host': 'uifid-test' }),
        text: async () => '<html></html>',
      } as unknown as Response;
    }
    if (url.includes('/aweme/v1/web/aweme/detail/')) {
      return jsonResponse({
        status_code: 0,
        aweme_detail: {
          desc: '一条图文笔记',
          author: { nickname: '笔记作者' },
          images: [{ url_list: ['https://img.example/1.jpg'] }, { url_list: ['https://img.example/2.jpg'] }],
        },
      });
    }
    if (url === 'https://img.example/1.jpg' || url === 'https://img.example/2.jpg') {
      return new Response(imageBytes as any, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (url === 'https://video.example.com/v1/chat/completions') {
      modelBodies.push(JSON.parse(String(init.body)));
      return jsonResponse({
        choices: [{ message: { content: '# 图文纪要\n\n## 一句话总结\n图文测试' }, finish_reason: 'stop' }],
        usage: {},
      });
    }
    throw new Error('不该请求：' + url);
  }) as unknown as typeof fetch;

  const result = await convertVideoInboxItem(planted, { config: readyConfig, model: readyModel, fetchImpl });
  assert.equal(result.source, 'images');
  assert.equal(result.media.images, 2);
  assert.equal(modelBodies.length, 1);
  const content = modelBodies[0].messages[0].content as any[];
  assert.equal(content.filter((part: any) => part.type === 'image_url').length, 2);
  assert.equal(content.some((part: any) => part.type === 'video_url'), false);

  const derived = fs.readFileSync(path.join(BRAIN_DIR, ...result.derivedPath.split('/')), 'utf8');
  assert.match(derived, /提炼依据: 图文多图/);
  assert.match(derived, /视频平台: douyin/);
  assert.match(derived, /图片数量: 2/);
  assert.match(derived, /# 图文纪要/);
});

test('只允许收集箱内的路径：越界直接拒绝', async () => {
  await assert.rejects(
    () => convertVideoInboxItem('原始资料/文档/越界.mp4', { config: readyConfig, model: readyModel, fetchImpl: noNetwork }),
    /只能提炼收集箱内的音视频文件/
  );
});
