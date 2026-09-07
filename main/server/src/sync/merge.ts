/**
 * 字符级三方合并引擎（多端同步的冲突裁决核心），零外部依赖。
 *
 * 语义（与发版计划一致）：
 *  - 两侧改动区间不重叠 → 全部保留（字符级融合）
 *  - 两侧同一处做了相同修改 → 应用一次，不算冲突
 *  - 两侧同一处做了不同修改 → 冲突：取 ours（先到达 hub 的一方），
 *    theirs 的对应内容记录进 conflicts，由调用方写入冲突备份页，不丢内容
 *
 * diff 采用 Myers O(ND) 算法：先剥离公共前缀/后缀，编辑距离超过上限
 * （视为整页重写）时降级为「整体替换」单一变更区，由冲突路径兜底。
 */

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

/** 编辑距离上限：超出即视为整页重写（页面体量下正常并发编辑远低于此值） */
const MAX_EDIT_DISTANCE = 4000;

/** 一个变更区：base[start, end) 被替换为 text（start===end 表示纯插入） */
interface Hunk {
  start: number;
  end: number;
  text: string;
}

type DiffOp = [number, string];

/**
 * Myers 贪心算法求 a→b 的字符 diff（EQUAL/INSERT/DELETE 序列）。
 * 先剥离公共前后缀；编辑距离超过 MAX_EDIT_DISTANCE 时返回单一全量替换。
 */
function diffChars(a: string, b: string): DiffOp[] {
  if (a === b) return [[DIFF_EQUAL, a]];
  // 先剥公共后缀、再在剩余头部剥公共前缀：顺序保证两个区间不相交，
  // 否则（先前缀）前缀可能越过本应属于后缀的公共区，产出错误 diff
  let suffix = 0;
  const maxSuffix = Math.min(a.length, b.length);
  while (suffix < maxSuffix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  let prefix = 0;
  const maxPrefix = Math.min(a.length, b.length) - suffix;
  while (prefix < maxPrefix && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  const prefixText = a.slice(0, prefix);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const suffixText = a.slice(a.length - suffix);

  const n = midA.length;
  const m = midB.length;
  const ops: DiffOp[] = [];
  if (n === 0 && m === 0) {
    // 只有公共前后缀
  } else if (n === 0) {
    ops.push([DIFF_INSERT, midB]);
  } else if (m === 0) {
    ops.push([DIFF_DELETE, midA]);
  } else if (myersInto(ops, midA, midB)) {
    // Myers 求解成功
  } else {
    // 编辑距离过大：整段替换
    ops.length = 0;
    ops.push([DIFF_DELETE, midA], [DIFF_INSERT, midB]);
  }

  const result: DiffOp[] = [];
  if (prefixText) result.push([DIFF_EQUAL, prefixText]);
  result.push(...ops);
  if (suffixText) result.push([DIFF_EQUAL, suffixText]);
  return result;
}

/** Myers 最短编辑距离求解；成功时把 diff 片段写入 out，距离超限时返回 false */
function myersInto(out: DiffOp[], a: string, b: string): boolean {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max > MAX_EDIT_DISTANCE * 2) return false;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  // 每个 d 轮次的 V 数组快照（回溯用）；正常并发编辑 d 很小，内存可控
  const trace: Int32Array[] = [];
  let foundD = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // 向下（插入）
      } else {
        x = v[offset + k - 1] + 1; // 向右（删除）
      }
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }
  if (foundD < 0) return false; // 超出距离上限

  // 回溯重建编辑路径
  const path: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    // 对角线上的公共字符（EQUAL）
    while (x > prevX && y > prevY) {
      prependEqual(path, a, x - 1);
      x--;
      y--;
    }
    if (prevK === k + 1) {
      path.unshift([DIFF_INSERT, b[y - 1]]);
      y--;
    } else {
      path.unshift([DIFF_DELETE, a[x - 1]]);
      x--;
    }
    // 前一 d 轮次对角推进（EQUAL）
    while (x > prevX && y > prevY) {
      prependEqual(path, a, x - 1);
      x--;
      y--;
    }
  }
  if (x > 0 && y > 0) {
    // d=0 轮次的公共前缀
    prependEqualRun(path, a, x);
    x = 0;
    y = 0;
  }
  out.push(...coalesce(path));
  return true;
}

function prependEqual(path: DiffOp[], a: string, index: number): void {
  if (path.length && path[0][0] === DIFF_EQUAL) {
    path[0][1] = a[index] + path[0][1];
  } else {
    path.unshift([DIFF_EQUAL, a[index]]);
  }
}

function prependEqualRun(path: DiffOp[], a: string, count: number): void {
  if (!count) return;
  if (path.length && path[0][0] === DIFF_EQUAL) {
    path[0][1] = a.slice(0, count) + path[0][1];
  } else {
    path.unshift([DIFF_EQUAL, a.slice(0, count)]);
  }
}

