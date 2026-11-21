import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 速记横条的提交按钮护栏（2026-11-18）：组件里有一条 `.home-action button { padding:0 }`
 * 的通用重置，权重（0,1,1）高于单类名 `.action-send`，会把按钮左右 11px 内边距吃掉。
 * 横条里按钮永远贴着内容右缘，没有内边距后「记下」两个字顶到边界、被 `.module-content`
 * 的 overflow 裁掉半笔——看起来像字被削掉一块。
 * 这里锁住「两段选择器把内边距提回来」这条覆盖，防止后续整理样式时又退回单类名。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('速记提交按钮：内边距覆盖的权重高于通用按钮重置', () => {
  const source = read('components/HomeBoardModules/HomeActionComposer.vue');
  // 注释里会引用 `.home-action button`，先剥掉评论再匹配样式块
  const styles = source.slice(source.lastIndexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(styles, /\.home-action button\s*\{[^}]*padding:\s*0/, '通用按钮重置已改：重新评估提交按钮的内边距覆盖是否还需要');

  const override = styles.match(/\.home-action \.action-send\s*\{[^}]*\}/);
  assert.ok(override, '找不到 `.home-action .action-send` 的内边距覆盖');
  assert.match(override[0], /padding:\s*0\s+11px/, '提交按钮的内边距又被单类名规则吃掉：「记下」会贴边被裁');
});

test('速记提交按钮的文字标签不换行', () => {
  const source = read('components/HomeBoardModules/HomeActionComposer.vue');
  const label = source.match(/\.send-label\s*\{[^}]*\}/);
  assert.ok(label, '找不到 .send-label 样式');
  assert.match(label[0], /white-space:\s*nowrap/, '「记下」在窄档里可能折行，按钮会忽高忽低');
});

test('速记提交按钮：禁用态用主操作色细环，不再铺灰块', () => {
  const source = read('components/HomeBoardModules/HomeActionComposer.vue');
  const styles = source.slice(source.lastIndexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
  const disabled = styles.match(/\.action-send:disabled,\s*\.action-submit:disabled\s*\{[^}]*\}/);
  assert.ok(disabled, '找不到「记下」/「提交」的禁用态规则');
  assert.doesNotMatch(
    disabled[0],
    /background:\s*var\(--bg-tertiary\)/,
    '禁用态又退回实心灰底：白卡上的「记下」会重新变成一块废弃感灰块'
  );
  assert.match(disabled[0], /background:\s*transparent/, '禁用态应透明底，把卡面让出来');
  // 2026-11-21：主操作色从 --accent 抽成 --action-solid（确认/保存/提交统一墨色），细环跟着主操作色走
  assert.match(
    disabled[0],
    /box-shadow:\s*inset\s+0\s+0\s+0\s+1px\s+color-mix\(in srgb,\s*var\(--action-solid\)/,
    '禁用态缺少 1px 主操作色细环：和设置页选中态不是同一套语言'
  );
});
