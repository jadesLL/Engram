import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 设置页用 v-show 切换大类（面板常驻挂载，切回来不重拉数据）。但 v-show 只能作用在
 * **单根**组件上：多根（fragment）组件的 v-show 会被 Vue 忽略——指令没有可作用的那一个
 * 根元素，面板于是漏进每一个分类里。2026-09-22 用户报「存储空间在哪个选项里都有」正是
 * 这个：StoragePanel 的模板是两个 `<section>`（回收站 / 图片资产）。
 *
 * 改版后 v-show 一律挂在大类容器（`<section class="settings-domain" v-show>`）上，
 * 组件自己不带 v-show——容器是普通单根元素，多根面板放在里面天然安全。
 * 这里锁两条：① 组件上不许再出现 v-show（多根陷阱的老写法）；② 大类容器仍在，
 * 且多根的 StoragePanel 仍用 v-if 挂载（切走即卸载，避免无谓拉取两个列表）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const viewsDir = path.resolve(here, '..', 'views');
const settingsDir = path.resolve(here, '..', 'components', 'settings');

/** 取模板体（<template>…</template>），去掉注释 */
function templateBody(file: string): string | null {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/<template>([\s\S]*?)\n<\/template>/);
  return m ? m[1].replace(/<!--[\s\S]*?-->/g, '') : null;
}

/** 模板顶层元素标签名（用深度扫描，自闭合与嵌套都算得对） */
function templateRoots(body: string): string[] {
  const tops: string[] = [];
  let depth = 0;
  const tagRe = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body))) {
    const [, closing, tag, , selfClose] = m;
    if (closing) {
      depth -= 1;
      continue;
    }
    if (depth === 0) tops.push(tag);
    if (!selfClose) depth += 1;
  }
  return tops;
}

test('设置页不在组件上用 v-show，只在单根的大类容器上切换', () => {
  const view = fs.readFileSync(path.join(viewsDir, 'SettingsView.vue'), 'utf8');
  const componentVShow = [...view.matchAll(/<([A-Z][\w]*)([^>]*?)v-show([^>]*?)\/?>/g)].map((m) => m[1]);
  assert.deepEqual(
    componentVShow,
    [],
    `这些组件直接带了 v-show：${componentVShow.join(', ')}——v-show 只作用在单个根元素上，`
      + '多根组件（如 StoragePanel）会被忽略而漏进所有分类；请把 v-show 提到大类 <section> 容器上，或改用 v-if',
  );
  const sections = [...view.matchAll(/<section[^>]*v-show[^>]*>/g)];
  assert.ok(sections.length >= 4, `只检查到 ${sections.length} 个大类容器，SettingsView 结构可能变了`);
});

test('多根的 StoragePanel 用 v-if 挂载（v-show 与多根不兼容）', () => {
  // 直接锁「多根 ⇒ 必须 v-if」这条耦合：哪天 StoragePanel 改成单根，第一条测试会继续通过，
  // 但这里的 v-if 就可以换回 v-show（恢复常驻挂载）——届时这条会失败，提醒一并调整。
  const body = templateBody(path.join(settingsDir, 'StoragePanel.vue'));
  assert.ok(body);
  const roots = templateRoots(body).length;
  const view = fs.readFileSync(path.join(viewsDir, 'SettingsView.vue'), 'utf8');
  const tag = view.match(/<StoragePanel[^>]*\/?>/)?.[0] || '';
  if (roots > 1) {
    assert.match(tag, /v-if=/, `StoragePanel 有 ${roots} 个根元素，必须用 v-if 挂载`);
    assert.doesNotMatch(tag, /v-show=/, 'v-show 在多根组件上会被忽略，面板会漏进所有分类');
  } else {
    assert.match(tag, /v-show=/, 'StoragePanel 已是单根，可以换回 v-show 常驻挂载');
  }
});
