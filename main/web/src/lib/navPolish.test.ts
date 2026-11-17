import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 2026-11-17 导航美化护栏：
 *  ① 图标栏拆成上下两枚胶囊（原来是一根拉满高度的玻璃条 + flex spacer，中段空得像断了）；
 *  ② 设置左栏的二级目录补上展开提示、父项降级、导引线与 0fr→1fr 展开；
 *  ③ 折叠时高度必须真的是 0（给二级列表加 padding 会把 0fr 轨道撑成 8px），
 *     且收起的组要 inert，Tab 不能落到看不见的按钮上。
 * 版式没法用单测跑，沿用仓库既有做法：按源码锁关键声明，防止改回旧结构。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const homePath = path.resolve(here, '..', 'views', 'Home.vue');
const settingsPath = path.resolve(here, '..', 'views', 'SettingsView.vue');
const settingsCssPath = path.resolve(here, '..', 'styles', 'settings.css');
const home = fs.readFileSync(homePath, 'utf8');
const view = fs.readFileSync(settingsPath, 'utf8');
const css = fs.readFileSync(settingsCssPath, 'utf8');

function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`));
  assert.ok(m, `找不到规则 ${selector}`);
  return m ? m[1] : '';
}

test('图标栏：上下两枚玻璃胶囊，不再用 flex spacer 撑出中段空洞', () => {
  assert.match(home, /class="rail-cluster rail-cluster-nav"/, '导航胶囊不见了：图标栏又回到一根拉满高度的长条');
  assert.match(home, /class="rail-cluster rail-cluster-tools"/, '工具胶囊不见了：底部动作又混进导航组');
  assert.doesNotMatch(home, /rail-spacer/, 'flex spacer 回来了：中段空白会重新变成一根被拉长的玻璃条');
  assert.match(
    ruleBody(home, '.rail-cluster'),
    /background:\s*var\(--sidebar-rail-material\)/,
    '胶囊没有玻璃材质：拆开后会变成两个没有底的图标组',
  );
  assert.doesNotMatch(home, /\.rail-btn\.active::before/, '选中态又叠回两套信号（填充 + 外置竖条）');
});

test('设置目录：展开提示、父项降级、导引线与 0fr 展开', () => {
  assert.match(view, /class="settings-nav-chevron"/, '大类行尾缺少 chevron：用户仍不知道点开还有二级分组');
  assert.match(view, /:aria-expanded="activeDomain === domain\.id"/, '大类的 aria-expanded 没跟上展开状态');
  assert.match(
    view,
    /:inert="activeDomain === domain\.id \? undefined : true"/,
    '收起的二级目录没有 inert：Tab 会落到看不见的按钮上',
  );
  assert.match(
    ruleBody(css, '.settings-nav-domain.is-expanded .settings-nav-item.active'),
    /background:\s*transparent/,
    '展开后父项仍画白卡：父项和二级项会同时像「选中」',
  );
  assert.match(
    ruleBody(css, '.settings-nav-sub-wrap'),
    /grid-template-rows:\s*0fr/,
    '二级目录没有 0fr 收起轨道：展开/收起会瞬间跳变',
  );
  assert.match(
    ruleBody(css, '.settings-nav-sub-wrap'),
    /overflow:\s*hidden/,
    '二级目录 wrap 不裁切：0fr 收起的条目会漏出来',
  );
  assert.match(
    ruleBody(css, '.settings-nav-sub'),
    /padding:\s*0/,
    '二级列表又加了 padding：0fr 轨道会被撑出高度（实测 8px），收起的组仍占位',
  );
});

test('设置目录：展开后把当前大类带回列表视野', () => {
  assert.match(view, /function revealActiveDomain\(/, '缺少展开后的滚动定位：靠下的大类展开后会落在可视区外');
  assert.match(view, /scheduleRevealActiveDomain\(id\)/, '切换大类后没有安排滚动定位');
  assert.match(view, /clearTimeout\(revealDomainTimer\)/, '滚动定位的定时器没有清理：切来切去会互相打架');
});
