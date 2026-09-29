import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { encodeQrText, encodeQrTextAuto, qrModule, qrTableSelfCheck, type QrEcc, type QrMatrix } from './qrEncode.ts';
import { buildInviteLink } from './syncInvite.ts';

/**
 * 二维码编码器的验收：**用另一个独立实现反解自己生成的位图**。
 *
 * jsqr 走的是「定位 → 采样 → 按格式信息反掩码 → Reed–Solomon 纠错」的完整读码流程，
 * 它能把内容读回来，就说明模块排布、掩码、格式信息、分块与纠错码字全部符合规范——
 * 这比逐条断言模块坐标更能说明问题（模块坐标的断言只覆盖我想到的那些）。
 *
 * 额外钉住两条：
 *  ① 分块表自洽（每块数据 + 每块纠错 = 该版本规范总码字数）；
 *  ② 功能图形结构（定时图形、定位图形的第 6 行/列）——初次实现把定时图形画在定位图形之后，
 *     定位图形被切成明暗条，所有解码器全部读不出来；这条断言就是那个 bug 的护栏。
 */

/** 把位图铺成 RGBA 像素（scale 像素/模块，四周留 quiet 模块静区），与扫码时喂给 jsqr 的形式一致 */
function toImageData(matrix: QrMatrix, scale = 4, quiet = 4): { data: Uint8ClampedArray; size: number } {
  const px = (matrix.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!qrModule(matrix, x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const index = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
          data[index] = 0;
          data[index + 1] = 0;
          data[index + 2] = 0;
          data[index + 3] = 255;
        }
      }
    }
  }
  return { data, size: px };
}

function decode(matrix: QrMatrix): string | null {
  const image = toImageData(matrix);
  const result = jsQR(image.data, image.size, image.size, { inversionAttempts: 'dontInvert' });
  return result ? result.data : null;
}

test('分块表自洽：每版本/级别的总码字数等于规范值', () => {
  for (const row of qrTableSelfCheck()) {
    assert.equal(row.codewords, row.expected, `v${row.version}-${row.ecc}`);
  }
});

test('各版本/纠错级别的位图都能被独立实现读回原文', () => {
  // 覆盖 v1–v10：长度逐档逼出不同版本（v1-M 16 字节 → v10-M 213 字节）
  const cases: Array<{ ecc: QrEcc; text: string }> = [
    { ecc: 'M', text: 'A' },
    { ecc: 'M', text: 'HELLO WORLD' },
    { ecc: 'M', text: 'x'.repeat(20) },
    { ecc: 'M', text: 'x'.repeat(60) },
    { ecc: 'M', text: 'x'.repeat(120) },
    { ecc: 'M', text: 'x'.repeat(213) },
    { ecc: 'L', text: 'x'.repeat(271) },
    { ecc: 'Q', text: 'x'.repeat(100) },
    { ecc: 'H', text: 'x'.repeat(60) },
  ];
  for (const item of cases) {
    const matrix = encodeQrText(item.text, { ecc: item.ecc });
    assert.equal(decode(matrix), item.text, `${item.ecc}/${item.text.length} 字节（v${matrix.version}）`);
  }
});

test('真实邀请链接（含中文成员名）也读得回来', () => {
  const link = buildInviteLink({
    hubUrl: 'http://192.168.31.100:18080',
    token: 'lsync_' + 'a1b2c3d4'.repeat(6),
    name: '客厅 NAS',
  });
  const matrix = encodeQrText(link, { ecc: 'M' });
  // 码面尺寸要合理：屏幕上显示时每个模块至少 4px，v10（57 模块）以内都能摆下
  assert.ok(matrix.version <= 10);
  assert.equal(decode(matrix), link);
});

test('内容放不下时按容错强度降级（H → Q → M → L）', () => {
  const long = 'x'.repeat(200);
  const { matrix, downgraded } = encodeQrTextAuto(long);
  assert.ok(downgraded);
  assert.equal(matrix.ecc, 'M');
  assert.equal(decode(matrix), long);

  const short = 'hello';
  const auto = encodeQrTextAuto(short);
  assert.equal(auto.matrix.ecc, 'H');
  assert.equal(auto.downgraded, false);
  assert.equal(decode(auto.matrix), short);
});

test('功能图形结构正确：定时图形是明暗交替、定位图形区域不被切成条纹', () => {
  const matrix = encodeQrText('A', { ecc: 'M' });
  const size = matrix.size;
  // 定时图形（第 6 行 / 第 6 列）：偶数坐标深、奇数坐标浅
  for (let i = 8; i <= size - 9; i++) {
    assert.equal(qrModule(matrix, i, 6), i % 2 === 0, `行定时 x=${i}`);
    assert.equal(qrModule(matrix, 6, i), i % 2 === 0, `列定时 y=${i}`);
  }
  // 定位图形第 6 行/列必须是实心深色（第 6 行 x=0..6 属于左上定位图形）
  for (let i = 0; i <= 6; i++) {
    assert.equal(qrModule(matrix, i, 6), true, `定位图形第 6 行 x=${i} 应为深色`);
    assert.equal(qrModule(matrix, 6, i), true, `定位图形第 6 列 y=${i} 应为深色`);
  }
  // 分隔符（定位图形外侧一圈）是浅色
  assert.equal(qrModule(matrix, 7, 7), false);
  assert.equal(qrModule(matrix, size - 8, 7), false);
  assert.equal(qrModule(matrix, 7, size - 8), false);
  // 固定深色模块（左下定位图形上方一格）
  assert.equal(qrModule(matrix, 8, size - 8), true);
});
