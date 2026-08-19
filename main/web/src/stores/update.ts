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
  checkedAt: number;
  dismissedVersion: string;
}

const DISMISS_KEY = 'updateDismissedVersion';

export const useUpdateStore = defineStore('update', {
  state: (): UpdateState => ({
    lastResult: null,
    checking: false,
    checkedAt: 0,
    dismissedVersion: localStorage.getItem(DISMISS_KEY) || '',
  }),
  getters: {
    /** 有新版本且未被用户忽略 → 侧栏设置按钮显示红点 */
    hasNewVersion(state): boolean {
      return Boolean(
        state.lastResult &&
        state.lastResult.hasUpdate &&
        state.lastResult.latestVersion &&
        state.lastResult.latestVersion !== state.dismissedVersion,
      );
    },
    /** 当前版本（检测过用服务端返回的，否则用编译期常量） */
    displayVersion(state): string {
      return state.lastResult?.currentVersion || APP_VERSION;
    },
  },
  actions: {
    async check(force = false) {
      if (this.checking) return;
      // 8 小时内不重复自动检测；force 用于设置页手动触发
      if (!force && Date.now() - this.checkedAt < 8 * 3600_000 && this.lastResult) return;
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
