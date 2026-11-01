import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 手机档编辑器「插入」面板护栏（2026-11 安卓改版）。
 *
 * 用户报障：手机上写东西时要插图 / 表格 / 代码块，只能靠 Vditor 那条横向滚动的工具栏——
 * 手机工具栏只保留 10 个高频项，表格、代码、引用、待办、分割线这些根本点不到。
 * 修法：工具栏尾部加一个「插入」入口，打开分组底部面板，九项动作各自复用编辑器已有能力。
 *
 * 版式与真实点击没法单测，沿用仓库惯例按源码锁关键声明：丢掉任何一条，这个面板就会退回去。
 * 只读 MarkdownEditor.vue 一个文件——别的文件同时在改，这里不读也不断言它们的行号。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const viewPath = path.resolve(here, '..', 'components', 'MarkdownEditor.vue');
const source = fs.readFileSync(viewPath, 'utf8');

/** 取选择器声明块（目标规则都不嵌套，[^}] 够用；选择器只含点号，无需完整转义） */
function ruleBody(selector: string): string {
  const pattern = new RegExp('(?:^|\\n)[ \\t]*' + selector.replace(/\./g, '\\.') + '[ \\t]*\\{([^}]*)\\}');
  const m = source.match(pattern);
  assert.ok(m, '找不到规则 ' + selector);
  return m ? m[1] : '';
}

test('手机工具栏尾部有「插入」自定义项，桌面工具栏与桌面宽度都不出现', () => {
  assert.match(source, /name: 'engram-insert'/, '没有注册插入工具栏项：手机工具栏尾部没有入口');
  assert.match(source, /tip: '插入（图片 \/ 文件 \/ 表格…）'/, '插入按钮没有可读的提示/aria-label');
  assert.match(source, /click: \(\) => openInsertPanel\(\)/, '插入按钮没接到底部面板');
  const mobile = source.match(/const mobileToolbar = \[([\s\S]*?)\];/);
  assert.ok(mobile, '找不到 mobileToolbar');
  assert.match(mobile ? mobile[1] : '', /insertToolbarItem/, '手机工具栏里没有插入项');
  const desktop = source.match(/const desktopToolbar = \[([\s\S]*?)\];/);
  assert.ok(desktop, '找不到 desktopToolbar');
  assert.doesNotMatch(desktop ? desktop[1] : '', /insertToolbarItem/, '桌面工具栏混进了插入项：桌面不该出现这个按钮');
  assert.match(
    source,
    /@media \(min-width: 769px\) \{\s*:deep\(\.vditor-toolbar button\[data-type="engram-insert"\]\) \{ display: none !important; \}\s*\}/,
    '从手机档放大到桌面档时没有兜底藏掉插入按钮：Vditor 工具栏初始化后不会重建',
  );
});

test('底部面板：Teleport 到 body、遮罩可关、抓柄 + 22px 顶圆角 + 44px 行高', () => {
  assert.match(source, /<Teleport to="body">[\s\S]{0,400}?class="insert-sheet"/, '插入面板没有 Teleport 到 body：会被编辑器的滚动/裁剪容器吃掉');
  assert.match(source, /class="insert-mask" @click="closeInsertPanel\(\)"/, '面板没有「点遮罩关闭」的入口');
  assert.match(source, /class="insert-grab"/, '面板缺抓手，看不出是一张可以推下去的下侧弹窗');
  const sheet = ruleBody('.insert-sheet');
  assert.match(sheet, /position: fixed/, '面板不是固定贴底的弹层');
  assert.match(sheet, /border-radius: 22px 22px 0 0/, '面板顶圆角不是 22px：与设计稿的底部面板语言不一致');
  assert.match(ruleBody('.insert-row'), /min-height: 44px/, '插入行不到 44px：手机上手指标不准');
  assert.match(ruleBody('.insert-x'), /width: 44px/, '面板关闭按钮不到 44px');
  // 面板样式只在手机档生效（桌面就算被程序打开也不受影响）
  assert.match(source, /@media \(max-width: 768px\) \{\s*\.insert-mask \{/, '面板样式没有包在手机档媒体查询里');
  assert.match(source, /\.insert-file-input \{ display: none; \}/, '隐藏的原生文件选择器会占位');
});

test('九项动作齐全：图片 / 文件 / 表格 / 代码块 / 引用 / 待办 / 分割线 / 双链 / 链接', () => {
  for (const key of ['image', 'file', 'table', 'code', 'quote', 'todo', 'hr', 'wikilink', 'link']) {
    assert.match(source, new RegExp("key: '" + key + "'"), '插入面板缺动作：' + key);
  }
  // 2×2 表格片段（表头 + 一行数据，两列）
  assert.ok(
    source.includes("const INSERT_TABLE = '\\n| 列 1 | 列 2 |\\n| --- | --- |\\n|  |  |\\n';"),
    '表格片段不是 2×2（表头 + 一行数据、两列）',
  );
  assert.ok(
    source.includes("const INSERT_CODE = '\\n```\\n\\n```\\n';"),
    '代码块片段不是围栏代码块',
  );
  // 所有块级项都走 vditor.insertValue；插入前先恢复打开面板前的选区
  assert.match(source, /vditor\?\.insertValue\(snippet\)/, '块级插入没有走 vditor.insertValue');
  assert.match(
    source,
    /function insertSnippet\(snippet: string\): void \{\s*restoreEditorSelection\(\);/,
    '插入前没有恢复打开面板前的光标：内容会插到面板按钮上',
  );
  // 双链复用 [[ 候选弹窗；链接复用 Vditor 自带的 link 面板
  assert.match(source, /openLinkPopup\(\)/, '双链没有复用 [[ 候选弹窗');
  assert.match(source, /triggerVditorToolbar\('link'\)/, '链接没有复用 Vditor 的链接面板');
});

test('图片 / 文件走既有上传接口，成功后插回光标处，失败要报出来', () => {
  assert.match(source, /api\.post\('\/api\/assets\/upload', fd\)/, '图片没有走页面资产上传接口');
  assert.match(source, /fd\.append\('parent', pageId\)/, '图片上传没有带父项页面 id：服务端会拒绝裸图');
  assert.match(source, /api\.post\('\/api\/files\/upload', fd\)/, '文件没有走原始资料上传接口');
  assert.match(source, /fd\.append\('dir', '原始资料\/文档'\)/, '文件上传没有落到「原始资料/文档」：与侧栏导入口径不一致');
  assert.match(
    source,
    /function restoreInsertFocus\(\): void \{\s*void nextTick\(\(\) => \{\s*restoreEditorSelection\(\);\s*vditor\?\.focus\(\);/,
    '关面板 / 取消文件选择器没有把焦点与光标还给编辑器',
  );
  assert.match(source, /notify\.error\(error\?\.response\?\.data\?\.error \|\| error\?\.message \|\| '图片上传失败'\)/, '图片上传失败没有提示');
});

test('返回键与 Esc 都能关面板（安卓习惯）', () => {
  assert.match(source, /registerBackHandler\(/, '插入面板没有接管安卓返回键：手机按返回会直接退出编辑');
  assert.match(source, /if \(insertOpen\.value\) \{\s*closeInsertPanel\(\);/, '返回键处理里没有先关插入面板');
  assert.match(source, /event\.key === 'Escape'[\s\S]{0,80}?closeInsertPanel\(\)/, '面板里按 Esc 关不掉');
});
