import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTask, normalizeInboxFiles } from './prompts.js';

/**
 * 消息附件（收集箱文件）在任务文本里的口径：
 * - 路径清单属于「界面上下文（不可信输入）」，只作定位；
 * - 「怎么处理」是可信说明，单独追加，且必须明确收集箱仍不属于知识库。
 */

test('normalizeInboxFiles：只留收集箱原件，规整路径/补名/去重/限条数', () => {
  const files = normalizeInboxFiles({
    inboxFiles: [
      { path: '收集箱\\合同.pdf', source: 'upload' },
      { path: '/收集箱/随手记.md', name: '  随手记  ', source: 'inbox' },
      { path: '收集箱/合同.pdf' },
      { path: '原始资料/文档/a.md' },
      { path: '收集箱/转换结果/2026.10.18_合同.md' },
      { path: '收集箱' },
      { path: '' },
      { path: '收集箱/照片.png', source: 'bogus' as never, name: '' },
    ] as never,
  });
  assert.deepEqual(files, [
    { path: '收集箱/合同.pdf', name: '合同.pdf', source: 'upload' },
    { path: '收集箱/随手记.md', name: '随手记', source: 'inbox' },
    { path: '收集箱/照片.png', name: '照片.png' },
  ]);
});

test('normalizeInboxFiles：最多 20 条；非数组输入安全返回空', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ path: `收集箱/${index}.txt` }));
  assert.equal(normalizeInboxFiles({ inboxFiles: many as never }).length, 20);
  assert.deepEqual(normalizeInboxFiles(undefined), []);
  assert.deepEqual(normalizeInboxFiles({ inboxFiles: '收集箱/a.txt' as never }), []);
});

test('buildTask：附件路径进不可信上下文块，处理口径作为可信说明追加', () => {
  const task = buildTask(
    '总结一下这几份文件',
    {
      inboxFiles: [
        { path: '收集箱/客户拜访要点.txt', name: '客户拜访要点.txt', source: 'upload' },
        { path: '收集箱/报价单.xlsx', source: 'inbox' },
      ],
    }
  );
  const contextBlock = task.match(/<界面上下文[^>]*>\n([\s\S]*?)\n<\/界面上下文>/);
  assert.ok(contextBlock, '应渲染界面上下文块');
  assert.match(contextBlock[1], /收集箱\/客户拜访要点\.txt/);
  assert.match(contextBlock[1], /收集箱\/报价单\.xlsx/);

  // 可信说明在不可信块之后：模型能分清「路径是数据」「处理方式是约定」
  assert.ok(task.indexOf('本次消息附带的是收集箱文件') > task.indexOf('</界面上下文>'));
  assert.match(task, /list_inbox \/ read_inbox_item/);
  assert.match(task, /convert_inbox_item/);
  assert.match(task, /产物留在收集箱，不要入库/);
  assert.match(task, /不要拿收集箱内容当证据/);
  // 用户原文仍在最后
  assert.ok(task.trimEnd().endsWith('总结一下这几份文件'));
});

test('buildTask：没有附件时不出现收集箱附件说明；非法路径不渲染', () => {
  assert.equal(buildTask('普通提问').includes('本次消息附带的是收集箱文件'), false);
  const task = buildTask('普通提问', { inboxFiles: [{ path: '原始资料/别人的.txt' }] });
  assert.equal(task.includes('本次消息附带的是收集箱文件'), false);
  assert.equal(task.includes('原始资料/别人的.txt'), false);
});
