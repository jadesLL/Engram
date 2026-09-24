import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';

test('paragraphs keep single line breaks and escape raw html', () => {
  assert.equal(
    renderMarkdown('第一行\n第二行\n\n第二段'),
    '<p class="md-p">第一行<br>第二行</p><p class="md-p">第二段</p>'
  );
  assert.equal(
    renderMarkdown('<script>alert(1)</script>'),
    '<p class="md-p">&lt;script&gt;alert(1)&lt;/script&gt;</p>'
  );
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('\n\n  \n'), '');
});

test('headings map one level down and stop at h6', () => {
  assert.equal(renderMarkdown('# 一级'), '<h2 class="md-heading">一级</h2>');
  assert.equal(renderMarkdown('### 三级'), '<h4 class="md-heading">三级</h4>');
  assert.equal(renderMarkdown('###### 六级'), '<h6 class="md-heading">六级</h6>');
  assert.match(renderMarkdown('## 带闭合 ##'), /<h3 class="md-heading">带闭合<\/h3>/);
  // 七个 # 不是标题，按段落走
  assert.match(renderMarkdown('####### 七级'), /^<p class="md-p">####### 七级<\/p>$/);
});

test('unordered, ordered, nested and task lists', () => {
  assert.equal(renderMarkdown('- 甲\n- 乙'), '<ul class="md-list"><li>甲</li><li>乙</li></ul>');
  assert.equal(renderMarkdown('1. 一\n2. 二'), '<ol class="md-list"><li>一</li><li>二</li></ol>');
  assert.equal(
    renderMarkdown('- 甲\n  - 甲一\n- 乙'),
    '<ul class="md-list"><li>甲<ul class="md-list"><li>甲一</li></ul></li><li>乙</li></ul>'
  );
  const tasks = renderMarkdown('- [x] 做完\n- [ ] 没做');
  assert.match(tasks, /<li class="md-task-item"><span class="md-task on" aria-hidden="true"><\/span>做完<\/li>/);
  assert.match(tasks, /<li class="md-task-item"><span class="md-task" aria-hidden="true"><\/span>没做<\/li>/);
});

test('tables render alignment and pad missing cells', () => {
  const html = renderMarkdown('| 名称 | 数量 |\n| --- | ---: |\n| 甲 | 3 |\n| 乙 |');
  assert.match(html, /^<div class="md-table-scroll"><table class="md-table"><thead><tr>/);
  assert.match(html, /<th>名称<\/th><th class="md-align-right">数量<\/th>/);
  assert.match(html, /<tr><td>甲<\/td><td class="md-align-right">3<\/td><\/tr>/);
  assert.match(html, /<tr><td>乙<\/td><td class="md-align-right"><\/td><\/tr>/);
  assert.match(html, /<\/tbody><\/table><\/div>$/);
});

test('blockquote and horizontal rule', () => {
  const html = renderMarkdown('> 引用第一行\n> 引用第二行\n\n---');
  assert.match(html, /<blockquote class="md-quote"><p class="md-p">引用第一行<br>引用第二行<\/p><\/blockquote>/);
  assert.match(html, /<hr class="md-hr">/);
  assert.match(renderMarkdown('> - 引用里的列表'), /<blockquote class="md-quote"><ul class="md-list"><li>引用里的列表<\/li><\/ul><\/blockquote>/);
});

test('inline emphasis, code and citation markers', () => {
  const html = renderMarkdown('**粗** 与 *斜* 与 `code` 与 ~~删~~ 与 [S12]');
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<em>斜<\/em>/);
  assert.match(html, /<code class="md-code">code<\/code>/);
  assert.match(html, /<del class="md-del">删<\/del>/);
  assert.match(html, /<sup class="cite">\[S12\]<\/sup>/);
  // snake_case 不该被吃成斜体
  assert.equal(renderMarkdown('snake_case_name'), '<p class="md-p">snake_case_name</p>');
});

