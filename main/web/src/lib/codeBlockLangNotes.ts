/**
 * 代码块语言下拉的中文注解。
 *
 * 编辑页输入 ``` 后弹出的语言列表来自 Vditor：前 16 个是它内置的「渲染型」语言
 *（abc / plantuml / mermaid / flowchart / echarts / mindmap / graphviz / math …），
 * 后面拼 hljs 的全部语言名，全是英文。中文用户光看英文分不清这几种「用围栏画图」
 * 的语言各自画什么，所以这里维护「语言 → 一句中文」，由编辑器在提示面板渲染后补到按钮末尾。
 *
 * 为什么不用 `preview.hljs.langs` 直接写中文：那个数组里的字符串同时充当菜单文案和写进
 * 围栏的语言标记（`html` 与 `value` 是同一个字符串），写中文会把 ` ```中文 ` 插进正文，
 * 渲染链路就断了。所以注解只改显示，按钮上的 `data-value` 保持原样。
 */

export const CODE_LANG_NOTES: Readonly<Record<string, string>> = {
  // 图形 / 富内容块：英文名最看不出所以然的一类
  abc: '乐谱',
  plantuml: 'UML 图',
  mermaid: '流程图/时序图',
  flowchart: '流程节点图',
  echarts: '数据图表',
  mindmap: '思维导图',
  graphviz: '关系网络图',
  math: '数学公式',
  markmap: 'Markdown 导图',
  smiles: '化学结构式',
  // 常见代码 / 配置：缩写和别名补一句人话
  js: 'JavaScript',
  ts: 'TypeScript',
  html: '网页片段',
  css: '样式表',
  scss: '样式表',
  less: '样式表',
  json: 'JSON 数据',
  yaml: '配置文件',
  yml: '配置文件',
  toml: '配置文件',
  ini: '配置文件',
  xml: '标记数据',
  sql: '数据库查询',
  latex: 'LaTeX 公式',
  tex: 'LaTeX 公式',
  bash: '命令行',
  sh: '命令行',
  shell: '命令行',
  zsh: '命令行',
  fish: '命令行',
  powershell: 'PowerShell 脚本',
  ps1: 'PowerShell 脚本',
  bat: '批处理脚本',
  cmd: '批处理脚本',
  dockerfile: '镜像构建脚本',
  markdown: 'Markdown 源码',
  md: 'Markdown 源码',
  diff: '改动对比',
  patch: '改动对比',
  plaintext: '纯文本',
  text: '纯文本',
  'c#': 'C# 代码',
  csharp: 'C# 代码',
  cpp: 'C++ 代码',
  'c++': 'C++ 代码',
};

/** 注解节点的类名（样式在 MarkdownEditor.vue 里，按钮重建后按这个类判重） */
export const CODE_LANG_NOTE_CLASS = 'eg-code-lang-note';

/** 查中文注解；大小写、首尾空格都不敏感，没有对应项返回空串（列表里的生僻语言就不加注） */
export function codeLangNote(language: string): string {
  return CODE_LANG_NOTES[language.trim().toLowerCase()] ?? '';
}

/**
 * 给提示面板里的语言按钮补中文注解，返回本次补了几项。
 *
 * Vditor 每次输入都用 `innerHTML` 整体重绘提示面板，所以新按钮里不会有旧的注解节点；
 * 已经带注解的按钮直接跳过，避免观察到自己的改动后再加一遍。
 */
export function decorateCodeLangHint(root: ParentNode): number {
  let decorated = 0;
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-value]'))) {
    if (button.querySelector(`.${CODE_LANG_NOTE_CLASS}`)) continue;
    const raw = button.getAttribute('data-value') || '';
    let language = raw;
    try {
      language = decodeURIComponent(raw);
    } catch {
      // 非法转义：按原样查表，查不到就不加注
    }
    const note = codeLangNote(language);
    if (!note) continue;
    const span = button.ownerDocument.createElement('span');
    span.className = CODE_LANG_NOTE_CLASS;
    span.textContent = note;
    button.appendChild(span);
    decorated += 1;
  }
  return decorated;
}
