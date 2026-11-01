import { watch } from 'vue';
import { router } from '../router';
import { useAuthStore } from '../stores/auth';
import { useInboxStore } from '../stores/inbox';
import { createShareInboxDelivery } from './shareInboxDelivery';

declare global {
  interface Window { __engramShareInbox?: () => boolean }
}

export function installShareInboxReceiver(): () => void {
  const auth = useAuthStore();
  const inbox = useInboxStore();
  const delivery = createShareInboxDelivery({
    ready: () => auth.authed && router.currentRoute.value.path !== '/login',
    // capture 用时间戳而不是固定 1：已经在 /inbox 时再次分享也能触发落袋回执。
    open: async () => { await router.push({ path: '/inbox', query: { capture: String(Date.now()) } }); },
    refresh: () => inbox.load(),
  });
  window.__engramShareInbox = delivery.receive;
  // 登录页会先跳首页；等导航完成再消费分享通知，避免被首页跳转覆盖。
  const stopRoute = router.afterEach(() => { void delivery.flush(); });
  const stopAuth = watch(() => auth.authed, () => { void delivery.flush(); });
  return () => {
    stopRoute(); stopAuth();
    delete window.__engramShareInbox;
  };
}
