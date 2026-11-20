import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_LANG_NOTES, codeLangNote, decorateCodeLangHint } from './codeBlockLangNotes.ts';

/**
 * 代码块语言下拉的中文注解（用户报障：输入 ``` 后的 plantuml / flowchart / graphviz 看不懂）。
 *
 * 两件事要守住：
 *  ① 注解只改显示：按钮的 data-value 必须保持原样，否则插进正文的语言标记会变成中文；
 *  ② 图形类语言（Vditor 内置的前 8 项）一个都不能漏——它们正是用户看不懂的那一批。
 */

/** Vditor 的 Constants.ALIAS_CODE_LANGUAGES（`src/ts/constants.ts`），提示列表前 16 项就是它们 */
const VDITOR_ALIAS_LANGUAGES = [
  'abc', 'plantuml', 'mermaid', 'flowchart', 'echarts', 'mindmap', 'graphviz', 'math',
  'markmap', 'smiles', 'js', 'ts', 'html', 'toml', 'c#', 'bat',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', '..');
const readMain = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

test('Vditor 内置的绘图 / 特殊语言都有中文注解', () => {
  for (const language of VDITOR_ALIAS_LANGUAGES) {
    assert.ok(codeLangNote(language), `${language} 没有中文注解：用户还是只能看到一个英文名`);
  }
  assert.equal(codeLangNote('plantuml'), 'UML 图');
  assert.equal(codeLangNote('mindmap'), '思维导图');
  assert.equal(codeLangNote('math'), '数学公式');
});

test('查表忽略大小写与首尾空格，生僻语言不加注解', () => {
  assert.equal(codeLangNote(' PlantUML '), 'UML 图');
  assert.equal(codeLangNote('JS'), 'JavaScript');
  assert.equal(codeLangNote('kotlin'), '', '没有对应中文时保持原样，不硬造一句');
  assert.ok(!('' in CODE_LANG_NOTES));
});

/** 手搓一个够用的按钮：只实现被 decorateCodeLangHint 用到的几个成员 */
function fakeButton(value: string) {
  const children: Array<{ className: string; textContent: string }> = [];
  const button = {
    children,
    ownerDocument: {
      createElement: () => ({ className: '', textContent: '' }),
    },
    getAttribute: (name: string) => (name === 'data-value' ? encodeURIComponent(value) : null),
    querySelector: (selector: string) => children.find((child) => `.${child.className}` === selector) ?? null,
    appendChild: (child: { className: string; textContent: string }) => {
      children.push(child);
      return child;
    },
  };
  return button;
}

test('注解挂在按钮末尾，data-value 不动（选中后写进围栏的仍是英文语言标记）', () => {
  const plantuml = fakeButton('plantuml');
  const unknown = fakeButton('kotlin');
  const root = { querySelectorAll: () => [plantuml, unknown] };

  const decorated = decorateCodeLangHint(root as unknown as ParentNode);

  assert.equal(decorated, 1, '只给查得到的语言加注解');
  assert.equal(plantuml.children.length, 1);
  assert.equal(plantuml.children[0].className, 'eg-code-lang-note');
  assert.equal(plantuml.children[0].textContent, 'UML 图');
  assert.equal(plantuml.getAttribute('data-value'), 'plantuml', '不能改写按钮的值');
  assert.equal(unknown.children.length, 0);

  // Vditor 重绘会换掉整棵 DOM；同一个按钮被观察回调再扫一遍时不能叠第二份
  assert.equal(decorateCodeLangHint(root as unknown as ParentNode), 0);
});

test('编辑器把注解接到 Vditor 的提示面板上，并在卸载时断开', () => {
  const editor = readMain('web/src/components/MarkdownEditor.vue');
  assert.match(editor, /import \{ decorateCodeLangHint \} from '\.\.\/lib\/codeBlockLangNotes';/);
  assert.match(editor, /vditor\?\.vditor\?\.hint\?\.element/, '注解要挂在 Vditor 的语言提示面板上');
  assert.match(editor, /new MutationObserver\(\(\) => decorateCodeLangHint\(hint\)\)/, '面板重绘后要重新补注解');
  assert.match(editor, /codeLangHintObserver\?\.disconnect\(\)/, '离开编辑页要断开观察');
  assert.match(editor, /\.eg-code-lang-note/, '注解样式缺失：中文会和语言名糊成一个词');
});
