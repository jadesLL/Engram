/**
 * 请求序号：并发请求里只认最新一次。
 *
 * 用法：发请求前 `const seq = seq.next()`；响应回来用 `seq.isCurrent(seq)` 判断是否
 * 已被更新的请求取代（是就丢弃这次结果）；离开页面/关闭浮层而没有新请求时用 `bump()`
 * 作废在途结果。纯状态机，便于单测（GraphView 图谱、SearchView 搜索、Sidebar 列表共用）。
 */
export function createRequestSeq() {
  let current = 0;
  return {
    /** 开始一次新请求：返回本次序号（并作废此前所有在途请求的结果） */
    next(): number {
      return ++current;
    },
    /** 这次响应还是最新的吗 */
    isCurrent(seq: number): boolean {
      return seq === current;
    },
    /** 没有新请求，只作废在途结果（如离开页面、关闭浮层） */
    bump(): void {
      current += 1;
    },
  };
}
