/** 初始化/隐藏期间只保留最新正文，恢复后补同步；页面 ID 变化也必须刷新编辑器历史。 */
export function createEditorModelSync(apply: (value: string, pageChanged: boolean) => void) {
  let latest: { pageId: string; value: string } | null = null;
  let appliedPageId: string | null = null;
  let ready = false;
  let visible = false;
  let pending = false;
  function flush() {
    if (!ready || !visible || !pending || !latest) return;
    apply(latest.value, latest.pageId !== appliedPageId);
    appliedPageId = latest.pageId;
    pending = false;
  }
  return {
    update(pageId: string, value: string) {
      latest = { pageId, value };
      pending = true;
      flush();
    },
    setEnvironment(nextReady: boolean, nextVisible: boolean) {
      ready = nextReady;
      visible = nextVisible;
      flush();
    },
    isCurrent() { return ready && !pending; },
  };
}
