import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「点浮层外面关闭」的接线护栏（2026-11-22 用户报障：所有页面弹出的浮窗，
 * 点外边空白处都不关）。
 *
 * 版式与真实点击没法在 node --test 里单测，沿用 mobileShellUx.test.ts 的写法读源码断言：
 *  - 右侧三张悬浮卡片（Agent 对话 / 图片资产 / 同步详情）必须走同一套 useDismissOnOutside；
 *  - 工具必须用捕获阶段 pointerdown（click 会被个别上层吞掉）、按层栈只关最上面那层，
 *    并在有模态遮罩/对话框在场时让路（否则一次点击会关掉两层）；
 *  - 从收集箱挑文件的弹窗也必须允许点遮罩关闭。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

const FLOATING_CARDS = [
  ['components/ChatDrawer.vue', 'Agent 对话抽屉'],
  ['components/AssetDrawer.vue', '图片资产卡片'],
  ['components/SyncLogDrawer.vue', '同步详情卡片'],
] as const;

test('点外关闭：三张悬浮卡片都接入统一实现并给根节点挂 ref', () => {
  for (const [file, label] of FLOATING_CARDS) {
    const src = readSrc(file);
    assert.match(
      src,
      /import \{ useDismissOnOutside \} from '\.\.\/lib\/dismissOnOutside'/,
      `${label} 没接 useDismissOnOutside`,
    );
    assert.match(src, /useDismissOnOutside\(\{[\s\S]{0,400}?close:\s*[^,]+,/, `${label} 没调用 useDismissOnOutside`);
    assert.match(src, /ref="rootEl"/, `${label} 的浮层根节点没挂 ref="rootEl"`);
  }
});

test('点外关闭：工具用捕获 pointerdown + 层栈 + 上层模态让路', () => {
  const src = readSrc('lib/dismissOnOutside.ts');
  assert.match(
    src,
    /document\.addEventListener\('pointerdown', onPointerDown, true\)/,
    '没在捕获阶段监听 pointerdown：click 被上层 preventDefault/吞掉时点外关闭会失效',
  );
  assert.match(src, /layers\[0\]\.id !== id/, '多层浮层没有「只让最上面那层响应」的裁决');
  assert.match(src, /MODAL_LAYER_SELECTOR/, '缺少上层模态/遮罩的让路判断：一次点击会连关两层');
  assert.match(src, /data-overlay-keep/, '缺少 Teleport 子面板（下拉/右键菜单/通知）的保留标记');
  assert.match(src, /'dialog\[open\]'/, '原生 <dialog> 没算进上层模态：点它的背板会误关下层卡片');
});

test('点外关闭：收集箱选文件弹窗不再禁用点遮罩关闭', () => {
  const src = readSrc('components/InboxFilePicker.vue');
  assert.doesNotMatch(src, /close-on-mask="false"/, '选文件弹窗仍禁用了点外关闭');
});
