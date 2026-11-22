import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 换页手感护栏（2026-11-22 用户报障）：
 *   ① 阅读态切原始资料 / 笔记时白屏两三秒才出字——根因是没有代码块的页面也在等
 *      highlight.js（Vditor 对无代码页根本不会加载 hljs），白等满 2s 才把正文放进 DOM；
 *   ② 每次切换整块闪一下——换页时骨架屏把已有正文盖掉，几百毫秒又撤掉；
 *   ③ Wiki 行与原始资料行「字体不一样」——Claude 主题把宽字距 / 大写字形 / 灰字
 *      加在 .sidebar-category 包装层上，被里面的页面行整行继承。
 *
 * 版式仍靠真实页面截图验收；这里锁住三条根因，防止重构时又加回去。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

test('阅读态：只有存在未高亮代码块时才等 highlight.js', () => {
  const reading = read('components/ReadingPreview.vue');
  assert.match(
    reading,
    /const hasPendingCodeBlock = Array\.from\(next\.querySelectorAll<HTMLElement>\('pre code'\)\)[\s\S]{0,260}?classList\.contains\('hljs'\)/,
    '没有先判断「是否真的有待高亮代码块」',
  );
  assert.match(
    reading,
    /if \(hasPendingCodeBlock\) \{\s*for \(let i = 0; i < 20; i\+\+\)/,
    'hljs 等待循环没有被 hasPendingCodeBlock 包住：普通笔记切页又会白等 2s',
  );
});

test('换页：不再用骨架屏盖住已有正文（阅读 / 编辑 / 状态栏）', () => {
  const editor = read('views/EditorView.vue');
  assert.doesNotMatch(editor, /page-skeleton/, '换页骨架屏又回来了：每次切换会闪一下');
  assert.doesNotMatch(editor, /AppSkeleton/, '骨架组件不该再挂在编辑页换页路径上');
  assert.match(
    editor,
    /<ReadingPreview[\s\S]{0,120}v-show="!pageError"/,
    '阅读视图又在 pageLoading 时被隐藏：换页会先白屏再出字',
  );
  assert.match(
    editor,
    /v-show="!app\.readingMode && !pageError" class="editor-body"/,
    '编辑区可见性没有脱离 pageLoading',
  );
  assert.match(editor, /v-show="!pageError" class="statusbar chrome-float"/, '状态栏换页时又整条闪没');
  // 首次加载（还没有任何页面）仍要有加载态：外层 spinner 不能被一起删掉
  assert.match(editor, /v-else-if="pageLoading \|\| pageError"/, '首次加载的 spinner 丢了');
});

test('根路由：不能按完整路径重挂 Home，否则切页会把整个外壳卸载重建', () => {
  const app = read('App.vue');
  // 注释里会写明「不要加 :key」，断言只看真实模板
  const template = app.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(template, /:key="route\.path"/, '根 router-view 又按 route.path 打 key：侧栏/编辑页会整块重建并闪白');
  assert.match(template, /<router-view v-slot="\{ Component \}">/, '根 router-view 的 slot 里又取了 route（通常是为了重新加 key）');
  assert.match(template, /<Transition name="page">/, '路由入场淡入丢了');
});

test('侧栏字体：宽字距 / 大写字形只给眉标，不能加在 .sidebar-category 包装层上', () => {
  const css = read('styles/claude-code.css');
  const eyebrow = css.match(
    /\.sidebar-titlebar \.eyebrow,\s*\.sidebar-section-title,?\s*\.sidebar-category\s*\{[^}]*\}/,
  );
  assert.equal(eyebrow, null, '宽字距又挂回 .sidebar-category：Wiki 页面行会整行继承，和原始资料行不一致');
  assert.match(
    css,
    /\.sidebar-titlebar \.eyebrow,\s*\.sidebar-section-title\s*\{[^}]*letter-spacing: \.16em;/,
    '眉标自己的宽字距定义丢了',
  );
});
