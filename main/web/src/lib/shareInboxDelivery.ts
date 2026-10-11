/** 原生通知可早于登录，也可在收集箱已经打开时再次到达。 */
export function createShareInboxDelivery(actions: {
  ready: () => boolean;
  open: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  let pending = false;
  let busy = false;
  async function flush(): Promise<void> {
    if (busy || !pending || !actions.ready()) return;
    busy = true;
    try {
      while (pending && actions.ready()) {
        pending = false;
        try {
          await actions.open();
          await actions.refresh();
        } catch {
          pending = true;
          break;
        }
      }
    } finally { busy = false; }
  }
  return {
    receive(): boolean { pending = true; void flush(); return true; },
    flush,
  };
}
