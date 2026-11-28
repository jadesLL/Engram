import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVideoLinkMarkdown } from '../lib/videoLink.js';
import { resetDouyinIdentityCache } from '../lib/douyin.js';

/**
 * 视频提炼管线：两段式提示词、data URL MIME、内联上限文案、配置/占位稿的前置报错。
 * 不联网：模型请求全部用 mock fetch，只验证请求形状与产物结构。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-video-'));
process.env.DATA_DIR = temp;

let BRAIN_DIR = '';
let db: any;
let convertVideoInboxItem: typeof import('./inboxVideo.js').convertVideoInboxItem;
let buildVideoMessages: typeof import('./inboxVideo.js').buildVideoMessages;
let buildArticleMessages: typeof import('./inboxVideo.js').buildArticleMessages;
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

/** 成文模型：测试里指向同一个 mock 网关，用请求里的 system 区分「观看」与「成文」 */
const readyEditor = {
  baseUrl: 'https://video.example.com/v1',
  apiKey: 'test-key',
  model: 'mock-editor',
  api: 'openai-completions',
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
    buildArticleMessages,
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

test('buildVideoMessages：system 是观看笔记规范（不成文），user 带元信息与 video_url data URL', () => {
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
  assert.match(system, /观看笔记/);
  assert.match(system, /不是写文章/);
  assert.match(system, /\[mm:ss\]/);
  assert.match(system, /逐字保留/);
  assert.match(system, /不确定/);
  assert.doesNotMatch(system, /## 一句话总结/, '两段式后第一段不再输出固定纪要骨构');
  assert.doesNotMatch(system, /## 关键要点/);

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
  assert.match(userText, /请按系统要求输出观看笔记/);

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

/** 请求体里的 system 文本：成文是字符串消息，观看是内容块数组（system 在第一个 text 块） */
function systemText(body: any): string {
  const content = body?.messages?.[0]?.content;
  return Array.isArray(content) ? String(content[0]?.text || '') : String(content || '');
}

test('buildArticleMessages：system 是文章规范，user 带来源信息、证据类型与字幕全文', () => {
  const messages = buildArticleMessages(
    {
      title: '有字幕的视频',
      author: '测试UP',
      durationSec: 213,
      platform: 'bilibili',
      link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    },
    { kind: 'subtitle', text: '[00:01] 第一句\n[00:05] 第二句' }
  );
  assert.equal(messages.length, 2);
  const system = String(messages[0].content);
  assert.match(system, /中文内容编辑/);
  assert.match(system, /独立解读文章/);
  assert.match(system, /主题先行/);
  assert.match(system, /导语/);
  assert.match(system, /## 关键数据/);
  assert.match(system, /## 边界与存疑/);
  assert.match(system, /正文禁止出现 \[mm:ss\]/);
  assert.match(system, /frame:MM:SS/);
  assert.match(system, /读者没看过视频/);
  assert.doesNotMatch(system, /## 一句话总结/);
  assert.equal(messages[1].role, 'user');
  const userText = String(messages[1].content);
  assert.equal(typeof messages[1].content, 'string', '成文通道是纯文本消息');
  assert.match(userText, /标题：有字幕的视频/);
  assert.match(userText, /证据类型：B站 CC 字幕/);
  assert.match(userText, /不要描述画面/);
  assert.match(userText, /不要写 frame:MM:SS 占位/);
  assert.match(userText, /字幕全文/);
  assert.match(userText, /\[00:01\] 第一句/);
});

test('buildArticleMessages：图文证据标注图片数量，视频证据用观看笔记', () => {
  const images = buildArticleMessages(
    { title: '图文笔记', platform: 'douyin' },
    { kind: 'images', text: '[图1] 第一张', images: 2 }
  );
  assert.match(String(images[1].content), /图文\/实况笔记（2 张图片/);
  assert.match(String(images[1].content), /观看笔记/);

  const video = buildArticleMessages(
    { title: '视频', platform: 'douyin' },
    { kind: 'video', text: '[00:01] 讲了第一点' }
  );
  assert.match(String(video[1].content), /视频画面与口播/);
  assert.match(String(video[1].content), /观看笔记/);
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

test('B站有 CC 字幕：直接走文本模型成文，不下载整段视频、不经过视频模型', async () => {
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
        choices: [{ message: { content: '# 字幕文章\n\n导语：这篇讲了三件事。\n\n## 关键数据\n- 3 件事' }, finish_reason: 'stop' }],
        usage: {},
      });
    }
    throw new Error('不该请求：' + url);
  }) as unknown as typeof fetch;

  const result = await convertVideoInboxItem(planted, {
    config: readyConfig,
    model: readyModel,
    editor: readyEditor,
    fetchImpl,
  });
  assert.equal(result.source, 'subtitle');
  assert.equal(result.media.platform, 'bilibili');
  assert.equal(result.model, 'mock-editor');
  assert.equal(
    calls.some((url) => url.includes('/x/player/playurl')),
    false,
    '有字幕时不应再去取视频播放地址'
  );
  assert.equal(modelBodies.length, 1, '字幕通道只有一次文本模型调用');
  const body = modelBodies[0];
  assert.equal(body.model, 'mock-editor');
  assert.equal(typeof body.messages[0].content, 'string', '成文请求的 system 是纯文本');
  assert.match(String(body.messages[0].content), /中文内容编辑/);
  assert.match(String(body.messages[1].content), /证据类型：B站 CC 字幕/);
  assert.match(String(body.messages[1].content), /第 1 句字幕内容/);
  assert.equal(JSON.stringify(body).includes('video_url'), false, '字幕通道不应内联视频');

  const derived = fs.readFileSync(path.join(BRAIN_DIR, ...result.derivedPath.split('/')), 'utf8');
  assert.match(derived, /提炼依据: B站CC字幕/);
  assert.match(derived, /视频平台: bilibili/);
  assert.match(derived, /视频作者: 测试UP/);
  assert.match(derived, /视频时长: 1 分 0 秒/);
  assert.match(derived, /封面链接: https:\/\/i0\.example\/cover\.jpg/);
  assert.match(derived, /转换模型: mock-editor/);
  assert.match(derived, /# 字幕文章/);
  assert.doesNotMatch(derived, /观看模型:/, '字幕通道没有第一段，不写观看模型');
});

test('抖音图文笔记：先看多图产出观看笔记，再由文本模型成文，frontmatter 记录两段模型', async () => {
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
      const body = JSON.parse(String(init.body));
      modelBodies.push(body);
      const content = body.messages[0].content;
      const system = Array.isArray(content) ? String(content[0]?.text || '') : String(content || '');
      const watcher = system.includes('图文笔记观察员');
      return jsonResponse({
        choices: [{
          message: {
            content: watcher
              ? '[图1] 第一张写着电感式编码器，读数 135.000°\n[图2] 接线图与 MT6901 型号'
              : '# 图文解读\n\n导语：这条图文笔记讲了一个编码器方案。\n\n## 关键数据\n- 135.000°',
          },
          finish_reason: 'stop',
        }],
        usage: {},
      });
    }
    throw new Error('不该请求：' + url);
  }) as unknown as typeof fetch;

  const result = await convertVideoInboxItem(planted, {
    config: readyConfig,
    model: readyModel,
    editor: readyEditor,
    fetchImpl,
  });
  assert.equal(result.source, 'images');
  assert.equal(result.media.images, 2);
  assert.equal(result.model, 'mock-editor');
  assert.equal(modelBodies.length, 2, '图文通道是两段式：观看笔记 + 成文');
  const watcherParts = modelBodies[0].messages[0].content as any[];
  assert.equal(watcherParts.filter((part: any) => part.type === 'image_url').length, 2);
  assert.equal(watcherParts.some((part: any) => part.type === 'video_url'), false);
  assert.match(String(modelBodies[1].messages[0].content), /中文内容编辑/);
  assert.match(String(modelBodies[1].messages[1].content), /\[图1\] 第一张写着电感式编码器/);

  const derived = fs.readFileSync(path.join(BRAIN_DIR, ...result.derivedPath.split('/')), 'utf8');
  assert.match(derived, /提炼依据: 图文多图/);
  assert.match(derived, /视频平台: douyin/);
  assert.match(derived, /图片数量: 2/);
  assert.match(derived, /转换模型: mock-editor/);
  assert.match(derived, /观看模型: mock-video/);
  assert.match(derived, /# 图文解读/);
});

test('本地视频：两段式产出文章，frontmatter 记录观看模型与成文模型', async () => {
  const rel = plant('收集箱/短片.mp4', Buffer.alloc(2048));
  const modelBodies: any[] = [];
  const fetchImpl = (async (_input: any, init: any) => {
    const body = JSON.parse(String(init.body));
    modelBodies.push(body);
    const watcher = systemText(body).includes('视频观察员');
    return jsonResponse({
      choices: [{
        message: {
          content: watcher
            ? '[00:00]-[00:10] 演示者把 PCB 放上底座，屏幕显示 135.000°\n[00:10]-[00:20] 拿下再放回，读数仍是 135.000°'
            : '# 电感式编码器实测\n\n导语：这段演示验证了绝对式读数。\n\n## 关键数据\n- 135.000°',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    });
  }) as unknown as typeof fetch;

  const result = await convertVideoInboxItem(rel, {
    config: readyConfig,
    model: readyModel,
    editor: readyEditor,
    fetchImpl,
  });
  assert.equal(result.source, 'upload');
  assert.equal(result.model, 'mock-editor');
  assert.equal(modelBodies.length, 2);
  const videoParts = modelBodies[0].messages[0].content as any[];
  assert.equal(videoParts.some((part: any) => part.type === 'video_url'), true);
  assert.match(String(videoParts[0].text), /视频观察员/);
  assert.match(String(modelBodies[1].messages[0].content), /中文内容编辑/);
  assert.match(String(modelBodies[1].messages[1].content), /\[00:00\]-\[00:10\] 演示者把 PCB/);

  const derived = fs.readFileSync(path.join(BRAIN_DIR, ...result.derivedPath.split('/')), 'utf8');
  assert.match(derived, /提炼依据: 本地音视频/);
  assert.match(derived, /转换模型: mock-editor/);
  assert.match(derived, /观看模型: mock-video/);
  assert.match(derived, /# 电感式编码器实测/);
});

test('没配文本模型 Key：成文回退到视频模型，管线不中断', async () => {
  const rel = plant('收集箱/回退短片.mp4', Buffer.alloc(2048));
  const modelBodies: any[] = [];
  const fetchImpl = (async (_input: any, init: any) => {
    const body = JSON.parse(String(init.body));
    modelBodies.push(body);
    const watcher = systemText(body).includes('视频观察员');
    return jsonResponse({
      choices: [{
        message: {
          content: watcher ? '[00:00]-[00:10] 演示了两个读数' : '# 回退成文\n\n导语：回退也能成文。\n\n## 边界与存疑\n无',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    });
  }) as unknown as typeof fetch;

  const result = await convertVideoInboxItem(rel, {
    config: readyConfig,
    model: readyModel,
    fetchImpl,
  });
  assert.equal(result.model, 'mock-video');
  assert.equal(modelBodies.length, 2, '观看 + 回退成文各一次');
  assert.match(systemText(modelBodies[1]), /中文内容编辑/);
  const derived = fs.readFileSync(path.join(BRAIN_DIR, ...result.derivedPath.split('/')), 'utf8');
  assert.match(derived, /# 回退成文/);
  assert.doesNotMatch(derived, /观看模型:/, '两段用同一个模型时不重复记录');
});

test('观看笔记被输出上限截断：使用已生成部分继续成文，不整条失败', async () => {
  const rel = plant('收集箱/截断短片.mp4', Buffer.alloc(2048));
  const partial = '[00:00]-[00:30] ' + '这是一段已经记录下来的观看笔记内容。'.repeat(20);
  const modelBodies: any[] = [];
  const fetchImpl = (async (_input: any, init: any) => {
    const body = JSON.parse(String(init.body));
    modelBodies.push(body);
    const watcher = systemText(body).includes('视频观察员');
    return jsonResponse({
      choices: [{
        message: { content: watcher ? partial : '# 截断也成文\n\n导语：截断的笔记仍能成文。' },
        finish_reason: watcher ? 'length' : 'stop',
      }],
      usage: {},
    });
  }) as unknown as typeof fetch;

  const result = await convertVideoInboxItem(rel, {
    config: readyConfig,
    model: readyModel,
    editor: readyEditor,
    fetchImpl,
  });
  assert.equal(result.model, 'mock-editor');
  assert.equal(modelBodies.length, 2, '截断后仍继续成文');
  assert.match(String(modelBodies[1].messages[1].content), /这是一段已经记录下来的观看笔记内容/);
  const derived = fs.readFileSync(path.join(BRAIN_DIR, ...result.derivedPath.split('/')), 'utf8');
  assert.match(derived, /# 截断也成文/);
});

test('只允许收集箱内的路径：越界直接拒绝', async () => {
  await assert.rejects(
    () => convertVideoInboxItem('原始资料/文档/越界.mp4', { config: readyConfig, model: readyModel, fetchImpl: noNetwork }),
    /只能提炼收集箱内的音视频文件/
  );
});
