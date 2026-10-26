/**
 * 推送兜底探针：解决「保存完成了，但侧栏/收集箱角标要等一会才变」。
 *
 * 主刷新通道仍是 SSE（毫秒级）。但推送在几种真实场景下会晚到或丢失：
 *  - 反向代理（NAS/Docker 网页版）缓冲了 SSE 响应，单条小事件被压住；
 *  - 桌面端长时间开着，连接虽显示「已连接」但实际已是半开/静默失效，EventSource 不会重连；
 *  - 电脑休眠唤醒、网络切换、多端同步落地的时间差。
 *
 * 这些情况下界面没有别的兜底，只能等下一次事件——用户看到的就是「存完了，侧栏过一会才有」。
 * 这里每 intervalMs 拿一次服务端的内容版本号（一个几十字节的 JSON），**版本变了才重读列表**：
 * 推送正常时开销只有这一个探针请求，推送失联时也能在一两个周期内自愈。
 * 逻辑抽成纯函数式（定时器可注入），不依赖 Vue，便于单测。
 */

export interface FreshnessProbeOptions {
  /** 读服务端内容版本号（失败应当 reject，探针静默跳过这一拍） */
  fetchRevision: () => Promise<number>;
  /** 版本号变化：重读侧栏目录与收集箱角标 */
  onChanged: () => void;
  /** 轮询间隔（毫秒），默认 3000 */
  intervalMs?: number;
  /** 页面是否在前台：后台不轮询（回前台时调用方会立即 check 一次） */
  isVisible?: () => boolean;
  /** 定时器注入（测试用）；返回的句柄交给 cancel */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export interface FreshnessProbe {
  /** 启动轮询（首拍只取基线，不触发刷新） */
  start: () => void;
  /** 停止轮询（组件卸载） */
  stop: () => void;
  /** 立即对一次账（回到前台、网络恢复、SSE 重连时调用） */
  check: () => Promise<void>;
  /** SSE 已收到带 rev 的事件：记下版本，避免兜底轮询再刷一遍 */
  noteRevision: (rev: unknown) => void;
}

export function createFreshnessProbe(options: FreshnessProbeOptions): FreshnessProbe {
  const intervalMs = Math.max(500, Math.round(options.intervalMs ?? 3000));
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const isVisible = options.isVisible ?? (() => true);

  let lastRevision: number | null = null;
  let timer: unknown = null;
  let stopped = true;
  let busy = false;

  async function check(): Promise<void> {
    if (stopped || busy) return;
    busy = true;
    try {
      const next = await options.fetchRevision();
      if (!Number.isFinite(next)) return;
      // 首拍只取基线（页面刚加载时各列表本来就各自读过一次）
      if (lastRevision !== null && next !== lastRevision) options.onChanged();
      lastRevision = next;
    } catch {
      /* 探针失败不算错误：旧服务端没有这个接口、或服务端正忙时，下一拍再试 */
    } finally {
      busy = false;
    }
  }

  function scheduleNext(): void {
    if (stopped || timer !== null) return;
    timer = schedule(() => {
      timer = null;
      void tick();
    }, intervalMs);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (isVisible()) await check();
    scheduleNext();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
    check,
    noteRevision(rev: unknown) {
      // 只往大记：SSE 事件可能比探针拍到的版本旧（在途顺序差），回退会让下一拍白刷一次
      if (typeof rev === 'number' && Number.isFinite(rev) && (lastRevision === null || rev > lastRevision)) {
        lastRevision = rev;
      }
    },
  };
}
