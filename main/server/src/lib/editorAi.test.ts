import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beautifyDocument,
  buildEditorAiMessages,
  cleanEditorAiOutput,
  protectedEditorSnippets,
  resolveEditorModelConfig,
  splitMarkdownForRetry,
  validateBeautified,
} from './editorAi.js';
import { ModelOutputTruncatedError } from './modelClient.js';

/**
 * 编辑页就地 AI 的提示词与门禁。
 *
 * 锁住四件事：
 *  1) 四类任务的提示词各自带上该有的上下文与「只输出结果」约束；
 *  2) 模型常见的整体代码围栏 / 「以下是…」前缀会被清掉，正文内部围栏不动；
 *  3) 美化门禁拒绝「摘要化」「丢双链/图片」「围栏不闭合」的结果；
 *  4) 模型路由能从 dsh 控制台写下的 profile patch + 凭据文件解析出来。
 */

const WRITE = { task: 'rewrite' as const, instruction: '改得客气一点', title: '会议纪要', selection: '明天下午三点开会', before: '前文', after: '后文' };

test('rewrite 提示词带上原文、前后文与「只输出改写结果」约束', () => {
  const messages = buildEditorAiMessages(WRITE);
  assert.equal(messages[0].role, 'system');
  const user = String(messages[1].content);
  assert.match(user, /页面标题：会议纪要/);
  assert.match(user, /【需要改写的原文】\n明天下午三点开会/);
  assert.match(user, /【上文】\n前文/);
  assert.match(user, /【下文】\n后文/);
  assert.match(user, /用户要求】\n改得客气一点/);
  assert.match(user, /只输出改写后的这段文字/);
  assert.match(user, /保留原文里的数字、专名、\[\[双链\]\]/);
});

test('insert 提示词交代插入位置前后文与块级内容留空行', () => {
  const user = String(buildEditorAiMessages({
    task: 'insert', instruction: '补一个例子', title: '方案', before: '第一段', after: '第二段',
  })[1].content);
  assert.match(user, /【插入位置之前的正文】\n第一段/);
  assert.match(user, /【插入位置】/);
  assert.match(user, /【插入位置之后的正文】\n第二段/);
  assert.match(user, /块级内容（标题、列表、表格、代码块），前后各留一个空行/);
  assert.match(user, /不要重复插入位置前后的已有内容/);
});

test('insert 在文档开头 / 结尾有明确占位，不留空段', () => {
  const head = String(buildEditorAiMessages({ task: 'insert', instruction: '开场' })[1].content);
  assert.match(head, /（文档开头）/);
  assert.match(head, /（文档结尾）/);
});

test('continue 提示词要求只输出新增内容', () => {
  const user = String(buildEditorAiMessages({
    task: 'continue', instruction: '接着写', selection: '已写的段落', after: '后面还有一段',
  })[1].content);
  assert.match(user, /已经写好的上文/);
  assert.match(user, /【已有的下文】\n后面还有一段/);
  assert.match(user, /只输出新增的内容/);
  assert.match(user, /不要重复已经写过的文字/);
});

