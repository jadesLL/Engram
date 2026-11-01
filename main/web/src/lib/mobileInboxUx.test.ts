import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 手机收集箱卡片台（MobileInbox.vue）的接线护栏（2026-11 安卓改版）。
 *
 * 用户报障三件事：①手指按在卡片上下滑，页面不动（touch-action:none 吃掉了纵向滚动）；
 * ②360×640 级小屏首屏放不下，底部三个动作按钮落在首屏之外；③左滑进回收站没有撤销。
 * 另按改版规格补：顶栏图标 44 / 底栏按钮 48 / 提示字 ≥12.5 / 触觉反馈。
 *
 * 版式和真机观感没法单测，沿用 androidUiFit / mobileShellUx 的写法：按源码锁关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const source = fs.readFileSync(path.join(srcRoot, 'components/MobileInbox.vue'), 'utf8');

/** 取选择器声明块（目标规则都不嵌套，`[^}]` 够用） */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = source.match(new RegExp('(?:^|\\n)[ \\t]*' + escaped + '[ \\t]*\\{([^}]*)\\}'));
  assert.ok(m, '找不到规则 ' + selector);
  return m ? m[1] : '';
}

test('① 卡片区不再吞纵向滚动：pan-y + 横向 1.3 倍轴锁，纵向交给浏览器', () => {
  assert.doesNotMatch(
    source,
    /touch-action:\s*none/,
    '卡片台又出现 touch-action: none：手指按在卡片上上下滑，页面/卡片区滚不动（用户报障原话）',
  );
  assert.match(
    ruleBody('.mi-stack'),
    /touch-action:\s*pan-y/,
    '卡片堆没有把纵向手势交还浏览器：纵向拖动会被卡片吃掉',
  );
  assert.match(
    ruleBody('.mi-card.front'),
    /touch-action:\s*pan-y/,
    '最上面那张卡没有把纵向手势交还浏览器：手指落在卡面正中时滚动失效',
  );
  assert.match(source, /const AXIS_LOCK_RATIO = 1\.3;/, '没有「横向明显大于纵向才接管」的轴锁常量');
  assert.match(
    source,
    /Math\.abs\(dx\) <= Math\.abs\(dy\) \* AXIS_LOCK_RATIO/,
    '方向判定不是 |dx| > |dy|×1.3 才接管横向：斜着滑一点就把纵向滚动截走',
  );
  assert.match(source, /dragAxis\.value = 'scroll'/, '没有「判成纵向后放行」的状态');
  assert.match(source, /if \(dragAxis\.value === 'scroll'\) return;/, '判成纵向滚动后还在改 dragX：卡片会跟着手走、页面不滚');
});

test('② 360×640 首屏：装饰压缩 + 动作条钉在底栏上方，不随卡片滚动', () => {
  assert.match(ruleBody('.mi-cover'), /height:\s*96px/, '封面还是 116px：小屏上首屏放不下');
  assert.match(ruleBody('.mi-stack'), /margin-bottom:\s*32px/, '卡片错位还是 52px：首屏高度不够');
  assert.match(ruleBody('.mi-card.back-1'), /translateY\(16px\)/, '第二张卡错位没收紧');
  assert.match(ruleBody('.mi-card.back-2'), /translateY\(30px\)/, '第三张卡错位没收紧');
  // 组件高度吃满 .content 内容盒：动作条天然落在底栏上方
  assert.match(ruleBody('.mob-inbox'), /height:\s*100%/, '组件没吃满内容区高度：动作条会跟着整页滚走');
  assert.match(ruleBody('.mob-inbox'), /overflow:\s*hidden/, '组件没截断外层滚动：动作条会离开底栏上方');
  assert.match(ruleBody('.mi-stage'), /overflow-y:\s*auto/, '卡片区没有自己的滚动容器：超出一屏的卡片够不着');
  // 动作条在卡片区之后，不参与滚动
  const stageAt = source.indexOf('.mi-stage {');
  const barAt = source.indexOf('.mi-bar {');
  assert.ok(barAt > stageAt, '动作条不在卡片区之后：DOM 顺序反了');
  assert.match(ruleBody('.mi-bar'), /flex:\s*none/, '动作条没有固定占位：会被卡片区挤走');
  assert.match(ruleBody('.mi-bar'), /background:\s*var\(--bg\)/, '动作条没有底色：卡片滚过时会透出来');
  // 底栏高度/内边距口径变化时补让位
  assert.match(source, /function syncShellInset\(\)/, '没有按底栏实际高度校准的让位逻辑');
  assert.match(source, /--mi-shell-extra/, '没有让位用 CSS 变量');
});

