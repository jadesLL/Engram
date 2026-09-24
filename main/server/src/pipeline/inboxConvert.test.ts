import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 收集箱语义转换：能力边界、分块、产物落盘与「入库才进知识库」。
 * 模型用注入的 fetch 假实现（不联网、不发真实请求）。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-inbox-convert-'));
process.env.DATA_DIR = temp;

let BRAIN_DIR = '';
let db: any;
let convertInboxItem: typeof import('./inboxConvert.js').convertInboxItem;
let writeInboxMarkdown: typeof import('./inboxConvert.js').writeInboxMarkdown;
let adoptInboxItem: typeof import('./inboxConvert.js').adoptInboxItem;
let migrateLegacyInboxAdoptions: typeof import('./inboxConvert.js').migrateLegacyInboxAdoptions;
let convertCapability: typeof import('./inboxConvert.js').convertCapability;
let chunkText: typeof import('./inboxConvert.js').chunkText;
let extractInboxText: typeof import('./inboxConvert.js').extractInboxText;

/** 假模型：返回固定 Markdown，并记录收到的提示词 */
function fakeModel(reply = '# 转换结果\n\n这是模型按语义重写的正文。') {
  const calls: any[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const content = String(body.messages?.[0]?.content || '').includes('资料归档员')
      ? (reply.match(/^#\s+(.+)$/m)?.[1] || '正文核心内容')
      : reply;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const config = { apiKey: 'test-key', baseUrl: '', model: '', api: 'openai-completions' } as any;

before(async () => {
  const configModule = await import('../config.js');
  BRAIN_DIR = configModule.BRAIN_DIR;
  configModule.ensureDirs();
  db = (await import('../lib/db.js')).db;
  (await import('../lib/db.js')).migrate();
  ({
    convertInboxItem, writeInboxMarkdown, adoptInboxItem, migrateLegacyInboxAdoptions,
    convertCapability, chunkText, extractInboxText,
  } = await import('./inboxConvert.js'));
});

after(async () => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

beforeEach(() => {
  const inbox = path.join(BRAIN_DIR, '收集箱');
  fs.rmSync(inbox, { recursive: true, force: true });
  fs.mkdirSync(path.join(inbox, '转换结果'), { recursive: true });
});

function plant(name: string, content: string | Buffer): string {
  const rel = `收集箱/${name}`;
  fs.writeFileSync(path.join(BRAIN_DIR, ...rel.split('/')), content);
  return rel;
}

test('能力判定：Office/PDF/文本可转，图片与音视频走 Agent 通道，压缩包不支持', () => {
  assert.equal(convertCapability('收集箱/a.docx'), 'office');
  assert.equal(convertCapability('收集箱/a.xlsx'), 'office');
  assert.equal(convertCapability('收集箱/a.pdf'), 'pdf');
  assert.equal(convertCapability('收集箱/a.md'), 'text');
  assert.equal(convertCapability('收集箱/a.png'), 'agent-only');
  assert.equal(convertCapability('收集箱/a.mp4'), 'agent-only');
  assert.equal(convertCapability('收集箱/a.zip'), 'unsupported');
  assert.equal(convertCapability('收集箱/a.weirdext'), 'unsupported');
});

test('分块：短文一块，长文按段落边界切开且不丢内容', () => {
  const short = 'a'.repeat(100);
  assert.deepEqual(chunkText(short, 200, 4), { chunks: [short], truncated: false });

  const paragraph = `${'x'.repeat(120)}\n\n`;
  const long = paragraph.repeat(10);
  const { chunks, truncated } = chunkText(long, 200, 50);
  assert.equal(truncated, false);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join('').replace(/\s/g, ''), long.replace(/\s/g, ''), '分块不应丢字符');
});

test('超过块数上限时明确标记只覆盖前面部分', () => {
  const long = `${'y'.repeat(300)}\n\n`.repeat(10);
  const { chunks, truncated } = chunkText(long, 300, 2);
  assert.equal(chunks.length, 2);
  assert.equal(truncated, true);
});

test('文本原件：转换写入 收集箱/转换结果/，带来源 frontmatter，且不建页面', async () => {
  const rel = plant('需求草稿.txt', '客户要一套排产系统，预算 80 万。');
  const { fetchImpl, calls } = fakeModel('# 客户排产系统需求\n\n这是模型按语义重写的正文。');
  const result = await convertInboxItem(rel, { fetchImpl, config });

  assert.match(result.derivedPath, /^收集箱\/转换结果\/\d{4}\.\d{2}\.\d{2}_客户排产系统需求\.md$/);
  assert.equal(result.chunks, 1);
  assert.equal(calls.length, 2, '正文转换后再由模型提炼文件名');
  assert.match(calls[0].url, /\/chat\/completions$/);
  // 提示词里必须带上原件正文与转换规范（不是只发个文件名）
  const userMessage = calls[0].body.messages.at(-1).content;
  assert.match(userMessage, /预算 80 万/);
  assert.match(calls[0].body.messages[0].content, /语义转换/);
  assert.match(calls[1].body.messages[0].content, /根据正文核心内容提炼/);

  const written = fs.readFileSync(path.join(BRAIN_DIR, result.derivedPath), 'utf8');
  assert.match(written, /^---\n标题: 客户排产系统需求/m);
  assert.match(written, /来源: 收集箱\/需求草稿.txt/);
  assert.match(written, /这是模型按语义重写的正文/);

  // 产物仍在收集箱：不是页面、不进检索
  const page = db.prepare(`SELECT id FROM pages WHERE path LIKE '收集箱/%'`).get();
  assert.equal(page, undefined);
  const fileRow = db.prepare(`SELECT id FROM files WHERE path LIKE '收集箱/%'`).get();
  assert.equal(fileRow, undefined);
  const { hybridSearch } = await import('../retrieval/hybrid.js');
  const hits = await hybridSearch('重写', 10);
  assert.equal(hits.some((hit: any) => String(hit.path).startsWith('收集箱/')), false);
});

test('图片/音视频/压缩包：服务端直接给出可读的拒绝原因', async () => {
  const png = plant('现场照片.png', Buffer.from('not really png'));
  const zip = plant('归档.zip', Buffer.from('zip'));
  await assert.rejects(() => convertInboxItem(png, { fetchImpl: fakeModel().fetchImpl, config }), /Agent/);
  await assert.rejects(() => convertInboxItem(zip, { fetchImpl: fakeModel().fetchImpl, config }), /还转不了/);
});

test('命名请求失败时沿用正文语义标题，不丢掉已完成的转换', async () => {
  const rel = plant('导出文件.txt', '现场设备每季度维护一次。');
  const model = fakeModel('# 现场设备季度维护记录\n\n每季度维护一次。');
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (String(body.messages?.[0]?.content || '').includes('资料归档员')) throw new Error('命名请求暂不可用');
    return model.fetchImpl(url, init);
  }) as typeof fetch;
  const result = await convertInboxItem(rel, { fetchImpl, config });
  assert.match(result.derivedPath, /_现场设备季度维护记录\.md$/);
});

test('未配置模型凭据：明确报错，不静默降级成格式转换', async () => {
  const rel = plant('笔记.txt', '随便写的东西');
  await assert.rejects(
    () => convertInboxItem(rel, { fetchImpl: fakeModel().fetchImpl, config: { apiKey: '' } as any }),
    /未配置模型凭据/
  );
  assert.deepEqual(fs.readdirSync(path.join(BRAIN_DIR, '收集箱', '转换结果')), []);
});

test('长文本分多块：每块各自的产物在文末合并（不覆盖）', async () => {
  const rel = plant('长文.txt', `${'内容段落。'.repeat(8000)}\n\n`);
  const { fetchImpl, calls } = fakeModel('## 分块正文');
  const result = await convertInboxItem(rel, { fetchImpl, config });
  assert.ok(calls.length > 1, '长文应分多块');
  assert.equal(result.chunks, calls.length - 1);
  const written = fs.readFileSync(path.join(BRAIN_DIR, result.derivedPath), 'utf8');
  assert.equal(written.match(/## 分块正文/g)?.length, result.chunks);
});

test('入库：产物直接复制进 原始资料/ 并登记为页面，原件与产物都留在收集箱', async () => {
  const rel = plant('合同.txt', '合同金额 12 万，付款周期 30 天。');
  const { fetchImpl } = fakeModel('# 合同要点\n\n- 金额 12 万\n- 付款周期 30 天');
  const converted = await convertInboxItem(rel, { fetchImpl, config });

  const adopted = adoptInboxItem(rel);
  assert.equal(adopted.pagePath, `原始资料/${path.posix.basename(converted.derivedPath)}`);
  assert.match(adopted.pageTitle, /合同/);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, adopted.pagePath)), true);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, converted.derivedPath)), true, '产物保留在收集箱');

  // 入库这一动作才产生页面行：入库前没有，入库后才有
  const row = db.prepare(`SELECT path, deleted FROM pages WHERE path = ?`).get(adopted.pagePath) as any;
  assert.equal(row?.deleted, 0);
  const { hybridSearch } = await import('../retrieval/hybrid.js');
  const hits = await hybridSearch('付款周期', 10);
  assert.equal(
    hits.some((hit: any) => hit.path === adopted.pagePath),
    true,
    '入库后应可被检索到'
  );
});

