import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { officeToText, xlsxToText } from './office.js';

test('xlsxToText extracts non-empty sheets into markdown tables and skips blank sheets', async () => {
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('报价单');
  s1.addRow(['项目', '金额', '说明']);
  s1.addRow(['服务器', 12000, { richText: [{ text: '首年' }, { text: '托管' }] }]);
  s1.addRow(['合计', { formula: 'B2*2', result: 24000 }, '含税|备注']);

  wb.addWorksheet('空白页');

  const raw = await wb.xlsx.writeBuffer();
  const buf = Buffer.from(raw);
  const text = await xlsxToText(buf);

  assert.match(text, /^## 报价单/m);
  assert.match(text, /\| 项目 \| 金额 \| 说明 \|/);
  assert.match(text, /\| 服务器 \| 12000 \| 首年托管 \|/);
  assert.match(text, /\| 合计 \| 24000 \| 含税\/备注 \|/);
  assert.doesNotMatch(text, /空白页/);

  const viaOffice = await officeToText('xlsx', buf);
  assert.equal(viaOffice, text);
});
