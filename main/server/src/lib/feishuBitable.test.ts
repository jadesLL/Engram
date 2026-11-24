import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FeishuApiError,
  bitableCellText,
  clearFeishuTokenCache,
  describeFeishuError,
  fetchBitableTable,
  fetchTenantAccessToken,
  formatFeishuDateTime,
  listBitableTables,
  renderBitableMarkdown,
  resolveBitableApp,
} from './feishuBitable.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** 按 URL 规则应答的 fetch 桩；记录每次调用，便于断言分页 / token 复用 */
function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function tokenBody(token = 't-token'): Response {
  return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 });
}

const FIXED_NOW = 1_764_000_000_000;

function ctx(fetchImpl: typeof fetch, appId = 'cli_test') {
  return { appId, appSecret: 'secret', fetchImpl, now: () => FIXED_NOW };
}

test('bitableCellText：文本 / 日期 / 复选框 / 人员 / 链接 / 附件 / 位置', () => {
  assert.equal(bitableCellText('普通文本', 1), '普通文本');
  assert.equal(bitableCellText(123.45, 2), '123.45');
  assert.equal(bitableCellText(1_764_000_000_000, 5), formatFeishuDateTime(1_764_000_000_000));
  assert.equal(bitableCellText(true, 7), '是');
  assert.equal(bitableCellText(false, 7), '否');
  assert.equal(bitableCellText([{ id: 'ou_1', name: '张三' }, { id: 'ou_2', name: '李四' }], 11), '张三、李四');
  assert.equal(bitableCellText({ text: '官网', link: 'https://example.com' }, 15), '官网（https://example.com）');
  assert.equal(
    bitableCellText([{ file_token: 'f1', name: '合同.pdf' }, { file_token: 'f2', name: '报价.xlsx' }], 17),
    '合同.pdf、报价.xlsx',
  );
  assert.equal(
    bitableCellText({ pname: '浙江省', cityname: '杭州市', address: '西湖区' }, 22),
    '浙江省杭州市西湖区',
  );
  assert.equal(bitableCellText(['单选A', '多选B'], 4), '单选A、多选B');
  assert.equal(bitableCellText({ text: '富文本段' }, 1), '富文本段');
  assert.equal(bitableCellText(null, 1), '');
});

test('formatFeishuDateTime：毫秒时间戳按本地时区格式化为分钟', () => {
  assert.equal(formatFeishuDateTime(0), '');
  assert.equal(formatFeishuDateTime(Number.NaN), '');
  const text = formatFeishuDateTime(FIXED_NOW);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('renderBitableMarkdown：来源头 + 表格 + 转义 + 无一级标题', () => {
  const markdown = renderBitableMarkdown({
    appToken: 'bascnCMII2ORej2RItqpZZUNMIe',
    appName: '销售管理',
    tableId: 'tblxI2tWaxP5dG7p',
    tableName: '客户台账',
    url: 'https://abc.feishu.cn/base/bascnCMII2ORej2RItqpZZUNMIe?table=tblxI2tWaxP5dG7p',
    fields: [
      { fieldId: 'f1', fieldName: '客户名称', type: 1, isPrimary: true },
      { fieldId: 'f2', fieldName: '阶段', type: 3, isPrimary: false },
      { fieldId: 'f3', fieldName: '备注', type: 1, isPrimary: false },
    ],
    records: [
      { recordId: 'rec1', fields: { 客户名称: '甲公司', 阶段: '洽谈中', 备注: '第一行\n第二行' } },
      { recordId: 'rec2', fields: { 客户名称: '乙|公司', 阶段: '已成交', 备注: null } },
    ],
    truncated: false,
  });
  assert.match(markdown, /engram:feishu-bitable app=bascnCMII2ORej2RItqpZZUNMIe table=tblxI2tWaxP5dG7p/);
  assert.match(markdown, /多维表格：销售管理 · 数据表：客户台账/);
  assert.match(markdown, /共 2 条记录，3 列/);
  assert.match(markdown, /^\| 客户名称 \| 阶段 \| 备注 \|$/m);
  assert.match(markdown, /^\| --- \| --- \| --- \|$/m);
  assert.match(markdown, /甲公司/);
  assert.match(markdown, /第一行<br>第二行/);
  assert.match(markdown, /乙\\\|公司/);
  assert.equal(markdown.startsWith('# '), false);
});

test('renderBitableMarkdown：空表 / 无字段 / 截断都有明确说明', () => {
  const empty = renderBitableMarkdown({
    appToken: 'bascnABC12345',
    appName: '',
    tableId: 'tblABC12',
    tableName: '空表',
    url: 'https://abc.feishu.cn/base/bascnABC12345',
    fields: [{ fieldId: 'f1', fieldName: '名称', type: 1, isPrimary: true }],
    records: [],
    truncated: false,
  });
  assert.match(empty, /该数据表暂无记录/);

  const noFields = renderBitableMarkdown({
    appToken: 'bascnABC12345',
    appName: '',
    tableId: 'tblABC12',
    tableName: '无字段',
    url: '',
    fields: [],
    records: [],
    truncated: false,
  });
  assert.match(noFields, /没有可读取的字段/);

  const truncated = renderBitableMarkdown({
    appToken: 'bascnABC12345',
    appName: '',
    tableId: 'tblABC12',
    tableName: '大表',
    url: '',
    fields: [{ fieldId: 'f1', fieldName: '名称', type: 1, isPrimary: true }],
    records: [{ recordId: 'rec1', fields: { 名称: '甲' } }],
    truncated: true,
  });
  assert.match(truncated, /只拉取前 20000 条/);
});

test('fetchTenantAccessToken：成功取到并缓存（第二次不再请求）', async () => {
  clearFeishuTokenCache();
  const { fetchImpl, calls } = stubFetch(() => tokenBody('t-cached'));
  const context = ctx(fetchImpl, 'cli_cache_test');
  assert.equal(await fetchTenantAccessToken(context, 'https://open.feishu.cn'), 't-cached');
  assert.equal(await fetchTenantAccessToken(context, 'https://open.feishu.cn'), 't-cached');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /tenant_access_token\/internal$/);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    app_id: 'cli_cache_test',
    app_secret: 'secret',
  });
});

