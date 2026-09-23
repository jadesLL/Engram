import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INBOX_DIR,
  INBOX_DERIVED_DIR,
  classifyBrainEntry,
  inboxDerivedPath,
  inboxAccessError,
  isInboxDerivedPath,
  isInboxPath,
  normalizeBrainRel,
  stemOf,
  uniqueDerivedPath,
} from './brainPaths.js';

test('normalizeBrainRel：反斜杠、前后斜杠都归一', () => {
  assert.equal(normalizeBrainRel('\\收集箱\\a.pdf'), '收集箱/a.pdf');
  assert.equal(normalizeBrainRel('/收集箱/a.pdf/'), '收集箱/a.pdf');
  assert.equal(normalizeBrainRel(undefined), '');
});

test('isInboxPath：只认收集箱自己与它的子路径', () => {
  assert.equal(isInboxPath(INBOX_DIR), true);
  assert.equal(isInboxPath(`${INBOX_DIR}/合同.pdf`), true);
  assert.equal(isInboxPath(`${INBOX_DIR}/子目录/深处/x.bin`), true);
  assert.equal(isInboxPath('原始资料/x.pdf'), false);
  assert.equal(isInboxPath('Wiki/概念/x.md'), false);
  // 前缀相同但不是同一个目录：不能被误判
  assert.equal(isInboxPath('收集箱备份/x.pdf'), false);
  assert.equal(isInboxPath(''), false);
});

test('isInboxDerivedPath：转换产物单独成区', () => {
  assert.equal(isInboxDerivedPath(`${INBOX_DERIVED_DIR}/合同.md`), true);
  assert.equal(isInboxDerivedPath(`${INBOX_DIR}/合同.pdf`), false);
});

test('classifyBrainEntry：收集箱里的 .md 也按文件同步，绝不能走页面分支', () => {
  assert.equal(classifyBrainEntry(`${INBOX_DIR}/说明.md`), 'file');
  assert.equal(classifyBrainEntry(`${INBOX_DERIVED_DIR}/合同.md`), 'file');
  assert.equal(classifyBrainEntry('原始资料/对话/chat.md'), 'page');
  assert.equal(classifyBrainEntry('Wiki/概念/x.md'), 'page');
  assert.equal(classifyBrainEntry('原始资料/合同.pdf'), 'file');
});

test('stemOf / inboxDerivedPath：产物路径由原件名推导', () => {
  assert.equal(stemOf(`${INBOX_DIR}/子目录/季度报表.xlsx`), '季度报表');
  assert.equal(inboxDerivedPath(`${INBOX_DIR}/季度报表.xlsx`), `${INBOX_DERIVED_DIR}/季度报表.md`);
  assert.equal(inboxDerivedPath(`${INBOX_DIR}/a.b.c.pdf`), `${INBOX_DERIVED_DIR}/a.b.c.md`);
});

test('uniqueDerivedPath：同名产物顺延序号', () => {
  const taken = new Set([`${INBOX_DERIVED_DIR}/季度报表.md`]);
  const next = uniqueDerivedPath(`${INBOX_DIR}/季度报表.xlsx`, (candidate) => taken.has(candidate));
  assert.equal(next, `${INBOX_DERIVED_DIR}/季度报表 (2).md`);
});

test('inboxAccessError：给通用文件接口用的拒绝文案', () => {
  assert.equal(inboxAccessError('Wiki/概念/x.md'), null);
  assert.match(String(inboxAccessError(`${INBOX_DIR}/x.pdf`)), /收集箱/);
});
