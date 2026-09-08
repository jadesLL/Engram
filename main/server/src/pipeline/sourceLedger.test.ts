import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-distilled-'));
process.env.DATA_DIR = temp;

let db: any;
let writePage: (rel: string, content: string, extra?: any) => any;
let agentWritePage: (input: any) => any;
let isDistilledPath: (rel: string) => boolean;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage } = await import('../lib/vault.js'));
  ({ agentWritePage } = await import('./agentWrite.js'));
  ({ isDistilledPath } = await import('./sourceLedger.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('isDistilledPath：带证据写页后来源标记为已提炼，未引用来源不算', () => {
  writePage('原始资料/已提炼.md', '# 原始资料/已提炼.md\n\n示例科技2026年签约。示例科技主营自动化设备。', { title: '已提炼' });
  writePage('原始资料/未提炼.md', '# 原始资料/未提炼.md\n\n暂无引用。', { title: '未提炼' });
  assert.equal(isDistilledPath('原始资料/已提炼.md'), false);
  agentWritePage({
    path: 'Wiki/实体/示例科技.md',
    title: '示例科技',
    type: 'org',
    content: '# 示例科技\n\n## 当前理解\n\n自动化设备厂商。\n',
    evidence: [
      { path: '原始资料/已提炼.md', quote: '示例科技2026年签约' },
      { path: '原始资料/已提炼.md', quote: '示例科技主营自动化设备' },
    ],
  });
  assert.equal(isDistilledPath('原始资料/已提炼.md'), true);
  assert.equal(isDistilledPath('原始资料/未提炼.md'), false);
});
