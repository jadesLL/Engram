import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-derived-'));
process.env.DATA_DIR = temp;

let BRAIN_DIR = '';
let derivedPathsForVideoLink: typeof import('./inboxDerived.js').derivedPathsForVideoLink;

before(async () => {
  const config = await import('../config.js');
  config.ensureDirs();
  BRAIN_DIR = config.BRAIN_DIR;
  ({ derivedPathsForVideoLink } = await import('./inboxDerived.js'));
});

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

function plant(name: string, frontmatter: string[]): string {
  const dir = path.join(BRAIN_DIR, '收集箱', '转换结果');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, ['---', ...frontmatter, '---', '', '# 标题', ''].join('\n'), 'utf8');
  return `收集箱/转换结果/${name}`;
}

test('derivedPathsForVideoLink：按视频链接找出同一条视频的旧产物', () => {
  const first = plant('旧纪要.md', ['来源: 收集箱/抖音视频.md', '视频链接: https://www.douyin.com/video/1']);
  const second = plant('新纪要.md', ['来源: 收集箱/抖音视频-2.md', "视频链接: 'https://www.douyin.com/video/1'"]);
  plant('别的视频.md', ['来源: 收集箱/另一个.md', '视频链接: https://www.douyin.com/video/2']);
  plant('没有链接.md', ['来源: 收集箱/文档.md']);

  const found = derivedPathsForVideoLink('https://www.douyin.com/video/1/');
  assert.deepEqual(new Set(found), new Set([first, second]));
  assert.deepEqual(derivedPathsForVideoLink(''), []);
});
