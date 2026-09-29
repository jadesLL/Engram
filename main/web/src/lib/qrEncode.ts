/**
 * 二维码编码器（字节模式，版本 1–10，纠错级别 L/M/Q/H）。
 *
 * 为什么自己实现而不是引第三方库：这里只需要**生成**二维码这一件事，且内容固定是几十到
 * 两百来字节的邀请链接；二维码的模块排布、掩码与格式信息都是封闭规范，自己实现一份带注释、
 * 可被单测逐条钉住的代码，比拉一个通用库更可控（库主要贵在另一头：从照片里**识别**二维码——
 * 那一头用 `jsqr`，见 lib/qrScan.ts）。单测里用 jsqr 反解自己生成的位图，等于每次都用
 * 一个独立实现给这份编码器做端到端校验（tests 见 qrEncode.test.ts）。
 *
 * 规范要点（与 ISO/IEC 18004 一致，也是 jsqr / zxing 的读法）：
 *  - 数据先按「模式指示符 + 字符计数 + 字节」写进比特流，补终止符与填充字节（0xEC / 0x11 交替）；
 *  - 数据码字按版本/纠错级别的分块表切成多块，各自算 Reed–Solomon 纠错码字，再按列交错；
 *  - 模块从右下角起以「之」字形填布，跳过功能图形（定位/校正/定时/格式区）；
 *  - 最后按 8 种掩码里罚分最低的一种异或数据区，并把「纠错级别 + 掩码号」写进格式信息区。
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** 版本号（1–10）：边长 = version * 4 + 17 */
  version: number;
  ecc: QrEcc;
  size: number;
  /** 行优先位图，1 = 深色模块，0 = 浅色模块；不含静区（绘制时自行留 4 模块） */
  modules: Uint8Array;
}

/** 本实现支持的版本上限：邀请链接最多约 200 字节，v10 的 M 级容量（213 字节）足够 */
const MAX_VERSION = 10;

/** 各版本总码字数（数据 + 纠错），用于自检分块表是否自洽 */
const TOTAL_CODEWORDS: Record<number, number> = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
};

/** 校正图形中心坐标（版本 1 没有校正图形） */
const ALIGN_POSITIONS: Record<number, readonly number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

interface EccSpec {
  /** 每块的纠错码字数 */
  ecPerBlock: number;
  /** 分块表：[每块数据码字数, 块数]；第二组的每块数据码字比第一组多 1（规范如此） */
  groups: ReadonlyArray<readonly [number, number]>;
}

