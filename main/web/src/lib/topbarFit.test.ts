import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topbarMenuModeFor, topbarWidthFor } from './topbarFit.ts';

/**
 * 编辑顶栏「更多 ⋯」的护栏（2026-11-19 / 第二版方案）。
 *
 * 第一版按宽度逐档收文案、换图标被用户否掉（顶栏不该随正文宽度缩放）；
 * 定稿改成「控件与文案不变，窄时把低频项收进 ⋯ 菜单」。这里断两件事：
 * ①分档函数的阈值；②视图里确实按档位把控件放进菜单。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('顶栏宽度：扣掉悬浮条左右外边距（桌面 18×2 / 窄屏 10×2）', () => {
  assert.equal(topbarWidthFor(556, false), 520);
  assert.equal(topbarWidthFor(556, true), 536);
  assert.equal(topbarWidthFor(0, false), 0);
  assert.equal(topbarWidthFor(Number.NaN, false), 0);
  assert.equal(topbarWidthFor(20, false), 0, '比外边距还窄时不能返回负数');
});

test('桌面分档：inline → ⋯ → 只剩保存态+⋯ → 只剩保存态', () => {
  assert.equal(topbarMenuModeFor(0), 'inline', '还没量到宽度时首帧保持平铺');
  assert.equal(topbarMenuModeFor(520), 'inline');
  assert.equal(topbarMenuModeFor(492), 'inline');
  assert.equal(topbarMenuModeFor(491), 'compact', '放不下平铺时整排收进 ⋯，不是逐档缩');
  assert.equal(topbarMenuModeFor(355), 'compact');
  assert.equal(topbarMenuModeFor(354), 'mini');
  assert.equal(topbarMenuModeFor(150), 'mini');
  assert.equal(topbarMenuModeFor(149), 'nano');
});

test('窄屏分档：媒体查询已经把引用位置/自动保存的文案收起，阈值另算', () => {
  assert.equal(topbarMenuModeFor(350, { narrow: true }), 'inline');
  assert.equal(topbarMenuModeFor(349, { narrow: true }), 'compact');
  assert.equal(topbarMenuModeFor(250, { narrow: true }), 'compact');
  assert.equal(topbarMenuModeFor(249, { narrow: true }), 'mini');
  assert.equal(topbarMenuModeFor(140, { narrow: true }), 'mini');
  assert.equal(topbarMenuModeFor(139, { narrow: true }), 'nano');
});

test('返回键与手动保存按钮会额外占宽，分档要跟着提前', () => {
  // 返回键带文案（~130）只在平铺/⋯ 档在位；mini 档起进菜单
  assert.equal(topbarMenuModeFor(621, { hasBack: true }), 'compact');
  assert.equal(topbarMenuModeFor(622, { hasBack: true }), 'inline');
  assert.equal(topbarMenuModeFor(484, { hasBack: true }), 'mini');
  assert.equal(topbarMenuModeFor(485, { hasBack: true }), 'compact');
  // 手动保存按钮（~63）只在平铺档在位；⋯ 档起进菜单，不再占平铺阈值
  assert.equal(topbarMenuModeFor(554, { manualSave: true }), 'compact');
  assert.equal(topbarMenuModeFor(555, { manualSave: true }), 'inline');
  assert.equal(topbarMenuModeFor(400, { manualSave: true }), 'compact');
});

test('视图按档位收纳：顶栏本身不缩字、不换图标', () => {
  const view = readSrc('views/EditorView.vue');
  assert.match(view, /:class="`topbar-\$\{topbarMenuMode\}`"/, '顶栏没有绑定展示档');
  assert.match(
    view,
    /const topbarMenuMode = computed\(\(\) =>\s*topbarMenuModeFor\(topbarWidthFor\(availableWidth\.value, narrowEditor\.value\), \{/,
    '档位没有按顶栏自身宽度计算（抽屉 / 文件树开合都要能改档）',
  );
  // 平铺档才有的三样：正文宽度 / 自动保存 / 手动保存按钮
  assert.match(view, /v-if="topbarMenuMode === 'inline'"\s+ref="widthPickerEl"/, '正文宽度没有收进 ⋯ 菜单');
  assert.match(view, /v-if="!autosave && topbarMenuMode === 'inline'"/, '手动保存按钮没有收进 ⋯ 菜单');
  assert.match(view, /v-if="topbarMenuMode === 'inline'"\s+class="switch-control autosave-toggle"/, '自动保存开关没有收进 ⋯ 菜单');
  // ⋯ 档仍平铺主操作；mini 档连主操作也进菜单
  assert.match(view, /v-if="topbarMenuMode === 'inline' \|\| topbarMenuMode === 'compact'"\s+class="btn small topbar-ref"/, '引用位置没有在 ⋯ 档保留');
  assert.match(view, /v-if="topbarMenuMode === 'inline' \|\| topbarMenuMode === 'compact'"\s+trigger-class="btn small topbar-export"/, '导出没有在 ⋯ 档保留');
  assert.match(view, /:show-label="showExportLabel"/, '导出的手机档只剩图标规则没有接上');
  assert.match(view, /const showExportLabel = computed\(\(\) => topbarMenuMode\.value === 'inline' \|\| !narrowEditor\.value\)/, '桌面 ⋯ 档不该收起导出文案');
  assert.match(view, /<template v-if="topbarMenuMode === 'mini'">/, 'mini 档主操作没有进菜单');
  // 菜单里确实带着原来的两组低频项
  assert.match(view, /class="more-group" role="group" aria-label="正文宽度"/, '⋯ 菜单缺正文宽度');
  assert.match(view, /class="more-group more-row"[\s\S]{0,400}aria-label="自动保存"/, '⋯ 菜单缺自动保存开关');
  // 点空白 / 换档位要收起菜单
  assert.match(view, /function onMoreMenuPointerDown/, '⋯ 菜单没有点空白收起');
  assert.match(
    view,
    /function onTopbarModeChange\(\) \{\s*moreMenuOpen\.value = false;\s*widthMenuOpen\.value = false;/,
    '换档位没有收起 ⋯ 菜单与正文宽度菜单',
  );
  assert.match(view, /watch\(topbarMenuMode, onTopbarModeChange\)/, '档位变化没有接上收菜单');
  // 视觉：白卡浮层
  assert.match(view, /\.topbar-more-menu \{[\s\S]{0,600}background: var\(--card-bg\)/, '⋯ 菜单没有沿用白卡浮层');
  // 菜单不能比顶栏宽：mini 档正文只剩一百多像素，超出就会被左侧文件树盖住
  assert.match(view, /width: min\(224px, calc\(100% - 16px\)\)/, '⋯ 菜单没有按顶栏宽度收窄');
});