test('fetchTenantAccessToken：App Secret 错误给出中文提示', async () => {
  clearFeishuTokenCache();
  const { fetchImpl } = stubFetch(() => jsonResponse({ code: 10003, msg: 'invalid param' }));
  await assert.rejects(
    () => fetchTenantAccessToken(ctx(fetchImpl, 'cli_bad_secret'), 'https://open.feishu.cn'),
    (error: unknown) => {
      assert.ok(error instanceof FeishuApiError);
      assert.equal(error.code, 10003);
      assert.match(error.message, /App ID 或 App Secret 不正确/);
      return true;
    },
  );
});

test('resolveBitableApp：wiki 节点换成 obj_token；非多维表格拒绝', async () => {
  clearFeishuTokenCache();
  const { fetchImpl, calls } = stubFetch((call) => {
    if (call.url.includes('tenant_access_token')) return tokenBody();
    if (call.url.includes('/wiki/v2/spaces/get_node')) {
      return jsonResponse({
        code: 0,
        data: { node: { obj_type: 'bitable', obj_token: 'bascnFromWiki123', title: '知识库表' } },
      });
    }
    if (call.url.includes('/bitable/v1/apps/bascnFromWiki123')) {
      return jsonResponse({ code: 0, data: { app: { name: '销售管理' } } });
    }
    return jsonResponse({ code: 999404, msg: 'unexpected ' + call.url });
  });
  const resolved = await resolveBitableApp(ctx(fetchImpl, 'cli_wiki'), {
    kind: 'wiki',
    token: 'wikcnKQ1k3p8Vabcef',
    tableId: '',
    viewId: '',
    origin: 'https://abc.feishu.cn',
    apiBase: 'https://open.feishu.cn',
  });
  assert.deepEqual(resolved, { appToken: 'bascnFromWiki123', appName: '销售管理' });
  assert.ok(calls.some((call) => call.url.includes('obj_type=wiki')));

  clearFeishuTokenCache();
  const notBitable = stubFetch((call) => {
    if (call.url.includes('tenant_access_token')) return tokenBody();
    return jsonResponse({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'doccn123' } } });
  });
  await assert.rejects(
    () =>
      resolveBitableApp(ctx(notBitable.fetchImpl, 'cli_doc'), {
        kind: 'wiki',
        token: 'wikcnKQ1k3p8Vabcef',
        tableId: '',
        viewId: '',
        origin: 'https://abc.feishu.cn',
        apiBase: 'https://open.feishu.cn',
      }),
    /不是多维表格/,
  );
});

test('listBitableTables：按 page_token 翻页', async () => {
  clearFeishuTokenCache();
  let tablePage = 0;
  const { fetchImpl } = stubFetch((call) => {
    if (call.url.includes('tenant_access_token')) return tokenBody();
    if (call.url.includes('/tables?')) {
      tablePage += 1;
      if (tablePage === 1) {
        return jsonResponse({
          code: 0,
          data: { items: [{ table_id: 'tblA1', name: '表一' }], has_more: true, page_token: 'p2' },
        });
      }
      return jsonResponse({ code: 0, data: { items: [{ table_id: 'tblB2', name: '表二' }], has_more: false } });
    }
    return jsonResponse({ code: 999404, msg: 'unexpected ' + call.url });
  });
  const tables = await listBitableTables(ctx(fetchImpl, 'cli_tables'), {
    apiBase: 'https://open.feishu.cn',
    appToken: 'bascnABC12345',
  });
  assert.deepEqual(tables, [
    { tableId: 'tblA1', name: '表一' },
    { tableId: 'tblB2', name: '表二' },
  ]);
  assert.equal(tablePage, 2);
});