test('没有产物就入库：给出明确提示而不是建一个空页面', () => {
  const rel = plant('未转换.txt', '还没转');
  assert.throws(() => adoptInboxItem(rel), /还没有转换产物/);
});

test('同名原件入库不覆盖：第二份加序号', async () => {
  const first = plant('周报.txt', '第一周的周报');
  const { fetchImpl } = fakeModel('# 周报');
  await convertInboxItem(first, { fetchImpl, config });
  const a = adoptInboxItem(first);
  assert.match(a.pagePath, /^原始资料\/\d{4}\.\d{2}\.\d{2}_周报\.md$/);
  // 产物仍在 → 再入库一次会另存一份，不覆盖上一份
  const b = adoptInboxItem(first);
  assert.equal(b.pagePath, a.pagePath.replace(/\.md$/, ' (2).md'));
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, a.pagePath)), true);
});

test('Agent 通道写产物：与转换通道落同一位置、同一 frontmatter 口径', () => {
  const rel = plant('会议.txt', '会议内容');
  const written = writeInboxMarkdown(rel, '# 会议纪要\n\n- 决议一', '由 Agent 通道写入');
  assert.match(written.derivedPath, /^收集箱\/转换结果\/\d{4}\.\d{2}\.\d{2}_会议纪要\.md$/);
  const text = fs.readFileSync(path.join(BRAIN_DIR, written.derivedPath), 'utf8');
  assert.match(text, /来源: 收集箱\/会议.txt/);
  assert.match(text, /转换版本: semantic-v2/);
  assert.match(text, /由 Agent 通道写入/);
  assert.equal(adoptInboxItem(rel).pagePath, `原始资料/${path.posix.basename(written.derivedPath)}`);
});

