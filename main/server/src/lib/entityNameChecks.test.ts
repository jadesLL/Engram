import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-entity-name-'));
process.env.DATA_DIR = temp;

let db: any;
let kernel: typeof import('./entityNameChecks.js');
let writePage: (rel: string, content: string, extra?: any) => any;
let indexPage: (pageId: string, signal?: AbortSignal) => Promise<{ indexed: boolean }>;

before(async () => {
  const dbModule = await import('./db.js');
  db = dbModule.db;
  dbModule.migrate();
  ({ writePage } = await import('./vault.js'));
  ({ indexPage } = await import('../pipeline/indexer.js'));
  kernel = await import('./entityNameChecks.js');
});

after(async () => {
  try { db?.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

function seedPage(rel: string, title: string, body = '正文'): string {
  return writePage(rel, `# ${title}\n\n${body}\n`, { title }).id as string;
}

/* ------------------------------------------------------------------ 名称形态 */

test('looksLikeFullName：只认强后缀，简称与「集团/中心」不算全名', () => {
  assert.equal(kernel.looksLikeFullName('天津津亚电子有限公司'), true);
  assert.equal(kernel.looksLikeFullName('中国石油天然气股份有限公司'), true);
  assert.equal(kernel.looksLikeFullName('上海第三纺织厂'), true);
  assert.equal(kernel.looksLikeFullName('津亚电子'), false);
  assert.equal(kernel.looksLikeFullName('津亚集团'), false, '「集团」可能是简称，仍要核验');
  assert.equal(kernel.looksLikeFullName('天津研发中心'), false);
  assert.equal(kernel.looksLikeFullName(''), false);
});

test('extractFullNames：左上下文只留地名，跨句匹配丢弃', () => {
  const text = '本季度客户天津津亚电子有限公司出货量上升，津亚电子的老对手是天津新亚电子有限公司。';
  const names = kernel.extractFullNames(text, '津亚电子');
  assert.ok(names.includes('天津津亚电子有限公司'), `应抽出全名，实际：${JSON.stringify(names)}`);
  assert.ok(!names.some((name) => name.includes('老对手')), `跨句匹配应丢弃：${JSON.stringify(names)}`);
  assert.ok(!names.includes('津亚电子'), '简称不是全名，不该入候选');
  assert.deepEqual(kernel.extractFullNames(text, '不存在的名字'), []);
});

test('extractFullNames：关键词自带虚词时不误杀', () => {
  const names = kernel.extractFullNames('供应商都得利商贸有限公司已签约。', '都得利');
  assert.deepEqual(names, ['都得利商贸有限公司']);
});

/* ------------------------------------------------------------------ 资料库自查 */

test('资料库自查：页面标题里的全名直接命中，不打扰用户', () => {
  const id = seedPage('Wiki/实体/宏晟电子.md', '宏晟电子');
  seedPage('Wiki/实体/天津宏晟电子有限公司.md', '天津宏晟电子有限公司');
  const result = kernel.requestEntityNameCheck({ entity: '宏晟电子', titleOrId: id });
  assert.equal(result.candidates.length > 0, true, '应命中页面标题');
  assert.equal(result.candidates[0].fullName, '天津宏晟电子有限公司');
  assert.match(result.candidates[0].source, /资料库页面/);
  assert.equal(result.check.outcome, 'kb_hit');
  assert.equal(result.check.stage, 'closed', '有候选即办结，不进待答复');
  assert.match(kernel.describeCheckRequest(result), /资料库里已有全名/);
  assert.match(kernel.describeCheckRequest(result), /rename_page/);
  assert.equal(kernel.pendingEntityNameCount(), 0);
});

test('资料库自查：页面标题已是全名时不再建议改名', () => {
  const id = seedPage('Wiki/实体/天津宏晟电子有限公司.md', '天津宏晟电子有限公司');
  const result = kernel.requestEntityNameCheck({ entity: '天津宏晟电子有限公司', titleOrId: id });
  assert.equal(result.candidates[0].fullName, '天津宏晟电子有限公司');
  assert.match(kernel.describeCheckRequest(result), /已是该全名，不用改名/);
});

test('资料库自查：原始资料里出现过的全名算确认口径，不打扰用户', () => {
  db.prepare(
    `INSERT INTO files(id, path, name, ext, size, text, updated_at, deleted)
     VALUES('f-hongyuan', '原始资料/宏远精工合同.md', '宏远精工合同.md', 'md', 10, ?, ?, 0)`
  ).run('合同抬头：天津宏远精工机械有限公司（甲方）。', new Date().toISOString());
  const result = kernel.requestEntityNameCheck({ entity: '宏远精工' });
  assert.equal(result.check.outcome, 'kb_hit');
  assert.equal(result.check.stage, 'closed');
  assert.ok(result.candidates.some((c) => c.fullName === '天津宏远精工机械有限公司' && c.confirmed));
  assert.match(result.candidates[0].source, /原始资料/);
  assert.match(kernel.describeCheckRequest(result), /资料库里已有全名/);
});

test('资料库正文里写明全名的算确认口径：不打扰用户', () => {
  seedPage('Wiki/实体/星捷科技.md', '星捷科技', '主要客户：天津星捷科技发展有限公司（以下简称星捷科技）。');
  const result = kernel.requestEntityNameCheck({ entity: '星捷科技' });
  assert.equal(result.check.outcome, 'kb_hit');
  assert.ok(result.candidates.some((c) => c.fullName === '天津星捷科技发展有限公司' && c.confirmed));
  assert.match(kernel.describeCheckRequest(result), /资料库里已有全名/);
});

test('资料库正文里带存疑标记的候选不算全名：仍登记这一问并标注未核实', () => {
  const id = seedPage(
    'Wiki/实体/津亚电子.md',
    '津亚电子',
    '### 名称口径\n\n- 全称待确认：候选写法有「天津津亚电子有限公司」，尚未核实。'
  );
  const result = kernel.requestEntityNameCheck({ entity: '津亚电子', titleOrId: id });
  assert.equal(result.check.stage, 'query_consent', '未核实候选不能当全名，仍要问用户');
  const suspected = result.candidates.filter((c) => !c.confirmed).map((c) => c.fullName);
  assert.ok(suspected.includes('天津津亚电子有限公司'), `应给出疑似候选：${JSON.stringify(result.candidates)}`);
  const text = kernel.describeCheckRequest(result);
  assert.match(text, /未核实，不能当结论/);
  assert.match(text, /请立刻在对话里问用户/);
  // 疑似候选写进核验说明，用户在对话弹窗里判断时看得到
  assert.match(result.check.note, /资料库正文里出现过（未核实）：天津津亚电子有限公司/);
});

/* ------------------------------------------------------------------ 请示两轮 */

test('资料库没有全名：登记这一问，让 Agent 在对话里问用户', () => {
  const result = kernel.requestEntityNameCheck({ entity: '宏远精密', titleOrId: null as any, note: '材料里只写简称' });
  assert.equal(result.created, true);
  assert.equal(result.check.stage, 'query_consent');
  assert.equal(result.check.outcome, '');
  assert.equal(kernel.pendingEntityNameCount() >= 1, true);
  assert.equal(kernel.listEntityNameChecks('pending').some((c) => c.entity === '宏远精密'), true);
  assert.match(kernel.describeCheckRequest(result), /请立刻在对话里问用户/);
  assert.match(kernel.describeCheckRequest(result), /ask_user/);
});

test('同名重复登记：复用未办结的核验，不再问你第二次', () => {
  const first = kernel.requestEntityNameCheck({ entity: '恒信物流' });
  assert.equal(first.created, true);
  const second = kernel.requestEntityNameCheck({ entity: '恒信物流' });
  assert.equal(second.created, false, '同一名称不应重复登记');
  assert.equal(second.check.id, first.check.id);
  assert.match(kernel.describeCheckRequest(second), /不要重复登记/);
});

test('未获许可就回填全名会被拒绝', () => {
  const { check } = kernel.requestEntityNameCheck({ entity: '未许可公司' });
  assert.throws(
    () => kernel.proposeEntityName({ id: check.id, fullName: '北京未许可科技有限公司' }),
    /还没答复「是否允许联网查询」/
  );
});

test('用户不同意联网查询：办结为「最终不是全名」，不再追问', () => {
  const { check } = kernel.requestEntityNameCheck({ entity: '拒绝查询公司' });
  const closed = kernel.answerEntityNameCheck(check.id, 'deny');
  assert.equal(closed.stage, 'closed');
  assert.equal(closed.outcome, 'query_denied');
  assert.equal(closed.queryConsent, 'denied');
  const again = kernel.requestEntityNameCheck({ entity: '拒绝查询公司' });
  assert.equal(again.created, false, '已办结的名称不再重复请示用户');
  assert.equal(again.check.outcome, 'query_denied');
  const unresolved = kernel.listEntityNameChecks('unresolved').map((c) => c.entity);
  assert.ok(unresolved.includes('拒绝查询公司'), '应进「最终不是全名」清单');
});

test('查不到全名：按未找到办结，进「最终不是全名」清单', () => {
  const { check } = kernel.requestEntityNameCheck({ entity: '查无此名' });
  kernel.answerEntityNameCheck(check.id, 'allow');
  const closed = kernel.proposeEntityName({ id: check.id, note: '企查查只给出同名近似主体' });
  assert.equal(closed.outcome, 'no_full_name');
  assert.equal(closed.stage, 'closed');
  const list = kernel.listEntityNameChecks('unresolved');
  assert.ok(list.some((c) => c.entity === '查无此名'));
});

test('回填的名称不像工商全名会被拒绝（全名以企查查能否查到为准）', () => {
  const { check } = kernel.requestEntityNameCheck({ entity: '简称回填' });
  kernel.answerEntityNameCheck(check.id, 'allow');
  assert.throws(
    () => kernel.proposeEntityName({ id: check.id, fullName: '简称回填' }),
    /不像工商登记全名/
  );
});

/* ------------------------------------------------------------------ 改名执行 */

test('用户同意改名：服务端执行改名（保持页面 ID、重定向双链、记操作日志）', async () => {
  const id = seedPage('Wiki/实体/津亚电子.md', '津亚电子', '## 当前理解\n\n### 名称口径\n\n全称待确认。');
  const referrerId = seedPage('Wiki/概念/出货流程.md', '出货流程', '客户 [[津亚电子]] 的出货按季度对账。');
  // 引用双链的重定向走 edges 表，edges 由索引层建立（真实运行时 write_page 后自动入队）
  await indexPage(id);
  await indexPage(referrerId);

  const { check } = kernel.requestEntityNameCheck({ entity: '津亚电子', titleOrId: id });
  assert.equal(check.stage, 'query_consent');
  const waiting = kernel.answerEntityNameCheck(check.id, 'allow');
  assert.equal(waiting.stage, 'lookup');

  const proposed = kernel.proposeEntityName({
    id: check.id,
    fullName: '天津津亚电子有限公司',
    source: 'https://www.qcc.com/firm/xxxx.html',
  });
  assert.equal(proposed.stage, 'rename_consent');
  assert.equal(proposed.fullName, '天津津亚电子有限公司');
  assert.equal(kernel.pendingEntityNameCount() >= 1, true);

  const done = kernel.answerEntityNameCheck(check.id, 'allow');
  assert.equal(done.outcome, 'renamed');
  assert.equal(done.stage, 'closed');

  // 页面 ID 不变、文件随标题移动、H1 同步
  const row = db.prepare(`SELECT id, path, title FROM pages WHERE id = ?`).get(id) as any;
  assert.equal(row.path, 'Wiki/实体/天津津亚电子有限公司.md');
  assert.equal(row.title, '天津津亚电子有限公司');
  assert.equal(fs.existsSync(path.join(temp, 'brain', 'Wiki/实体/津亚电子.md')), false);

  // 引用双链已重定向
  const referrer = fs.readFileSync(path.join(temp, 'brain', 'Wiki/概念/出货流程.md'), 'utf8');
  assert.match(referrer, /\[\[天津津亚电子有限公司\]\]/);
  assert.doesNotMatch(referrer, /\[\[津亚电子\]\]/);

  // 操作日志自动追加
  const log = fs.readFileSync(path.join(temp, 'brain', 'AIWorks/log/log.md'), 'utf8');
  assert.match(log, /重命名：\[\[津亚电子\]\] → \[\[天津津亚电子有限公司\]\]/);
});

test('用户不同意改名：保持材料写法，进「最终不是全名」清单', () => {
  const id = seedPage('Wiki/实体/保持原样.md', '保持原样');
  const { check } = kernel.requestEntityNameCheck({ entity: '保持原样', titleOrId: id });
  kernel.answerEntityNameCheck(check.id, 'allow');
  kernel.proposeEntityName({ id: check.id, fullName: '上海保持原样科技有限公司', source: '企查查' });
  const closed = kernel.answerEntityNameCheck(check.id, 'deny', '先用材料写法');
  assert.equal(closed.outcome, 'kept_material');
  const row = db.prepare(`SELECT path, title FROM pages WHERE id = ?`).get(id) as any;
  assert.equal(row.title, '保持原样', '不同意就不改名');
  assert.ok(kernel.listEntityNameChecks('unresolved').some((c) => c.entity === '保持原样'));
});

test('登记时未关联页面：同意改名时明确拒绝并保留待办', () => {
  const { check } = kernel.requestEntityNameCheck({ entity: '无页面公司' });
  kernel.answerEntityNameCheck(check.id, 'allow');
  kernel.proposeEntityName({ id: check.id, fullName: '广州无页面科技有限公司' });
  assert.throws(() => kernel.answerEntityNameCheck(check.id, 'allow'), /未关联页面/);
  assert.equal(kernel.listEntityNameChecks('pending').some((c) => c.entity === '无页面公司'), true);
});

test('已办结的核验不再接受答复与回填', () => {
  const { check } = kernel.requestEntityNameCheck({ entity: '已办结公司' });
  kernel.answerEntityNameCheck(check.id, 'deny');
  assert.throws(() => kernel.answerEntityNameCheck(check.id, 'allow'), /已办结/);
  assert.throws(() => kernel.proposeEntityName({ id: check.id, fullName: '北京已办结有限公司' }), /已办结/);
});

/* ------------------------------------------------------------------ 清单与盘点 */

test('清单筛选：pending / open / unresolved 各自口径正确', () => {
  const pending = kernel.listEntityNameChecks('pending');
  assert.ok(pending.every((c) => c.stage === 'query_consent' || c.stage === 'rename_consent'));
  const open = kernel.listEntityNameChecks('open');
  assert.ok(open.every((c) => c.stage !== 'closed'));
  assert.ok(open.length >= pending.length);
  const unresolved = kernel.listEntityNameChecks('unresolved');
  assert.ok(unresolved.every((c) => ['query_denied', 'no_full_name', 'kept_material'].includes(c.outcome)));
  assert.match(kernel.formatEntityNameChecks([], 'unresolved'), /没有「最终不是全名」的条目/);
  assert.match(kernel.formatEntityNameChecks(unresolved, 'unresolved'), /最终不是全名|不同意|未找到/);
});

test('全库盘点：列出标题不是全名形态的公司页与各自核验状态', () => {
  seedPage('Wiki/实体/盘点客户.md', '盘点客户');
  writePage('Wiki/实体/盘点客户.md', '# 盘点客户\n\n正文\n', { title: '盘点客户', type: 'customer' });
  writePage('Wiki/实体/盘点已全名.md', '# 盘点已全名\n\n正文\n', { title: '盘点已全名', type: 'org' });
  seedPage('Wiki/实体/北京盘点科技有限公司.md', '北京盘点科技有限公司');
  writePage('Wiki/实体/北京盘点科技有限公司.md', '# 北京盘点科技有限公司\n\n正文\n', {
    title: '北京盘点科技有限公司',
    type: 'org',
  });

  const audit = kernel.auditCompanyPages();
  const titles = audit.rows.map((row) => row.title);
  assert.ok(titles.includes('盘点客户'), '非全名形态的公司页应列出');
  assert.ok(titles.includes('盘点已全名'), '非全名形态的 org 页应列出');
  assert.ok(!titles.includes('北京盘点科技有限公司'), '标题已是全名形态的不列入');
  assert.equal(audit.fullNameTitles >= 1, true);
  assert.match(kernel.formatEntityNameAudit(audit), /盘点客户/);
});
