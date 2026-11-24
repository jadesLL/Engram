import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEISHU_CONFIG_KEY,
  FEISHU_RAW_DIR,
  emptyFeishuConfig,
  feishuConfigForClient,
  feishuFileName,
  feishuFilePath,
  feishuSourceMarker,
  newFeishuSource,
  normalizeFeishuCredentials,
  parseFeishuBitableConfig,
  parseFeishuBitableUrl,
  parseFeishuSourceMarker,
  serializeFeishuBitableConfig,
} from './feishuBitableConfig.js';

test('feishuBitableConfig：配置键与落点固定', () => {
  assert.equal(FEISHU_CONFIG_KEY, 'feishu_bitable_config');
  assert.equal(FEISHU_RAW_DIR, '原始资料/文档/飞书多维表格');
});

test('parseFeishuBitableUrl：base 链接解析 app_token / table / view', () => {
  const result = parseFeishuBitableUrl(
    'https://xinjework.feishu.cn/base/bascnCMII2ORej2RItqpZZUNMIe?table=tblxI2tWaxP5dG7p&view=vewqhz51lk',
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.link.kind, 'base');
  assert.equal(result.link.token, 'bascnCMII2ORej2RItqpZZUNMIe');
  assert.equal(result.link.tableId, 'tblxI2tWaxP5dG7p');
  assert.equal(result.link.viewId, 'vewqhz51lk');
  assert.equal(result.link.origin, 'https://xinjework.feishu.cn');
  assert.equal(result.link.apiBase, 'https://open.feishu.cn');
});

test('parseFeishuBitableUrl：wiki 链接按 node_token 处理，table 可缺省', () => {
  const result = parseFeishuBitableUrl('https://abc.feishu.cn/wiki/wikcnKQ1k3p8Vabcef');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.link.kind, 'wiki');
  assert.equal(result.link.token, 'wikcnKQ1k3p8Vabcef');
  assert.equal(result.link.tableId, '');
  assert.equal(result.link.viewId, '');
});

test('parseFeishuBitableUrl：Lark 国际域名走 open.larksuite.com', () => {
  const result = parseFeishuBitableUrl('https://acme.larksuite.com/base/bascnABC12345?table=tblABC12');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.link.apiBase, 'https://open.larksuite.com');
});

test('parseFeishuBitableUrl：缺协议时补 https，http 也接受', () => {
  const noScheme = parseFeishuBitableUrl('abc.feishu.cn/base/bascnABC12345');
  assert.equal(noScheme.ok, true);
  const http = parseFeishuBitableUrl('http://abc.feishu.cn/base/bascnABC12345');
  assert.equal(http.ok, true);
});

test('parseFeishuBitableUrl：非飞书域名 / 非表格页 / 坏 table 参数都给出可读错误', () => {
  const foreign = parseFeishuBitableUrl('https://example.com/base/bascnABC12345');
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.match(foreign.error, /feishu\.cn|larksuite\.com/);

  const doc = parseFeishuBitableUrl('https://abc.feishu.cn/docx/doccnABC12345');
  assert.equal(doc.ok, false);
  if (!doc.ok) assert.match(doc.error, /多维表格/);

  const badTable = parseFeishuBitableUrl('https://abc.feishu.cn/base/bascnABC12345?table=abc');
  assert.equal(badTable.ok, false);
  if (!badTable.ok) assert.match(badTable.error, /tbl/);

  const badToken = parseFeishuBitableUrl('https://abc.feishu.cn/base/../etc');
  assert.equal(badToken.ok, false);

  assert.equal(parseFeishuBitableUrl('').ok, false);
});

test('feishuFileName：清掉路径非法字符并兜底', () => {
  assert.equal(feishuFileName('客户/台账:2026*', 'tblABC12'), '客户-台账-2026');
  assert.equal(feishuFileName('  销售 台账  ', 'tblABC12'), '销售 台账');
  assert.equal(feishuFileName('', 'tblABC12'), '多维表格-tblABC12');
  assert.equal(feishuFileName(' . . ', 'tbl789xyz456'), '多维表格-tbl789xyz456');
  assert.ok(feishuFileName('长'.repeat(200), 'tblABC12').length <= 80);
});

test('feishuFilePath：重名追加序号，最多 99 次后带时间戳', () => {
  const existing = new Set([
    '原始资料/文档/飞书多维表格/客户台账.md',
    '原始资料/文档/飞书多维表格/客户台账 (2).md',
  ]);
  assert.equal(
    feishuFilePath('客户台账', 'tblABC12', (rel) => existing.has(rel)),
    '原始资料/文档/飞书多维表格/客户台账 (3).md',
  );
  assert.equal(
    feishuFilePath('新表', 'tblABC12', () => false),
    '原始资料/文档/飞书多维表格/新表.md',
  );
});

