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

test('⑥ 长按多选：500ms 进选择态、全选只勾可见条目、批量动作串行复用既有接口', () => {
  // 长按阈值与「移动就取消」：按住不动 500ms 才进选择态，滑动先取消计时
  assert.match(source, /const LONG_PRESS_MS = 500;/, '长按阈值不是 500ms');
  assert.match(source, /const LONG_PRESS_MOVE_PX = 10;/, '没有「移动超阈值就取消长按」的常量');
  assert.match(
    source,
    /longPressTimer = setTimeout\(\(\) => \{[\s\S]{0,500}?enterSelectMode\(item\);[\s\S]{0,40}?\}, LONG_PRESS_MS\);/,
    '长按没有在 500ms 后进入选择态',
  );
  assert.match(
    source,
    /if \(Math\.abs\(dx\) > LONG_PRESS_MOVE_PX \|\| Math\.abs\(dy\) > LONG_PRESS_MOVE_PX\) cancelLongPress\(\);/,
    '手指移动后没有取消长按：滑一半会掉进选择态',
  );
  assert.match(
    source,
    /function enterSelectMode\(item: InboxItem\): void \{[\s\S]{0,500}?haptic\('tap'\);/,
    '进入选择态没有触觉提示',
  );

  // 选择态与手势互斥：进入后不再接管滑动手势，卡片堆也让位给多选列表
  assert.match(
    source,
    /function onCardPointerDown\(event: PointerEvent\): void \{\s*\/\/ 选择态与手势互斥[\s\S]{0,140}?if \(selectMode\.value\) return;/,
    '选择态下没有停用卡片手势：多选时误滑会把条目滑走',
  );
  assert.match(source, /v-if="view === 'stack' && !selectMode"/, '选择态没有把卡片堆藏起来');

  // 顶栏：取消 / 已选 N 条 / 全选；全选只作用于当前可见列表
  for (const text of ['取消', '已选 {{ selectedPaths.length }} 条', '全选']) {
    assert.ok(source.includes(text), '选择态顶栏缺「' + text + '」');
  }
  assert.match(
    source,
    /const selectableItems = computed<InboxItem\[\]>\(\(\) => sortedActive\.value\);/,
    '选择态列表不是当前可见条目：全选会勾到看不见的条目',
  );
  assert.match(
    source,
    /selectedPaths\.value = allSelected\.value \? \[\] : selectablePaths\.value\.slice\(\);/,
    '全选没有按可见列表勾选',
  );

  // 批量入库：已转换的串行 adopt；待整理的走既有批量 convert；进度写进选择态副标题
  assert.match(
    source,
    /await inbox\.adopt\(item\.path\);[\s\S]{0,160}?batchProgress\.value = \{ done: batchProgress\.value\.done \+ 1/,
    '批量入库没有串行调用单条入库并记录进度',
  );
  assert.match(
    source,
    /inbox\.convert\(convertible\.map\(\(item\) => item\.path\)\)/,
    '待整理的选中项没有交给现有的批量转换接口',
  );
  assert.match(source, /batchBusy\.value === 'adopt'/, '没有批量入库进行中状态');

  // 批量回收站：逐条 remove + 一次找回回收站 id 供 Snackbar 撤销
  assert.match(
    source,
    /for \(const item of items\) \{\s*try \{\s*await inbox\.remove\(item\.path\);/,
    '批量回收站没有逐条调用现有删除接口',
  );
  assert.match(source, /async function trashIdsFor\(paths: string\[\]\)/, '批量删除后没有找回回收站 id：无法撤销');
  assert.match(source, /api\.post\('\/api\/trash\/restore', \{ ids \}\)/, '批量撤销没有走回收站恢复接口');

  // 打标签：服务端没有收集箱条目标签接口 → 按钮置灰并写明原因（任务允许的降级）
  assert.match(
    source,
    /class="mi-bar-sub" type="button" disabled title="暂不可用：收集箱条目不是知识库页面/,
    '打标签没有标为不可用并说明',
  );
  assert.ok(
    source.includes('打标签暂不可用：收集箱条目不是知识库页面；入库后到页面里打标签。'),
    '选择态里没有可见的「打标签不可用」原因',
  );

  // 长按松手那次 click 可能落到刚渲染的列表行上：要有短守卫，别一松手就把刚选中的行点掉
  assert.match(
    source,
    /if \(Date\.now\(\) < selectGuardUntil\) return;/,
    '长按松手后的 click 没有兜底：刚进选择态会立刻把选中的行点掉',
  );

  // 退出：取消按钮 / Esc / 安卓返回键；批量请求进行中不中途退出
  assert.match(source, /@click="exitSelectMode">取消/, '顶栏「取消」没有退出选择态');
  assert.match(source, /if \(selectMode\.value && !batchBusy\.value\) exitSelectMode\(\);/, 'Esc 没有退出选择态');
  assert.match(
    source,
    /if \(selectMode\.value\) \{[\s\S]{0,200}?if \(!batchBusy\.value\) exitSelectMode\(\);/,
    '安卓返回键没有退出选择态',
  );

  // 触控：行高 ≥44、勾选框 ::after 补到 44、选中行背景 accent-soft、不做长动画
  const row = ruleBody('.mi-select-row');
  const rowHeight = Number((row.match(/min-height:\s*(\d+)px/) || [])[1] || 0);
  assert.ok(rowHeight >= 44, '选择态行高不到 44px：手机上手指标不准');
  assert.match(ruleBody('.mi-select-row.is-on'), /background:\s*var\(--accent-soft\)/, '选中行背景没用 accent-soft');
  assert.doesNotMatch(row, /transition:/, '选中态不要长动画：行背景不该有过渡');
  assert.match(ruleBody('.mi-checkbox'), /width:\s*24px/, '勾选框视觉尺寸变了');
  const checkboxAfter = ruleBody('.mi-checkbox::after');
  assert.match(checkboxAfter, /content:\s*''/, '勾选框没有扩热区伪元素');
  assert.match(checkboxAfter, /left:\s*-10px/, '勾选框没有把命中区补到 44px');
  assert.match(ruleBody('.mi-bar-select'), /grid-template-columns/, '批量动作条没有独立列宽');
});