/** 版本 1–10 × 纠错级别 L/M/Q/H 的分块表（标准表；单测里与总码字数交叉校验） */
const ECC_TABLE: Record<number, Record<QrEcc, EccSpec>> = {
  1: { L: { ecPerBlock: 7, groups: [[19, 1]] }, M: { ecPerBlock: 10, groups: [[16, 1]] }, Q: { ecPerBlock: 13, groups: [[13, 1]] }, H: { ecPerBlock: 17, groups: [[9, 1]] } },
  2: { L: { ecPerBlock: 10, groups: [[34, 1]] }, M: { ecPerBlock: 16, groups: [[28, 1]] }, Q: { ecPerBlock: 22, groups: [[22, 1]] }, H: { ecPerBlock: 28, groups: [[16, 1]] } },
  3: { L: { ecPerBlock: 15, groups: [[55, 1]] }, M: { ecPerBlock: 26, groups: [[44, 1]] }, Q: { ecPerBlock: 18, groups: [[17, 2]] }, H: { ecPerBlock: 22, groups: [[13, 2]] } },
  4: { L: { ecPerBlock: 20, groups: [[80, 1]] }, M: { ecPerBlock: 18, groups: [[32, 2]] }, Q: { ecPerBlock: 26, groups: [[24, 2]] }, H: { ecPerBlock: 16, groups: [[9, 4]] } },
  5: { L: { ecPerBlock: 26, groups: [[108, 1]] }, M: { ecPerBlock: 24, groups: [[43, 2]] }, Q: { ecPerBlock: 18, groups: [[15, 2], [16, 2]] }, H: { ecPerBlock: 22, groups: [[11, 2], [12, 2]] } },
  6: { L: { ecPerBlock: 18, groups: [[68, 2]] }, M: { ecPerBlock: 16, groups: [[27, 4]] }, Q: { ecPerBlock: 24, groups: [[19, 4]] }, H: { ecPerBlock: 28, groups: [[15, 4]] } },
  7: { L: { ecPerBlock: 20, groups: [[78, 2]] }, M: { ecPerBlock: 18, groups: [[31, 4]] }, Q: { ecPerBlock: 18, groups: [[14, 2], [15, 4]] }, H: { ecPerBlock: 26, groups: [[13, 4], [14, 1]] } },
  8: { L: { ecPerBlock: 24, groups: [[97, 2]] }, M: { ecPerBlock: 22, groups: [[38, 2], [39, 2]] }, Q: { ecPerBlock: 22, groups: [[18, 4], [19, 2]] }, H: { ecPerBlock: 26, groups: [[14, 4], [15, 2]] } },
  9: { L: { ecPerBlock: 30, groups: [[116, 2]] }, M: { ecPerBlock: 22, groups: [[36, 3], [37, 2]] }, Q: { ecPerBlock: 20, groups: [[16, 4], [17, 4]] }, H: { ecPerBlock: 24, groups: [[12, 4], [13, 4]] } },
  10: { L: { ecPerBlock: 18, groups: [[68, 2], [69, 2]] }, M: { ecPerBlock: 26, groups: [[43, 4], [44, 1]] }, Q: { ecPerBlock: 24, groups: [[19, 6], [20, 2]] }, H: { ecPerBlock: 28, groups: [[15, 6], [16, 2]] } },
};

/** 格式信息里「纠错级别」的 2 位编码：L=01 / M=00 / Q=11 / H=10 */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** 纠错级别容错强度排序：内容放不下时按这个顺序降级（M → L） */
export const ECC_FALLBACK_ORDER: readonly QrEcc[] = ['H', 'Q', 'M', 'L'];

class BitBuffer {
  private readonly bits: number[] = [];

  get length(): number {
    return this.bits.length;
  }

  /** 追加 value 的最低 length 位（高位在前，即规范里的书写顺序） */
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  toBytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] || 0);
      out.push(byte);
    }
    return out;
  }
}

/**
 * 生成二维码；内容超过 v10 的容量时抛错（调用方按 ECC_FALLBACK_ORDER 降级重试）。
 * 默认 M 级纠错（约 15% 容错）：屏幕对屏幕扫码几乎无损，M 已经足够，还能把码面控制在可读尺寸。
 */
export function encodeQrText(text: string, options: { ecc?: QrEcc } = {}): QrMatrix {
  const ecc: QrEcc = options.ecc ?? 'M';
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length, ecc);
  const codewords = buildCodewords(bytes, version, ecc);
  return buildMatrix(version, ecc, codewords);
}

/** 按容错强度从强到弱挑一个放得下的级别（H → Q → M → L）；都放不下时抛错 */
export function encodeQrTextAuto(text: string): { matrix: QrMatrix; downgraded: boolean } {
  let lastError: unknown = null;
  for (const ecc of ECC_FALLBACK_ORDER) {
    try {
      return { matrix: encodeQrText(text, { ecc }), downgraded: ecc !== ECC_FALLBACK_ORDER[0] };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('二维码内容过长');
}

/** 读取某个模块（越界返回 false，方便绘制时无脑取） */
export function qrModule(matrix: QrMatrix, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) return false;
  return matrix.modules[y * matrix.size + x] === 1;
}

/** 挑版本：能装下「模式 + 字符计数 + 数据」的最小版本 */
function chooseVersion(byteLength: number, ecc: QrEcc): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacityBits = dataCodewords(version, ecc) * 8;
    const overheadBits = 4 + (version >= 10 ? 16 : 8);
    if (byteLength * 8 + overheadBits <= capacityBits) return version;
  }
  throw new Error(`二维码内容过长：${byteLength} 字节超出 v${MAX_VERSION}-${ecc} 容量`);
}

