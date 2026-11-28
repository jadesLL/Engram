import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendImageGallery,
  appendSourceLine,
  appendTimepoints,
  extractTimepoints,
  insertCoverAfterTitle,
  normalizeArticle,
  stripBodyTimestamps,
  stripTimepointSection,
} from './videoArticle.js';

const NOTES = [
  '观看笔记',
  '[00:00] 演示：把编码器放到治具上，屏幕读数 135.565。',
  '[00:52] 原理：发射线圈通交流电，两个 8 字线圈反接抵消。',
  '[02:10] 游标：外圈 18 片、内圈 5 片，唯一重合值 162 度。',
  '[05:05] 芯片：纳芯微 MT6901，UART 23 位。',
  '',
  '## 时间点',
  '- [00:00] 绝对值演示',
  '- [00:52] 电感式测角原理',
  '- [02:10] 游标解算绝对值',
  '- [05:05] MT6901 芯片方案',
].join('\n');

test('stripBodyTimestamps：去掉 [mm:ss] 与区间，代码块内保留', () => {
  const source = '# 标题\n\n[00:00] 导语。\n\n## 原理\n\n[00:52]-[02:10] 细节。\n\n```\n[00:00] 代码里的时间戳保留\n```';
  const result = stripBodyTimestamps(source);
  assert.equal(result.includes('[00:00] 导语'), false);
  assert.equal(result.includes('[00:52]-[02:10]'), false);
  assert.match(result, /代码里的时间戳保留/);
  assert.match(result, /导语。/);
});

test('extractTimepoints：优先读观看笔记里的「## 时间点」小节', () => {
  const points = extractTimepoints(NOTES);
  assert.equal(points.length, 4);
  assert.deepEqual(points[1], { timestamp: '00:52', text: '电感式测角原理' });
});

test('extractTimepoints：没有时间点小节时退化为扫描笔记中的时间戳', () => {
  const points = extractTimepoints('前一段 [00:12] 讲了 A。\n后一段 [01:02] 讲了 B。');
  assert.equal(points.length, 2);
  assert.equal(points[0].timestamp, '00:12');
  assert.match(points[1].text, /讲了 B/);
});

test('insertCoverAfterTitle：插在一级标题后，不重复插入', () => {
  const withCover = insertCoverAfterTitle('# 标题\n\n导语。', '/media/id/cover.jpg');
  assert.equal(withCover, '# 标题\n\n![视频封面](/media/id/cover.jpg)\n\n导语。');
  assert.equal(insertCoverAfterTitle(withCover, '/media/id/cover.jpg'), withCover);
});

test('appendImageGallery：从第二张开始编号，第一张当封面', () => {
  const body = appendImageGallery('# 标题\n\n正文。', ['/media/id/1.jpg', '/media/id/2.jpg', '/media/id/3.jpg'], 1);
  assert.match(body, /## 附图/);
  assert.match(body, /!\[图2\]\(\/media\/id\/2\.jpg\)/);
  assert.match(body, /!\[图3\]\(\/media\/id\/3\.jpg\)/);
  assert.equal(body.includes('图1]'), false);
});

test('appendTimepoints：文末统一收口，保持时间顺序', () => {
  const body = appendTimepoints('# 标题\n\n正文。', [
    { timestamp: '00:00', text: '开头' },
    { timestamp: '01:00', text: '中间' },
  ]);
  assert.match(body, /## 视频时间点/);
  assert.match(body, /- \[00:00\] 开头/);
  assert.match(body, /- \[01:00\] 中间/);
});

test('appendSourceLine：链接/作者/平台合成一行来源', () => {
  const body = appendSourceLine('# 标题\n\n正文。', {
    title: '测试视频',
    author: '测试UP',
    platformLabel: 'B站',
    link: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  });
  assert.match(body, /> 来源：\[测试视频\]\(https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7\) · 测试UP · B站/);
});

test('normalizeArticle：去正文时间戳、插封面、附时间点与来源', () => {
  const markdown = [
    '# 不用霍尔，怎么知道转了多少度',
    '',
    '[00:00] 这条视频演示了一个电感式编码器。',
    '',
    '## 原理',
    '',
    '[00:52] 发射线圈与两个 8 字线圈反接。',
    '',
    '## 视频时间点',
    '',
    '- [00:00] 模型自己写的时间点（应被替换）',
  ].join('\n');
  const result = normalizeArticle(markdown, {
    notes: NOTES,
    coverUrl: '/media/id/cover.jpg',
    source: {
      title: '电感式编码器',
      author: '工科男孙老师',
      platformLabel: '抖音',
      link: 'https://www.douyin.com/video/1',
    },
  });
  assert.equal(result.includes('[00:00] 这条视频'), false, '正文时间戳必须去掉');
  assert.equal(result.includes('[00:52] 发射线圈'), false, '正文时间戳必须去掉');
  assert.match(result, /!\[视频封面\]\(\/media\/id\/cover\.jpg\)/);
  assert.match(result, /## 视频时间点/);
  assert.match(result, /- \[00:52\] 电感式测角原理/);
  assert.equal(result.includes('模型自己写的时间点'), false, '旧时间点小节应被替换');
  assert.match(result, /> 来源：\[电感式编码器\]\(https:\/\/www\.douyin\.com\/video\/1\)/);
});

test('stripTimepointSection：删掉模型自带的视频时间点/时间点小节', () => {
  const input = '# 标题\n\n正文。\n\n## 时间点\n\n- [00:00] A\n\n## 关键数据\n\n- 1';
  const result = stripTimepointSection(input);
  assert.match(result, /## 关键数据/);
  assert.equal(result.includes('## 时间点'), false);
});