test('feishuSourceMarker：可解析回 appToken / tableId', () => {
  const marker = feishuSourceMarker('bascnCMII2ORej2RItqpZZUNMIe', 'tblxI2tWaxP5dG7p');
  assert.match(marker, /engram:feishu-bitable/);
  assert.deepEqual(parseFeishuSourceMarker(`前面\n${marker}\n后面`), {
    appToken: 'bascnCMII2ORej2RItqpZZUNMIe',
    tableId: 'tblxI2tWaxP5dG7p',
  });
  assert.equal(parseFeishuSourceMarker('没有标记'), null);
});

test('parseFeishuBitableConfig：坏 JSON / 缺字段 / 单条损坏都容错', () => {
  assert.deepEqual(parseFeishuBitableConfig(null), emptyFeishuConfig());
  assert.deepEqual(parseFeishuBitableConfig('{'), emptyFeishuConfig());
  assert.deepEqual(parseFeishuBitableConfig('[]'), emptyFeishuConfig());

  const good = newFeishuSource({
    name: '客户台账',
    url: 'https://abc.feishu.cn/base/bascnABC12345?table=tblABC12',
    appToken: 'bascnABC12345',
    appName: '销售管理',
    tableId: 'tblABC12',
    origin: 'https://abc.feishu.cn',
    apiBase: 'https://open.feishu.cn',
    filePath: '原始资料/文档/飞书多维表格/客户台账.md',
  });
  const parsed = parseFeishuBitableConfig(
    JSON.stringify({
      appId: 'cli_xxx',
      appSecret: 'secret',
      sources: [good, { id: 'broken' }, { ...good, id: 's2', tableId: 'not-a-table' }],
    }),
  );
  assert.equal(parsed.appId, 'cli_xxx');
  assert.equal(parsed.appSecret, 'secret');
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].name, '客户台账');
  assert.equal(parsed.sources[0].lastStatus, 'never');
});

test('parseFeishuBitableConfig：未知间隔/状态归一化，序列化可往返', () => {
  const source = newFeishuSource({
    name: '表一',
    url: 'https://abc.feishu.cn/base/bascnABC12345',
    appToken: 'bascnABC12345',
    appName: '',
    tableId: 'tblABC12',
    origin: 'https://abc.feishu.cn',
    apiBase: 'https://open.feishu.cn',
    filePath: '原始资料/文档/飞书多维表格/表一.md',
  });
  const config = {
    appId: 'cli_xxx',
    appSecret: 'secret',
    sources: [{ ...source, intervalMinutes: 999 as never, lastStatus: 'weird' as never }],
  };
  const parsed = parseFeishuBitableConfig(config);
  assert.equal(parsed.sources[0].intervalMinutes, 60);
  assert.equal(parsed.sources[0].lastStatus, 'never');
  assert.deepEqual(parseFeishuBitableConfig(serializeFeishuBitableConfig(parsed)), parsed);
});

test('normalizeFeishuCredentials：Secret 可留空沿用，App ID 必须非空', () => {
  assert.deepEqual(normalizeFeishuCredentials({ appId: ' cli_xxx ', appSecret: ' s ' }), {
    appId: 'cli_xxx',
    appSecret: 's',
  });
  assert.deepEqual(normalizeFeishuCredentials({ appId: 'cli_xxx', appSecret: '' }), {
    appId: 'cli_xxx',
    appSecret: '',
  });
  assert.equal(normalizeFeishuCredentials({ appId: '', appSecret: 's' }), null);
  assert.equal(normalizeFeishuCredentials({ appId: 1, appSecret: 's' }), null);
  assert.equal(normalizeFeishuCredentials(null), null);
  assert.equal(normalizeFeishuCredentials({ appId: 'a\u0000b', appSecret: 's' }), null);
});

test('feishuConfigForClient：只暴露 App ID 与 hasSecret，绝不带 Secret', () => {
  const view = feishuConfigForClient({
    appId: 'cli_xxx',
    appSecret: 'top-secret',
    apiBase: 'https://open.feishu.cn',
    sources: [],
  });
  assert.deepEqual(Object.keys(view).sort(), ['apiBase', 'appId', 'configured', 'hasSecret', 'sources']);
  assert.equal(view.configured, true);
  assert.equal(view.hasSecret, true);
  assert.equal(JSON.stringify(view).includes('top-secret'), false);

  const empty = feishuConfigForClient(emptyFeishuConfig());
  assert.equal(empty.configured, false);
  assert.equal(empty.hasSecret, false);
});