test('fetchBitableTable：字段与记录都翻页，记录字段按 field_name 取', async () => {
  clearFeishuTokenCache();
  let fieldPage = 0;
  let recordPage = 0;
  const { fetchImpl } = stubFetch((call) => {
    if (call.url.includes('tenant_access_token')) return tokenBody();
    if (call.url.includes('/tables?')) {
      return jsonResponse({ code: 0, data: { items: [{ table_id: 'tblABC12', name: '客户台账' }] } });
    }
    if (call.url.includes('/fields?')) {
      fieldPage += 1;
      if (fieldPage === 1) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{ field_id: 'f1', field_name: '客户名称', type: 1, is_primary: true }],
            has_more: true,
            page_token: 'fp2',
          },
        });
      }
      return jsonResponse({
        code: 0,
        data: { items: [{ field_id: 'f2', field_name: '阶段', type: 3 }], has_more: false },
      });
    }
    if (call.url.includes('/records?')) {
      recordPage += 1;
      if (recordPage === 1) {
        return jsonResponse({
          code: 0,
          data: {
            items: [{ record_id: 'rec1', fields: { 客户名称: '甲公司', 阶段: '洽谈中' } }],
            has_more: true,
            page_token: 'rp2',
          },
        });
      }
      return jsonResponse({
        code: 0,
        data: { items: [{ record_id: 'rec2', fields: { 客户名称: '乙公司' } }], has_more: false },
      });
    }
    return jsonResponse({ code: 999404, msg: 'unexpected ' + call.url });
  });
  const table = await fetchBitableTable(ctx(fetchImpl, 'cli_table'), {
    apiBase: 'https://open.feishu.cn',
    appToken: 'bascnABC12345',
    tableId: 'tblABC12',
  });
  assert.equal(table.tableName, '客户台账');
  assert.deepEqual(table.fields.map((field) => field.fieldName), ['客户名称', '阶段']);
  assert.equal(table.fields[0].isPrimary, true);
  assert.deepEqual(table.records.map((record) => record.recordId), ['rec1', 'rec2']);
  assert.equal(table.truncated, false);
});

test('fetchBitableTable：table 不存在时给出可执行提示', async () => {
  clearFeishuTokenCache();
  const { fetchImpl } = stubFetch((call) => {
    if (call.url.includes('tenant_access_token')) return tokenBody();
    if (call.url.includes('/tables?')) {
      return jsonResponse({ code: 0, data: { items: [{ table_id: 'tblOther1', name: '别的表' }] } });
    }
    return jsonResponse({ code: 0, data: {} });
  });
  await assert.rejects(
    () =>
      fetchBitableTable(ctx(fetchImpl, 'cli_missing_table'), {
        apiBase: 'https://open.feishu.cn',
        appToken: 'bascnABC12345',
        tableId: 'tblABC12',
      }),
    (error: unknown) => {
      assert.ok(error instanceof FeishuApiError);
      assert.equal(error.code, 1254004);
      assert.match(describeFeishuError(error), /数据表不存在或应用无权访问/);
      return true;
    },
  );
});

test('authorizedRequest：token 失效时清缓存重取并重试一次', async () => {
  clearFeishuTokenCache();
  let tokenCalls = 0;
  let recordCalls = 0;
  const { fetchImpl } = stubFetch((call) => {
    if (call.url.includes('tenant_access_token')) {
      tokenCalls += 1;
      return tokenBody(`t-${tokenCalls}`);
    }
    if (call.url.includes('/tables?')) {
      return jsonResponse({ code: 0, data: { items: [{ table_id: 'tblABC12', name: '客户台账' }] } });
    }
    if (call.url.includes('/fields?')) {
      return jsonResponse({ code: 0, data: { items: [{ field_name: '名称', type: 1 }] } });
    }
    if (call.url.includes('/records?')) {
      recordCalls += 1;
      if (recordCalls === 1) return jsonResponse({ code: 99991663, msg: 'invalid access token' });
      return jsonResponse({ code: 0, data: { items: [{ record_id: 'rec1', fields: { 名称: '甲' } }] } });
    }
    return jsonResponse({ code: 999404, msg: 'unexpected' });
  });
  const table = await fetchBitableTable(ctx(fetchImpl, 'cli_retry'), {
    apiBase: 'https://open.feishu.cn',
    appToken: 'bascnABC12345',
    tableId: 'tblABC12',
  });
  assert.equal(table.records.length, 1);
  assert.equal(recordCalls, 2);
  assert.equal(tokenCalls, 2);
});

test('describeFeishuError：权限类错误都翻成用户能照做的中文', () => {
  assert.match(
    describeFeishuError(new FeishuApiError('no scope', { code: 99991672 })),
    /bitable:app:readonly.*协作者/,
  );
  assert.match(describeFeishuError(new FeishuApiError('wrong token', { code: 1254003 })), /添加文档应用/);
  assert.match(describeFeishuError(new FeishuApiError('bad node', { code: 91402 })), /wiki:wiki:readonly/);
  assert.match(describeFeishuError(new Error('普通错误')), /普通错误/);
});
