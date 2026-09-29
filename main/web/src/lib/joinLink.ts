/**
 * 邀请链接直达（安卓壳层 → 网页）。
 *
 * 别人把邀请链接发到手机，点一下就该打开 Engram 并填好「中枢地址 + 绑定令牌」。链路是：
 *  - AndroidManifest 为 MainActivity 注册 `engram://join` 的 VIEW intent-filter；
 *  - MainActivity 拿到链接后调用本模块装在 `window.__engramJoinLink` 上的函数（见 mobile 的 joinLink 处理）；
 *  - 本模块把链接存进 `pendingJoinLink` 并跳到 设置 → 多端同步；
 *  - SyncPanel 挂载（或被唤醒）时取走它，解析并回填表单。
 *
 * 两个约定：
 *  ① 函数返回 `true` 表示「已接收」——原生侧据此停止重试投递（页面可能还在启动中）；
 *  ② 链接只用不存：取走即清空。没登录时路由守卫会把用户挡在登录页，链接留在 pending 里，
 *     等他进到 设置 → 多端同步 再消费，不会凭空丢。
 */
import { ref } from 'vue';
import { router } from '../router';

/** 已收到但还没被表单消费的邀请链接（原始文本，解析交给 lib/syncInvite） */
export const pendingJoinLink = ref('');

declare global {
  interface Window {
    __engramJoinLink?: (raw: string) => boolean;
  }
}

/** 取走待处理的链接（取走即清空） */
export function takePendingJoinLink(): string {
  const value = pendingJoinLink.value;
  pendingJoinLink.value = '';
  return value;
}

let installed = false;

/** 应用启动时安装一次（App.vue 的 onMounted）。桌面端/网页端没有原生调用，装了也不会触发 */
export function installJoinLinkReceiver(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.__engramJoinLink = (raw: string) => {
    const text = String(raw || '').trim();
    if (!text) return true;
    pendingJoinLink.value = text;
    // 跳到同步设置页；未登录时守卫会改道登录页，链接留在 pending 里等用户自己过去
    void router.push({ path: '/settings', query: { section: 'sync' } }).catch(() => {});
    return true;
  };
}
