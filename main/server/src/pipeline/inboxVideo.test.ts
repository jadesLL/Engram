import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVideoLinkMarkdown } from '../lib/videoLink.js';

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
let videoMime: typeof import('./inboxVideo.js').videoMime;
let assertVideoInlineable: typeof import('./inboxVideo.js').assertVideoInlineable;
let videoInlineLimitBytes: typeof import('./inboxVideo.js').videoInlineLimitBytes;

/** 可用的视频模型配置（测试里只用来通过 videoConfigHint，不真正发请求） */
const readyConfig = {
  enabled: true,
  baseUrl: 'https://video.example.com/v1',
  apiKey: 'test-key',
  model: 'mock-video',
  maxTokens: 4096,
  quality: 64,
  douyinBrowser: false,
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
        config: { ...readyConfig, enabled: false },
        fetchImpl: noNetwork,
      }),
    /视频理解未启用/
  );
});

test('抖音占位稿未开启浏览器抓取：提前给出开启提示，不联网', async () => {
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
        config: { ...readyConfig, douyinBrowser: false },
        fetchImpl: noNetwork,
      }),
    (error: any) => {
      assert.match(error.message, /抖音视频需要开启本机浏览器抓取/);
      assert.match(error.message, /上传本地视频/);
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
      () => convertVideoInboxItem(rel, { config: readyConfig, fetchImpl: noNetwork }),
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
    () => convertVideoInboxItem(rel, { config: readyConfig, fetchImpl: noNetwork }),
    /占位稿已损坏/
  );
});

test('只允许收集箱内的路径：越界直接拒绝', async () => {
  await assert.rejects(
    () => convertVideoInboxItem('原始资料/文档/越界.mp4', { config: readyConfig, fetchImpl: noNetwork }),
    /只能提炼收集箱内的音视频文件/
  );
});