function dataCodewords(version: number, ecc: QrEcc): number {
  return ECC_TABLE[version][ecc].groups.reduce((sum, [count, blocks]) => sum + count * blocks, 0);
}

/** 数据码字 → 分块 + Reed–Solomon 纠错 → 交错成最终码字序列 */
function buildCodewords(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const spec = ECC_TABLE[version][ecc];
  const capacityBits = dataCodewords(version, ecc) * 8;
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // 字节模式
  buffer.push(bytes.length, version >= 10 ? 16 : 8); // 字符计数
  for (const byte of bytes) buffer.push(byte, 8);
  buffer.push(0, Math.min(4, capacityBits - buffer.length)); // 终止符
  while (buffer.length % 8 !== 0) buffer.push(0, 1); // 补齐到字节边界
  const padBytes = [0xEC, 0x11];
  for (let i = 0; buffer.length < capacityBits; i++) buffer.push(padBytes[i % 2], 8);

  const codewords = buffer.toBytes();
  const divisor = rsDivisor(spec.ecPerBlock);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [count, blocks] of spec.groups) {
    for (let i = 0; i < blocks; i++) {
      const block = codewords.slice(offset, offset + count);
      offset += count;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, divisor));
    }
  }

  // 交错：先按列铺所有块的数据码字（短块跳过已用尽的位置），再按列铺纠错码字
  const interleaved: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) interleaved.push(block[i]);
  }
  return interleaved;
}

/** GF(256) 乘法（本原多项式 0x11D） */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Reed–Solomon 生成多项式（次数 = 纠错码字数） */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** 多项式长除法取余数：data 的纠错码字 */
function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

/** 铺功能图形 + 数据 + 掩码 + 格式信息，得到最终位图 */
function buildMatrix(version: number, ecc: QrEcc, codewords: readonly number[]): QrMatrix {
  const size = version * 4 + 17;
  const modules = new Uint8Array(size * size);
  const reserved = new Uint8Array(size * size);

  const set = (x: number, y: number, dark: boolean, lock = true) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y * size + x] = dark ? 1 : 0;
    if (lock) reserved[y * size + x] = 1;
  };
  const setFunction = (x: number, y: number, dark: boolean) => set(x, y, dark, true);

  // ---- 定时图形（第 6 行 / 第 6 列的明暗交替）**必须先画**：定位图形随后会覆盖自己范围内的
  // 那一小段（第 6 行 x=0..6 与第 6 列 y=0..6 之类）——顺序反了会把定位图形切成明暗条，
  // 任何解码器都找不到码（2026-09-30 初次实现即踩到：jsqr 全部反解为 null）。
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // ---- 定位图形 + 分隔符（三个角）
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFunction(x, y, dist !== 2 && dist <= 3);
      }
    }
  }

  // ---- 校正图形（跳过与定位图形重叠的位置）
  const align = ALIGN_POSITIONS[version];
  for (const cy of align) {
    for (const cx of align) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // ---- 版本信息（版本 7 起，左右各一份 3×6）
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  // ---- 格式信息区先占位（内容在掩码选定后写入）。
  // 注意跳过 (8,6) 与 (6,8)：那是定时图形的地盘，格式信息只占 15 + 15 个位置，不覆盖它们。
  for (let i = 0; i <= 8; i++) {
    if (i === 6) continue;
    setFunction(8, i, false);
    setFunction(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFunction(size - 1 - i, 8, false);
    setFunction(8, size - 1 - i, false);
  }

  // ---- 数据模块：右下角起「之」字形，跳过功能图形与第 6 列（定时列）
  const dataPositions: number[] = [];
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      // 每两列换一次上下方向（之字形）：`(right + 1) & 2` 为 0 时自下而上
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (reserved[y * size + x] === 1) continue;
        dataPositions.push(y * size + x);
        const dark = bitIndex < codewords.length * 8
          && ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
        modules[y * size + x] = dark ? 1 : 0;
        bitIndex++;
      }
    }
  }

  // ---- 掩码：8 选 1（罚分最低），再写格式信息
  const best = chooseMask(modules, size, dataPositions);
  for (const index of dataPositions) {
    const x = index % size;
    const y = Math.floor(index / size);
    if (maskBit(best, x, y)) modules[index] ^= 1;
  }
  writeFormatBits(setFunction, size, ecc, best);
  return { version, ecc, size, modules };
}

