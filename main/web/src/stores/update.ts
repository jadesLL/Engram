import { defineStore } from 'pinia';
import { api } from '../api';
import { APP_VERSION } from '../version';

/**
 * 软件更新检测（Docker 服务器版 + Windows 桌面版共用信号源 Gitea Releases）。
 * Home 挂载时自动检测一次，结果驱动侧栏设置按钮红点与设置页提醒；
 * 手动检测由 UpdatePanel 触发同一 action。
 */

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  releaseTag: string;
  releaseNotes: string;
  imageTag?: string;
  hasUpdate: boolean;
  digestMatch: boolean | null;
  registryChecked: boolean;
  exeAsset: { name: string; url: string; size: number } | null;
  error?: string;
  warning?: string;
}

interface UpdateState {
  /** null=未检测，undefined=检测失败 */
  lastResult: UpdateCheckResult | null | undefined;
  checking: boolean;
  /** 最近一次「成功」检测完成的时间（提示条上显示「已自动检查 · X 分钟前」） */
  checkedAt: number;
  /** 最近一次发起检测的时间（含失败），仅用于 30 秒入口去抖 */
  lastAttemptAt: number;
  dismissedVersion: string;
}

const DISMISS_KEY = 'updateDismissedVersion';

export const useUpdateStore = defineStore('update', {
  state: (): UpdateState => ({
    lastResult: null,
    checking: false,
    checkedAt: 0,
    lastAttemptAt: 0,
    dismissedVersion: localStorage.getItem(DISMISS_KEY) || '',
  }),
  getters: {
    /** 有新版本且未被用户忽略 → 侧栏设置按钮显示红点（digest-only 更新无版本号时也提示） */
    hasNewVersion(state): boolean {
      const r = state.lastResult;
      if (!r || !r.hasUpdate) return false;
      if (!r.latestVersion) return true;
      return r.latestVersion !== state.dismissedVersion;
    },
    /** 当前版本（检测过用服务端返回的，否则用编译期常量） */
    displayVersion(state): string {
      return state.lastResult?.currentVersion || APP_VERSION;
    },
  },
  actions: {
    async check(force = false) {
      if (this.checking) return;
      // 30 秒入口去抖：真正的检查节奏由调用方（Home 的自适应退避调度）决定，
      // 这里只兜住「切前台 + 聚焦 + visibilitychange 同时触发」造成的重复请求。
      if (!force && Date.now() - this.lastAttemptAt < 30_000) return;
      this.lastAttemptAt = Date.now();
      this.checking = true;
      try {
        const { data } = await api.post('/api/update/check', {});
        this.lastResult = data;
        this.checkedAt = Date.now();
      } catch {
        if (this.lastResult === null) this.lastResult = undefined;
      } finally {
        this.checking = false;
      }
    },
    dismiss() {
      if (this.lastResult?.latestVersion) {
        this.dismissedVersion = this.lastResult.latestVersion;
        localStorage.setItem(DISMISS_KEY, this.dismissedVersion);
      }
    },
  },
});