/** 合并相邻同操作片段，产出规范 diff 序列 */
function coalesce(path: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const [op, text] of path) {
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last[0] === op) last[1] += text;
    else out.push([op, text]);
  }
  return out;
}

/** 把 base→text 的字符 diff 归并为按 start 升序、互不重叠的变更区列表 */
function hunksOf(base: string, text: string): Hunk[] {
  const diffs = diffChars(base, text);
  const hunks: Hunk[] = [];
  let basePos = 0;
  let cur: Hunk | null = null;
  for (const [op, data] of diffs) {
    if (op === DIFF_EQUAL) {
      cur = null;
      basePos += data.length;
    } else if (op === DIFF_DELETE) {
      if (!cur) {
        cur = { start: basePos, end: basePos, text: '' };
        hunks.push(cur);
      }
      cur.end += data.length;
      basePos += data.length;
    } else if (op === DIFF_INSERT) {
      if (!cur) {
        cur = { start: basePos, end: basePos, text: '' };
        hunks.push(cur);
      }
      cur.text += data;
    }
  }
  return hunks;
}

export interface MergeResult {
  content: string;
  /** 冲突处 theirs 被舍弃的文本（调用方据此生成冲突备份） */
  conflicts: string[];
}

/**
 * 以 base 为共同祖先做字符级三方合并。
 * ours = 先到达方（hub 当前内容），theirs = 后到达方（节点推送内容）。
 */
export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const a = hunksOf(base, ours);
  const b = hunksOf(base, theirs);
  const conflicts: string[] = [];
  let out = '';
  let basePos = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const ha = i < a.length ? a[i] : null;
    const hb = j < b.length ? b[j] : null;
    if (ha && hb && interacts(ha, hb)) {
      const sameChange = ha.text === hb.text && ha.start === hb.start && ha.end === hb.end;
      if (sameChange) {
        out += base.slice(basePos, ha.start) + ha.text;
        basePos = Math.max(ha.end, hb.end);
        i++;
        j++;
        continue;
      }
      // 成对冲突区：并区整体按 ours（先到方）视图重建，theirs 文本全部记为冲突不丢
      const start = Math.min(ha.start, hb.start);
      let end = Math.max(ha.end, hb.end);
      const regionA: Hunk[] = [ha];
      const texts: string[] = [hb.text];
      let extraB = 1;
      for (;;) {
        let grew = false;
        while (i + regionA.length < a.length && a[i + regionA.length].start < end) {
          const h = a[i + regionA.length];
          regionA.push(h);
          if (h.end > end) {
            end = h.end;
            grew = true;
          }
        }
        while (j + extraB < b.length && b[j + extraB].start < end) {
          const h = b[j + extraB];
          texts.push(h.text);
          if (h.end > end) {
            end = h.end;
            grew = true;
          }
          extraB++;
        }
        if (!grew) break;
      }
      out += base.slice(basePos, start) + mapToOurs(ours, a, start, end);
      conflicts.push(...texts);
      basePos = end;
      i += regionA.length;
      j += extraB;
      continue;
    }
    if (ha && hb && ha.start === hb.start) {
      // 同起点的纯插入对（不构成冲突）：相同应用一次，不同按 ours→theirs 拼接都保留
      const samePoint = ha.end === hb.end && ha.text === hb.text;
      out += base.slice(basePos, ha.start) + (samePoint ? ha.text : ha.text + hb.text);
      basePos = Math.max(ha.end, hb.end);
      i++;
      j++;
      continue;
    }
    if (ha && (!hb || ha.start <= hb.start)) {
      out += base.slice(basePos, ha.start) + ha.text;
      basePos = ha.end;
      i++;
    } else {
      out += base.slice(basePos, hb!.start) + hb!.text;
      basePos = hb!.end;
      j++;
    }
  }
  out += base.slice(basePos);
  return { content: out, conflicts };
}

/** 把 base 区间 [start,end) 映射到 ours 坐标后切片：冲突区重建为 ours（先到方）视图 */
function mapToOurs(ours: string, a: Hunk[], start: number, end: number): string {
  const offsetAt = (p: number): number => {
    let off = 0;
    for (const h of a) {
      if (h.end <= p) {
        off += h.text.length - (h.end - h.start);
      } else if (h.start < p) {
        // 防御：p 落在变更区内部（构造上不应发生，区域增长已吞并跨界变更区）
        off += h.text.length - (h.end - h.start);
        break;
      } else {
        break;
      }
    }
    return p + off;
  };
  return ours.slice(offsetAt(start), offsetAt(end));
}

/** 两组变更区是否互相干涉：区间相交，或纯插入点落入对方实区间（含边界） */
function interacts(ha: Hunk, hb: Hunk): boolean {
  if (ha.start < hb.end && hb.start < ha.end) return true;
  const haPoint = ha.start === ha.end;
  const hbPoint = hb.start === hb.end;
  if (haPoint && !hbPoint && hb.start <= ha.start && ha.start <= hb.end) return true;
  if (hbPoint && !haPoint && ha.start <= hb.start && hb.start <= ha.end) return true;
  return false;
}