test('同一原件重转只保留最新产物，其他同题原件不会被删', async () => {
  const first = plant('第一份.txt', '第一次内容');
  const second = plant('第二份.txt', '第二次内容');
  const old = writeInboxMarkdown(first, '# 旧主题\n\n旧正文');
  const other = writeInboxMarkdown(second, '# 新主题\n\n其他原件');
  const updated = writeInboxMarkdown(first, '# 新主题\n\n更新正文');
  assert.notEqual(updated.derivedPath, old.derivedPath);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, old.derivedPath)), false);
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, other.derivedPath)), true);
  assert.match(updated.derivedPath, /新主题 \(2\)\.md$/);
  const { listInboxItems } = await import('../lib/inboxItems.js');
  const items = listInboxItems().items;
  assert.equal(items.find((item) => item.path === first)?.derivedPath, updated.derivedPath);
  assert.equal(items.find((item) => item.path === second)?.derivedPath, other.derivedPath);
  const repeated = writeInboxMarkdown(first, '# 新主题\n\n最终正文');
  assert.equal(repeated.derivedPath, updated.derivedPath, '标题不变时复用同一路径');
  assert.match(fs.readFileSync(path.join(BRAIN_DIR, repeated.derivedPath), 'utf8'), /最终正文/);
  assert.equal(fs.readdirSync(path.join(BRAIN_DIR, '收集箱', '转换结果')).length, 2);
});

test('旧版入库目录自动迁到原始资料根，撞名加序号且保留页面 ID', async () => {
  const legacyDir = path.join(BRAIN_DIR, '原始资料', '收集箱');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(BRAIN_DIR, '原始资料', '合同.md'), '# 已有合同\n', 'utf8');
  fs.writeFileSync(path.join(legacyDir, '合同.md'), '# 旧合同\n', 'utf8');
  const { syncPageFile } = await import('../lib/vault.js');
  syncPageFile('原始资料/合同.md');
  const old = syncPageFile('原始资料/收集箱/合同.md');
  assert.ok(old);
  assert.equal(migrateLegacyInboxAdoptions(), 1);
  const moved = db.prepare('SELECT id, path FROM pages WHERE id = ?').get(old.id) as any;
  assert.equal(moved.path, '原始资料/合同 (2).md');
  assert.equal(fs.existsSync(path.join(BRAIN_DIR, '原始资料', '合同 (2).md')), true);
  assert.equal(fs.existsSync(legacyDir), false);
});

test('只允许收集箱内的路径：越界一律拒绝', async () => {
  await assert.rejects(() => extractInboxText('原始资料/别人的.pdf'), /只能转换收集箱内的文件/);
  assert.throws(() => writeInboxMarkdown('Wiki/概念/越界.md', '# x'), /只能写收集箱原件的转换产物/);
  assert.throws(() => adoptInboxItem('原始资料/别人的.md'), /只能入库收集箱内的文件/);
});