/** 掩码函数（规范里的 8 种，编号即写进格式信息里的掩码号） */
function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/**
 * 选掩码：规范给了 4 条罚分规则，这里用最常用的简化等价写法——
 * ①连续同色 5 个起罚、②2×2 同色块、③定位图形样式的 1:1:3:1:1 伪影、④黑白比例失衡。
 * 掩码只影响可读性（解码器按格式信息里的掩码号反算），所以选得不必最优，但不能不选对。
 */
function chooseMask(modules: Uint8Array, size: number, dataPositions: readonly number[]): number {
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const trial = Uint8Array.from(modules);
    for (const index of dataPositions) {
      const x = index % size;
      const y = Math.floor(index / size);
      if (maskBit(mask, x, y)) trial[index] ^= 1;
    }
    const penalty = maskPenalty(trial, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
  }
  return bestMask;
}

function maskPenalty(modules: Uint8Array, size: number): number {
  const at = (x: number, y: number) => modules[y * size + x] === 1;
  let penalty = 0;

  // ①②行/列连续同色与 2×2 同色块
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (at(x, y) === at(x - 1, y)) run++;
      else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (at(x, y) === at(x, y - 1)) run++;
      else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = at(x, y);
      if (color === at(x + 1, y) && color === at(x, y + 1) && color === at(x + 1, y + 1)) penalty += 3;
    }
  }

  // ③ 1:1:3:1:1 加四格浅色（定位图形的样子），横竖各查一遍
  const finderLike = (get: (i: number) => boolean, length: number): number => {
    let count = 0;
    for (let i = 0; i + 11 <= length; i++) {
      const window: boolean[] = [];
      for (let k = 0; k < 11; k++) window.push(get(i + k));
      const pattern = window.map((dark) => (dark ? '1' : '0')).join('');
      if (pattern === '10111010000' || pattern === '00001011101') count++;
    }
    return count;
  };
  for (let y = 0; y < size; y++) penalty += 40 * finderLike((x) => at(x, y), size);
  for (let x = 0; x < size; x++) penalty += 40 * finderLike((y) => at(x, y), size);

  // ④ 黑白比例：越偏离 50% 罚越多，每 5% 计 10 分
  let dark = 0;
  for (let i = 0; i < modules.length; i++) if (modules[i] === 1) dark++;
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return penalty;
}

/** 格式信息：5 位数据（纠错级别 + 掩码号）→ BCH(15,5) → 异或 0x5412，写两份 */
function writeFormatBits(setFunction: (x: number, y: number, dark: boolean) => void, size: number, ecc: QrEcc, mask: number): void {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
  setFunction(8, 7, bit(6));
  setFunction(8, 8, bit(7));
  setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));
  setFunction(8, size - 8, true); // 固定深色模块
}

/** 自检用：分块表的总码字数应当与该版本规范总码字数一致（单测据此钉住整张表） */
export function qrTableSelfCheck(): Array<{ version: number; ecc: QrEcc; codewords: number; expected: number }> {
  const rows: Array<{ version: number; ecc: QrEcc; codewords: number; expected: number }> = [];
  for (let version = 1; version <= MAX_VERSION; version++) {
    for (const ecc of ECC_FALLBACK_ORDER) {
      const spec = ECC_TABLE[version][ecc];
      const blocks = spec.groups.reduce((sum, [, count]) => sum + count, 0);
      const codewords = spec.groups.reduce((sum, [count, n]) => sum + count * n, 0) + spec.ecPerBlock * blocks;
      rows.push({ version, ecc, codewords, expected: TOTAL_CODEWORDS[version] });
    }
  }
  return rows;
}
