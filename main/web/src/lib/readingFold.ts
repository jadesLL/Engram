/**
 * 沉浸阅读「按标题收放」的范围计算（纯函数，便于单测）。
 *
 * 正文是一串平铺的块（标题 / 段落 / 列表 / 代码块…）。某个标题收放的范围是：
 * 它之后、直到**下一个同级或更高级标题**之前的全部块——因此 H2 收放会连带
 * 其下的 H3/H4 及各自正文，H3 收放只影响自己那一节。
 */

export type HeadingBlock = {
  /** 标题层级（2 = H2、3 = H3、4 = H4） */
  level: number;
  /** 该标题在正文块序列里的下标 */
  block: number;
};

export type FoldRange = {
  level: number;
  /** 标题所在块下标 */
  block: number;
  /** 收放范围结束位置（不含），即从 block + 1 到 end - 1 的块随该标题一起收放 */
  end: number;
};

export function headingFoldRanges(headings: HeadingBlock[], blockCount: number): FoldRange[] {
  return headings.map((heading, index) => {
    let end = blockCount;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next].level <= heading.level) {
        end = headings[next].block;
        break;
      }
    }
    return { level: heading.level, block: heading.block, end };
  });
}

/** 收放范围覆盖的块数量（不含标题本身），用于 UI 提示与测试断言 */
export function foldRangeSize(range: FoldRange): number {
  return Math.max(0, range.end - range.block - 1);
}
