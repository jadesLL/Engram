import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topbarDensityFor, topbarWidthFor } from './topbarFit.ts';

/**
 * 编辑顶栏密度的护栏（2026-11-19）。
 *
 * 起因（用户报障）：窗口 ~920px + 内置 Agent 抽屉 dock 时，正文只剩 ~476px，
 * 顶栏把「已保存」挤到悬浮胶囊外面、自动保存开关压到抽屉底下。
 * 版式没法单测，这里断两件事：①分档函数的阈值；②视图里确实按档位收文案。
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

test('密度分档：全量 → 精简 → 图标 → 极窄', () => {
  assert.equal(topbarDensityFor(0), 'full', '还没量到宽度时首帧保持全量');
  assert.equal(topbarDensityFor(520), 'full');
  assert.equal(topbarDensityFor(500), 'full');
  assert.equal(topbarDensityFor(499), 'compact');
  assert.equal(topbarDensityFor(380), 'compact');
  assert.equal(topbarDensityFor(379), 'mini');
  assert.equal(topbarDensityFor(340), 'mini');
  assert.equal(topbarDensityFor(339), 'micro');
  assert.equal(topbarDensityFor(311), 'micro');
  assert.equal(topbarDensityFor(255), 'micro');
  assert.equal(topbarDensityFor(254), 'nano', '连字号都放不下时只剩保存态');
});

test('返回键与手动保存按钮会额外占宽，分档要跟着提前', () => {
  // 全量档返回键带文案（~130）、保存按钮带文案（~63）
  assert.equal(topbarDensityFor(520, { hasBack: true }), 'compact', '带返回键时 520 放不下全量档');
  assert.equal(topbarDensityFor(629, { hasBack: true }), 'compact');
  assert.equal(topbarDensityFor(630, { hasBack: true }), 'full');
  // 关掉自动保存后多一颗「保存」：精简档起只剩图标（~30）
  assert.equal(topbarDensityFor(420, { manualSave: true }), 'compact');
  assert.equal(topbarDensityFor(379, { manualSave: true }), 'mini');
  assert.equal(topbarDensityFor(370, { manualSave: true }), 'mini');
  assert.equal(topbarDensityFor(369, { manualSave: true }), 'micro');
});

test('视图按档位收文案：引用位置 / 返回 / 自动保存 / 导出 / 正文宽度', () => {
  const view = readSrc('views/EditorView.vue');
  assert.match(
    view,
    /:class="\[`topbar-\$\{topbarDensity\}`, \{ 'topbar-tight': topbarDensity !== 'full' \}\]"/,
    '顶栏没有绑定密度档位与共用收缩类',
  );
  assert.match(
    view,
    /const topbarDensity = computed\(\(\) =>\s*topbarDensityFor\(topbarWidthFor\(availableWidth\.value, narrowEditor\.value\), \{/,
    '密度没有按顶栏自身宽度计算（抽屉 / 文件树开合都要能改档）',
  );
  // 非全量档共用：三处文案收起
  assert.match(
    view,
    /\.topbar-tight \.topbar-back span,\s*\.topbar-tight \.topbar-ref span,\s*\.topbar-tight \.autosave-toggle em,/,
    '非全量档没有收「返回上一页 / 引用位置 / 自动保存」的文案',
  );
  // mini：导出收成图标 + 箭头（通过 PageExportMenu 的 showLabel）
  assert.match(
    view,
    /:show-label="topbarDensity === 'full' \|\| topbarDensity === 'compact'"/,
    'mini 档没有收「导出」文案：图标 + 箭头仍占一整颗按钮宽',
  );
  // micro：正文宽度整颗收起
  assert.match(view, /\.topbar-micro \.width-picker \{ display: none; \}/, '极窄档还留着正文宽度选择器');
  // nano：文件树 + 抽屉同时占位时只留保存态
  assert.match(
    view,
    /\.topbar-nano \.topbar-ref,\s*\.topbar-nano \.topbar-back,\s*\.topbar-nano \.export-menu-wrap,/,
    'nano 档没有收起除保存态外的控件：正文只剩一窄条时会溢出胶囊',
  );
  // 引用位置的图标热区（文案收起后仍要 ~44px）
  assert.match(view, /\.topbar-tight \.topbar-ref::after/, '引用位置收成图标后没有补热区');
});
