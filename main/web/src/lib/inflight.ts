/**
 * 在途门闩：同一把键一次只放一个动作进去，在途期间的重复触发（双击、回车连发）直接忽略。
 *
 * 返回的 `busy` 是 ref（任一键在途即为真），可直接绑到按钮的 disabled；`run` 返回 false
 * 表示这次被挡住。与「按钮 disabled」是两道互补的闸：disabled 是给用户看的，run 里的
 * 判断是防事件在状态更新前就重复入队（同一 tick 连点两下时 disabled 还没生效）。
 */
import { ref } from 'vue';

export function createInflightGuard() {
  const inflight = new Set<string>();
  const busy = ref(false);
  const sync = () => { busy.value = inflight.size > 0; };
  return {
    busy,
    /** 某个键当前是否在途 */
    isBusy(key = ''): boolean {
      return inflight.has(key);
    },
    /** 在 key 上执行 action；该键已有在途动作时返回 false 且不执行 */
    async run(key: string, action: () => Promise<void> | void): Promise<boolean> {
      if (inflight.has(key)) return false;
      inflight.add(key);
      sync();
      try {
        await action();
        return true;
      } finally {
        inflight.delete(key);
        sync();
      }
    },
  };
}