test('links follow the protocol whitelist and wikilinks become chips', () => {
  const html = renderMarkdown('[文档](https://example.com/a) 与 [站内](/page/1) 与 [坏](javascript:void)');
  assert.match(html, /<a class="md-link" href="https:\/\/example.com\/a" target="_blank" rel="noopener noreferrer">文档<\/a>/);
  assert.match(html, /<a class="md-link" href="\/page\/1"/);
  assert.match(html, /坏（javascript:void）/);
  assert.ok(!html.includes('href="javascript'));

  const wiki = renderMarkdown('见 [[结构 / API 网关]] 与 [[董老师|负责人]]');
  assert.match(wiki, /<a class="md-wikilink" href="#wiki\/[^"]+" data-wiki="结构 \/ API 网关">结构 \/ API 网关<\/a>/);
  assert.match(wiki, /class="md-wikilink"[^>]*data-wiki="董老师">负责人<\/a>/);

  const markdownWiki = renderMarkdown('[网关](#wiki/%E7%BD%91%E5%85%B3)');
  assert.match(markdownWiki, /class="md-wikilink" href="#wiki\/%E7%BD%91%E5%85%B3" data-wiki="网关">网关<\/a>/);

  // 正文里的裸标题：链回自己的页面
  assert.match(renderMarkdown('[[待建页面]]'), /data-wiki="待建页面">待建页面<\/a>/);
});

test('images only load workspace-local sources', () => {
  assert.match(
    renderMarkdown('![图](/media/abc/pic.png)'),
    /<img class="md-img" src="\/media\/abc\/pic.png" alt="图" loading="lazy">/
  );
  const remote = renderMarkdown('![远](https://cdn.example.com/a.png)');
  assert.match(remote, /<a class="md-link" href="https:\/\/cdn.example.com\/a.png"/);
  assert.ok(!remote.includes('<img'));
  assert.match(renderMarkdown('![坏](javascript:void)'), /!\[坏\]\(javascript:void\)/);
});

test('fenced code blocks keep their body verbatim and survive streaming', () => {
  const html = renderMarkdown('```ts\nconst a = **1**;\n```');
  assert.match(html, /<pre class="md-pre"><code class="language-ts">const a = \*\*1\*\*;<\/code><\/pre>/);
  assert.ok(!html.includes('<strong>'));

  // 流式输出时收尾围栏常常还没写到：剩下的内容仍按代码块渲染
  const streaming = renderMarkdown('说明\n\n```bash\nls -la');
  assert.match(streaming, /^<p class="md-p">说明<\/p>/);
  assert.match(streaming, /<pre class="md-pre"><code class="language-bash">ls -la<\/code><\/pre>$/);
});

test('block detection does not swallow neighbouring blocks', () => {
  const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- 列表\n\n结束段落');
  const positions = [html.indexOf('<table'), html.indexOf('<ul'), html.indexOf('结束段落')];
  assert.ok(positions[0] >= 0 && positions[0] < positions[1] && positions[1] < positions[2]);

  // 单行 `---` 是分隔线，不会被当成表格的分隔行
  assert.match(
    renderMarkdown('含 | 竖线的段落\n\n---'),
    /^<p class="md-p">含 \| 竖线的段落<\/p><hr class="md-hr">$/
  );

  // 松散列表（项之间有空行）仍是一张列表
  assert.equal(renderMarkdown('- 甲\n\n- 乙'), '<ul class="md-list"><li>甲</li><li>乙</li></ul>');
});

test('repeated renders stay stable across the result cache', () => {
  const source = '# 标题\n\n- 甲\n- 乙';
  const first = renderMarkdown(source);
  assert.equal(renderMarkdown(source), first);
  // 缓存按 FIFO 截断：灌满后老键被淘汰，结果依旧一致
  for (let index = 0; index < 80; index++) renderMarkdown(`填充 ${index}`);
  assert.equal(renderMarkdown(source), first);
});
