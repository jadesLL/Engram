import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 后台任务失败入口（2026-11-22）的静态护栏。
 *
 * 用户报障：首页「1 项失败 · 去处理」点进去只有 Agent 设置，压根看不到那条失败；
 * 而 11-06 的一次旧失败会让卡片永远显示「1 项失败」。
 *
 * 锁住三条契约，防止回退成「数字有、入口没有」：
 *   ① 「后台任务」行/摘要行打开真实的任务抽屉，不再跳设置页；
 *   ② 抽屉的失败清单与徽标同口径（服务端 failures + failed），可逐条/全部忽略；
 *   ③ 忽略走 POST /api/jobs/acknowledge，抽屉在 App.vue 全局挂载。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('后台任务失败：首页「后台任务」行打开任务抽屉，不再跳 Agent 设置', () => {
  const system = read('components/HomeBoardModules/HomeSystem.vue');
  assert.match(system, /openJobsDrawer\(\)/, '后台任务行没有接真实入口');
  assert.doesNotMatch(
    system,
    /@click="\$emit\('go', '\/settings\?section=agent'\)"/,
    '后台任务行又跳回了不列任务的 Agent 设置页'
  );
  const board = read('components/HomeBoard.vue');
  assert.match(board, /action:'jobs'/, '磁贴/横条摘要的「失败/执行/排队」行没有指向任务抽屉');
  assert.match(board, /row\.action === 'jobs'/, '摘要行 action=jobs 没有对应处理分支');
});

test('后台任务失败：抽屉按服务端 failures 渲染，支持逐条与全部忽略', () => {
  const drawer = read('components/JobsDrawer.vue');
  assert.match(drawer, /app\.jobs as any\)\?\.failures/, '抽屉没有读服务端筛好的 failures');
  assert.match(drawer, /\/api\/jobs\/acknowledge/, '忽略动作没有走确认接口');
  assert.match(drawer, /全部忽略/, '缺少全部忽略入口');
  assert.match(drawer, /最近 7 天/, '没有向用户说明失败提醒的时间窗');
  assert.match(drawer, /pointer: coarse/, '忽略按钮没有给触屏留热区');
  const app = read('App.vue');
  assert.match(app, /<JobsDrawer \/>/, '任务抽屉没有全局挂载，摘要卡/其他入口打不开');
});

test('后台任务失败：store 保留 failures 字段，首屏不会读成 undefined', () => {
  const store = read('stores/app.ts');
  assert.match(store, /failures: \[\] as any\[\]/, 'jobs 初始状态缺少 failures');
});
