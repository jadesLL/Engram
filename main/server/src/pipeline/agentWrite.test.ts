import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-write-'));
process.env.DATA_DIR = temp;

let db: any;
let agentWritePage: (input: any) => any;
let agentInsertRawPage: (input: any) => any;
let writePage: (rel: string, content: string, extra?: any) => any;
let readPage: (rel: string) => { content: string } | null;

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage, readPage } = await import('../lib/vault.js'));
  ({ agentWritePage, agentInsertRawPage } = await import('./agentWrite.js'));
});

after(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function seedSource(rel: string, body: string): void {
  writePage(rel, `# ${rel}\n\n${body}\n`, { title: rel });
}

test('证据逐字校验：引文必须能在来源中命中', () => {
  seedSource('原始资料/资料A.md', '张三是示例科技的销售总监，负责华东区。');
  assert.throws(
    () => agentWritePage({
      path: 'Wiki/实体/张三.md',
      title: '张三',
      content: '# 张三',
      evidence: [{ path: '原始资料/资料A.md', quote: '这句话不存在于来源中' }],
    }),
    /逐字命中/,
  );
});

test('两来源门禁：无证据新建概念页被拒绝，双来源通过并记账', () => {
  seedSource('原始资料/资料A.md', '李四是采购负责人，年度预算两百万。');
  seedSource('原始资料/资料B.md', '李四在2026年Q2启动了供应商换签。');
  assert.throws(
    () => agentWritePage({ path: 'Wiki/概念/李四.md', title: '李四', content: '# 李四' }),
    /两来源门禁/,
  );
  const result = agentWritePage({
    path: 'Wiki/实体/李四.md',
    title: '李四',
    type: 'person',
    content: '# 李四\n\n## 当前理解\n\n采购负责人。\n',
    evidence: [
      { path: '原始资料/资料A.md', quote: '李四是采购负责人' },
      { path: '原始资料/资料B.md', quote: '李四在2026年Q2启动了供应商换签' },
    ],
  });
  assert.equal(result.created, true);
  assert.equal(result.evidenceRecorded, 2);
  const contributions = db.prepare(`SELECT * FROM page_contributions WHERE page_id=?`).all(result.meta.id);
  assert.equal(contributions.length, 2);
  const versions = db.prepare(`SELECT * FROM source_versions WHERE status='active'`).all();
  assert.equal(versions.length, 2);
});

test('单来源两条引文满足门禁；已有页面增量不需要证据', () => {
  seedSource('原始资料/资料C.md', '王五负责渠道管理。王五每月复盘渠道数据。');
  const result = agentWritePage({
    path: 'Wiki/实体/王五.md',
    title: '王五',
    type: 'person',
    content: '# 王五\n\n## 当前理解\n\n渠道负责人。\n',
    evidence: [
      { path: '原始资料/资料C.md', quote: '王五负责渠道管理' },
      { path: '原始资料/资料C.md', quote: '王五每月复盘渠道数据' },
    ],
  });
  assert.equal(result.evidenceRecorded, 2);
  const update = agentWritePage({
    path: 'Wiki/实体/王五.md',
    title: '王五',
    type: 'person',
    content: '# 王五\n\n## 当前理解\n\n渠道负责人，兼管数据复盘。\n',
  });
  assert.equal(update.created, false);
  assert.equal(update.evidenceRecorded, 0);
});

test('写页守卫：只允许 Wiki/ 路径，原始资料与 AIWorks 只读区拒绝（403）', () => {
  seedSource('原始资料/资料A.md', '张三是示例科技的销售总监，负责华东区。');
  for (const bad of ['原始资料/资料A.md', 'AIWorks/log/log.md', 'notes.md']) {
    assert.throws(
      () => agentWritePage({ path: bad, title: '越权', content: '# 越权' }),
      (error: any) => error.status === 403 && /只读区|Wiki\//.test(error.message),
      `路径 ${bad} 应被拒绝`,
    );
  }
});

test('位置插入写入口：只接受原始资料 Markdown，写入后正文更新且不动 Wiki 门禁', () => {
  writePage('原始资料/文档/未命名.md', '# 未命名\n\n原来的内容。\n', { title: '未命名' });
  const meta = agentInsertRawPage({
    path: '原始资料/文档/未命名.md',
    title: '未命名',
    content: '# 未命名\n\n原来的内容。\n\n追加的一段。\n',
  });
  assert.equal(meta.path, '原始资料/文档/未命名.md');
  assert.match(readPage(meta.path)!.content, /追加的一段/);
  // 同一入口不允许被用来整页改写 Wiki / AIWorks / 非 Markdown
  for (const bad of ['Wiki/概念/未命名.md', 'AIWorks/log/log.md', '原始资料/文档/附件.pdf']) {
    assert.throws(
      () => agentInsertRawPage({ path: bad, title: '越权', content: '越权' }),
      (error: any) => error.status === 403 && /位置插入/.test(error.message),
      `路径 ${bad} 应被拒绝`,
    );
  }
  // 外部 Agent 的整页写入口对原始资料仍然关闭
  assert.throws(
    () => agentWritePage({ path: '原始资料/文档/未命名.md', title: '未命名', content: '越权' }),
    (error: any) => error.status === 403 && /只读区/.test(error.message),
  );
});

test('共享同一来源的多页面证据互不踢出 active（回归：按版本而非按路径退出）', () => {
  seedSource('原始资料/共享资料D.md', '甲公司完成了A项目交付。乙公司签署了B项目合同。');
  seedSource('原始资料/补充资料E.md', '甲公司在2026年获评优秀供应商。');
  agentWritePage({
    path: 'Wiki/实体/甲公司.md',
    title: '甲公司',
    type: 'org',
    content: '# 甲公司\n\n## 当前理解\n\n交付方。\n',
    evidence: [
      { path: '原始资料/共享资料D.md', quote: '甲公司完成了A项目交付' },
      { path: '原始资料/补充资料E.md', quote: '甲公司在2026年获评优秀供应商' },
    ],
  });
  seedSource('原始资料/补充资料F.md', '乙公司总部在上海。');
  const second = agentWritePage({
    path: 'Wiki/实体/乙公司.md',
    title: '乙公司',
    type: 'org',
    content: '# 乙公司\n\n## 当前理解\n\n签约方。\n',
    evidence: [
      { path: '原始资料/共享资料D.md', quote: '乙公司签署了B项目合同' },
      { path: '原始资料/补充资料F.md', quote: '乙公司总部在上海' },
    ],
  });
  assert.equal(second.created, true);
  // 乙公司写入后，甲公司在同一来源（版本未变）上的贡献必须保持 active
  const activeCount = db
    .prepare(`SELECT COUNT(*) n FROM page_contributions WHERE source_version_id IN (
      SELECT id FROM source_versions WHERE path='原始资料/共享资料D.md'
    ) AND active=1`)
    .get() as { n: number };
  assert.equal(activeCount.n, 2);
});