test('beautify 提示词带全文与保事实 / 保占位链接规则', () => {
  const user = String(buildEditorAiMessages({
    task: 'beautify', title: '周报', document: '# 周报\n\n本周完成三件事',
  })[1].content);
  assert.match(user, /【文档正文开始】\n# 周报/);
  assert.match(user, /【文档正文结束】/);
  assert.match(user, /不增删事实/);
  assert.match(user, /正文不要新增一级标题/);
  assert.match(user, /\[\[双链\]\]/);
  assert.match(user, /ingest-preserved/);
  assert.match(user, /只输出整理后的完整 Markdown/);
});

test('cleanEditorAiOutput 去掉整段代码围栏与前缀，但保留正文内部围栏', () => {
  assert.equal(
    cleanEditorAiOutput('```markdown\n## 标题\n\n正文\n```'),
    '## 标题\n\n正文',
  );
  assert.equal(
    cleanEditorAiOutput('好的，以下是改写后的文字：\n\n明天下午三点开会。'),
    '明天下午三点开会。',
  );
  const internal = '## 标题\n\n```js\nconsole.log(1)\n```';
  assert.equal(cleanEditorAiOutput(internal), internal);
});

test('protectedEditorSnippets 抓双链 / 图片 / 占位链接', () => {
  const snippets = protectedEditorSnippets('看 [[概念页]] 和 ![图](/media/a.png)，还有 [managed](#ingest-preserved-abc)。');
  assert.deepEqual(snippets.sort(), ['![图](/media/a.png)', '[[概念页]]', '[managed](#ingest-preserved-abc)'].sort());
});

test('validateBeautified 拒绝摘要化、丢受保护片段、围栏不闭合', () => {
  const source = '# 标题\n\n' + '这是一段足够长的正文，用来让长度护栏生效。'.repeat(10) + '\n\n[[概念页]]\n';
  const good = source.replace('这是一段', '这是一段');
  assert.equal(validateBeautified(source, good), null);

  assert.match(String(validateBeautified(source, '# 标题\n\n这是一段足够长的正文。')), /明显短于原文/);
  assert.match(String(validateBeautified(source, good.replace('[[概念页]]', '概念页'))), /丢失了原文里的 \[\[概念页\]\]/);
  assert.match(String(validateBeautified(source, good + '\n```\ncode')), /未闭合的代码围栏/);
  assert.match(String(validateBeautified(source, '')), /没有返回整理结果/);
});

test('splitMarkdownForRetry 在围栏外的空行拆开，并优先小节标题', () => {
  const source = [
    '# 文档', '', '第一段'.repeat(30), '',
    '## 第一节', '', '内容甲'.repeat(30), '',
    '## 第二节', '', '内容乙'.repeat(30),
  ].join('\n');
  const parts = splitMarkdownForRetry(source);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^# 文档/);
  assert.match(parts[1], /^## /);
  assert.ok(parts.every((part) => part.length >= 80));

  assert.deepEqual(splitMarkdownForRetry('太短'), []);
  const fenced = ['```', 'a'.repeat(200), '```', 'b'.repeat(200)].join('\n');
  assert.deepEqual(splitMarkdownForRetry(fenced), []);
});

test('beautifyDocument 输出被截断时按小节拆开重试', async () => {
  const source = ['# 文档', '', '第一段'.repeat(40), '', '## 第一节', '', '内容甲'.repeat(40), '', '## 第二节', '', '内容乙'.repeat(40)].join('\n');
  const calls: string[] = [];
  const result = await beautifyDocument(source, {
    config: { apiKey: 'test-key' },
    complete: (async (messages: any) => {
      const user = String(messages[1].content);
      const body = user.slice(user.indexOf('【文档正文开始】') + '【文档正文开始】'.length).replace(/【文档正文结束】[\s\S]*$/, '').trim();
      calls.push(body);
      if (calls.length === 1) throw new ModelOutputTruncatedError('输出达到上限');
      return { text: '```markdown\n' + body + '\n```', model: 'test-model' };
    }) as any,
  });
  assert.equal(calls.length, 3);
  assert.equal(result.chunks, 2);
  assert.match(result.text, /^# 文档/);
  assert.match(result.text, /## 第二节/);
  assert.doesNotMatch(result.text, /```markdown/);
});

test('resolveEditorModelConfig：旧配置优先，其次读 dsh 官方 / 自定义 provider', () => {
  const legacy = resolveEditorModelConfig({ legacy: { apiKey: 'sk-legacy', model: 'deepseek-chat' } });
  assert.equal(legacy.apiKey, 'sk-legacy');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-editor-ai-'));
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      dashscope:',
    '        apiKeyEnv: DASHSCOPE_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://dashscope.example/v1',
    '        models:',
    '        - id: qwen-max',
    '',
    '- id: llm-deepseek',
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    '    models:',
    '    - id: deepseek-chat',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-chat',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), [
    'refs:',
    '  {',
    "    DEEPSEEK_API_KEY: 'sk-deepseek-home',",
    "    DASHSCOPE_API_KEY: 'sk-dashscope-home',",
    '  }',
    '',
  ].join('\n'), 'utf8');

  const official = resolveEditorModelConfig({ legacy: {}, home, env: {} });
  assert.equal(official.apiKey, 'sk-deepseek-home');
  assert.equal(official.model, 'deepseek-chat');
  assert.equal(official.baseUrl, undefined);

  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      dashscope:',
    '        apiKeyEnv: DASHSCOPE_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://dashscope.example/v1',
    '        models:',
    '        - id: qwen-max',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: dashscope',
    '    model: qwen-max',
    '',
  ].join('\n'), 'utf8');
  const custom = resolveEditorModelConfig({ legacy: {}, home, env: {} });
  assert.equal(custom.apiKey, 'sk-dashscope-home');
  assert.equal(custom.model, 'qwen-max');
  assert.equal(custom.baseUrl, 'https://dashscope.example/v1');
  assert.equal(custom.api, 'openai-completions');

  // 控制台没手动选过默认模型：按 dsh 自己的兜底走官方 provider + 目录第一个模型
  fs.writeFileSync(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), [
    '- id: llm-deepseek',
    '  config:',
    '    models:',
    '    - id: deepseek-flash',
    '    - id: deepseek-v4-pro',
    '',
  ].join('\n'), 'utf8');
  const implicit = resolveEditorModelConfig({ legacy: {}, home, env: {} });
  assert.equal(implicit.apiKey, 'sk-deepseek-home');
  assert.equal(implicit.model, 'deepseek-flash');
  assert.equal(implicit.baseUrl, undefined);
});
