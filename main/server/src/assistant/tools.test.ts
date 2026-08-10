import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-assistant-tools-'));
process.env.DATA_DIR = temp;

let db: any;
let migrate: () => void;
let createPage: typeof import('../lib/vault.js').createPage;
let readPage: typeof import('../lib/vault.js').readPage;
let writePage: typeof import('../lib/vault.js').writePage;
let getAgentTool: typeof import('./tools.js').getAgentTool;
let listAgentTools: typeof import('./tools.js').listAgentTools;
let parseToolArguments: typeof import('./tools.js').parseToolArguments;
let previewAgentTool: typeof import('./tools.js').previewAgentTool;
let executeAgentTool: typeof import('./tools.js').executeAgentTool;
let undoAgentTool: typeof import('./tools.js').undoAgentTool;
let redactToolResult: typeof import('./tools.js').redactToolResult;

const context = { runId: 'test-run', sessionId: 'test-session', context: {} };

before(async () => {
  ({ db, migrate } = await import('../lib/db.js'));
  ({ createPage, readPage, writePage } = await import('../lib/vault.js'));
  ({
    getAgentTool,
    listAgentTools,
    parseToolArguments,
    previewAgentTool,
    executeAgentTool,
    undoAgentTool,
    redactToolResult,
  } = await import('./tools.js'));
  migrate();
});

after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('tool catalog classifies reads, reversible writes and high-impact actions', () => {
  const risks = new Map(listAgentTools().map((tool) => [tool.name, tool.risk]));
  assert.equal(risks.get('search_knowledge'), 'read');
  assert.equal(risks.get('update_page'), 'reversible');
  assert.equal(risks.get('merge_pages'), 'high');
  assert.equal(risks.get('permanently_delete_trash'), 'high');
});

test('redactToolResult removes nested credentials', () => {
  const value = redactToolResult({
    summary: 'ok',
    data: {
      apiKey: 'secret',
      nested: { password: 'secret', token: 'secret', name: 'visible' },
    },
  });
  assert.equal(value.data?.apiKey, '[REDACTED]');
  assert.equal(value.data?.nested.password, '[REDACTED]');
  assert.equal(value.data?.nested.token, '[REDACTED]');
  assert.equal(value.data?.nested.name, 'visible');
});

test('update_page rejects a stale preview and supports immediate undo', async () => {
  const page = createPage('Wiki/概念', 'Agent Tool Test');
  writePage(page.path, '# Agent Tool Test\n\noriginal', { title: page.title, type: 'concept' });
  const tool = getAgentTool('update_page')!;
  const args = parseToolArguments(tool, {
    pageId: page.id,
    content: '# Agent Tool Test\n\nagent edit',
  });
  const stalePreview = await previewAgentTool(tool, args, context);
  writePage(page.path, '# Agent Tool Test\n\nexternal edit', {});
  await assert.rejects(
    executeAgentTool(tool, args, context, stalePreview),
    /页面已在预览后发生变化/
  );

  const freshPreview = await previewAgentTool(tool, args, context);
  const result = await executeAgentTool(tool, args, context, freshPreview);
  assert.equal(readPage(page.path)?.content.includes('agent edit'), true);
  await undoAgentTool({
    id: 'call',
    runId: context.runId,
    name: tool.name,
    arguments: args,
    risk: tool.risk,
    status: 'completed',
    preview: freshPreview,
    result: {},
    undo: result.undo || {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, context);
  assert.equal(readPage(page.path)?.content.includes('external edit'), true);
});

test('tool schemas reject malformed destructive requests', () => {
  const tool = getAgentTool('permanently_delete_trash')!;
  assert.throws(() => parseToolArguments(tool, { ids: [] }), /工具参数无效/);
});

test('assistant cannot batch approve pending review candidates', async () => {
  const tool = getAgentTool('apply_report_actions')!;
  const args = parseToolArguments(tool, {
    kind: 'pending_review',
    decisions: [{ reportId: 1, action: 'approve:concept' }],
  });
  await assert.rejects(
    previewAgentTool(tool, args, context),
    /必须逐条生成预览并确认/,
  );
});
