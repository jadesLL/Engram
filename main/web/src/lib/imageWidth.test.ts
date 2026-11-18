import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageWidthFromSrc,
  isLocalMediaImageSrc,
  withImageWidth,
} from './imageWidth.ts';

test('只认本库 /media 图片引用', () => {
  assert.equal(isLocalMediaImageSrc('/media/abc-1/x.png'), true);
  assert.equal(isLocalMediaImageSrc('/media/abc-1/%E7%8E%B0%E5%9C%BA.png#w=320'), true);
  assert.equal(isLocalMediaImageSrc('/media/abc-1/x.png?w=320'), true);
  assert.equal(isLocalMediaImageSrc('/api/files/content?path=assets%2Fx.png'), false);
  assert.equal(isLocalMediaImageSrc('https://example.com/media/a/b.png'), false);
  assert.equal(isLocalMediaImageSrc('data:image/png;base64,AAAA'), false);
  assert.equal(isLocalMediaImageSrc('/media/abc/x/y.png'), false);
  assert.equal(isLocalMediaImageSrc('/media/abc/'), false);
  assert.equal(isLocalMediaImageSrc('/media//x.png'), false);
});

test('宽度只从 fragment 的 w 参数读取', () => {
  assert.equal(imageWidthFromSrc('/media/p1/x.png#w=320'), 320);
  assert.equal(imageWidthFromSrc('/media/p1/x.png#w=320&other=1'), 320);
  assert.equal(imageWidthFromSrc('/media/p1/x.png#other=1&w=480'), 480);
  assert.equal(imageWidthFromSrc('/media/p1/x.png?w=320'), null);
  assert.equal(imageWidthFromSrc('/media/p1/x.png#w=0'), null);
  assert.equal(imageWidthFromSrc('/media/p1/x.png#w=abc'), null);
  assert.equal(imageWidthFromSrc('/media/p1/x.png#x=320'), null);
  assert.equal(imageWidthFromSrc('https://example.com/x.png#w=320'), null);
});

test('写入宽度保留 query 与其它 fragment，清除时只删 w', () => {
  assert.equal(withImageWidth('/media/p1/x.png', 320), '/media/p1/x.png#w=320');
  assert.equal(withImageWidth('/media/p1/x.png#w=200', 320), '/media/p1/x.png#w=320');
  assert.equal(withImageWidth('/media/p1/x.png#a=1', 320), '/media/p1/x.png#a=1&w=320');
  assert.equal(withImageWidth('/media/p1/x.png?v=2#a=1', 320), '/media/p1/x.png?v=2#a=1&w=320');
  assert.equal(withImageWidth('/media/p1/x.png?v=2#w=320', null), '/media/p1/x.png?v=2');
  assert.equal(withImageWidth('/media/p1/x.png#a=1&w=320', null), '/media/p1/x.png#a=1');
  // 外部图片保持原样，绝不往别人的 URL 里塞参数
  assert.equal(withImageWidth('https://example.com/x.png', 320), 'https://example.com/x.png');
});

test('宽度写入幂等且按整数像素落盘', () => {
  const once = withImageWidth('/media/p1/x.png', 320.4);
  assert.equal(once, '/media/p1/x.png#w=320');
  assert.equal(withImageWidth(once, 320), once);
});