test('③ 左滑进回收站后可撤销：Snackbar 带「撤销」，恢复走回收站 API', () => {
  assert.match(
    source,
    /import \{ notify, pushToast \} from '\.\.\/lib\/notify'/,
    '没有用现有带 action 的 toast 能力',
  );
  assert.match(source, /const trashId = await trashIdFor\(item\.path\)/, '删除后没有找回回收站条目 id：撤销无从下手');
  assert.match(source, /duration:\s*4000/, 'Snackbar 不是 4 秒自动消失');
  assert.match(source, /label: '撤销'/, 'Snackbar 没有「撤销」动作');
  assert.match(source, /clickable: true/, 'Snackbar 不能整条点：手机上「撤销」小按钮热区不够');
  assert.match(
    source,
    /api\.post\('\/api\/trash\/restore', \{ ids: \[trashId\] \}\)/,
    '撤销没有走回收站恢复接口',
  );
  // 左滑不做二次确认（按钮路径保留确认框），误滑靠撤销兜底
  assert.match(
    source,
    /function removeBySwipe\(item: InboxItem\): void \{\s*void trashItem\(item\);/,
    '左滑还在弹确认框：加速手势变成两步',
  );
  assert.match(source, /if \(dx <= -SWIPE_X\) \{\s*removeBySwipe\(item\);/, '左滑没有接到 removeBySwipe');
});

test('④ 触控目标：顶栏图标 44、动作条按钮 48、提示字 12.5、小控件 ::after 扩热区', () => {
  const icon = ruleBody('.mi-iconbtn');
  assert.match(icon, /width:\s*44px/, '顶栏图标按钮还是 36px：手机上手指标不准');
  assert.match(icon, /height:\s*44px/, '顶栏图标按钮还是 36px：手机上手指标不准');
  for (const selector of ['.mi-bar-main', '.mi-bar-sub', '.mi-bar-danger']) {
    assert.match(ruleBody(selector), /height:\s*48px/, selector + ' 不是 48px 触控高度');
  }
  assert.match(ruleBody('.mi-gesture'), /font-size:\s*12\.5px/, '手势提示还是 12px 小字');
  assert.match(ruleBody('.mi-card-note'), /font-size:\s*12\.5px/, '卡面说明还是 12px 小字');
  // 视觉高度不足 44 的可点元素：用 ::after 扩命中区
  for (const selector of ['.mi-banner button::after', '.mi-mini::after', '.mi-receipt-undo::after']) {
    const body = ruleBody(selector);
    assert.match(body, /content:\s*''/, selector + ' 没有扩热区伪元素');
    assert.match(body, /position:\s*absolute/, selector + ' 的扩热区不是绝对定位');
    assert.match(body, /top:\s*-/, selector + ' 没有向上扩热区');
  }
});

test('⑤ 触觉反馈：删除/入库成功各叫一次，手势提交有确认感', () => {
  assert.match(source, /import \{ haptic \} from '\.\.\/lib\/haptics'/, '没有接触觉反馈');
  assert.match(
    source,
    /await inbox\.remove\(item\.path\);\s*haptic\('warning'\)/,
    '移入回收站没有 warning 振动：误滑更难察觉',
  );
  assert.match(
    source,
    /await inbox\.adopt\(item\.path\);\s*app\.bumpSidebar\(\);\s*haptic\('success'\)/,
    '单条入库成功没有 success 振动',
  );
  assert.match(source, /if \(saved\) \{\s*haptic\('success'\);/, '批量入库成功没有 success 振动');
});
