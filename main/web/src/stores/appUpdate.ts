import { defineStore } from 'pinia';
import { api } from '../api';
import { emptyAppUpdateInfo, normalizeAppUpdateInfo, type AppUpdateInfo } from '../lib/appUpdate';

/**
 * 安卓端应用内更新（OTA）状态源：设置页「安卓端更新」分组与右上角绿色更新图标共用。
 *
 * 与桌面/服务端形态的区别：检查与下载都在 App 内的 Kotlin 本地服务里跑（见 AppUpdater.kt），
 * 这里只负责「触发 + 轮询状态」——一次下载几十 MB，不能让请求挂在那儿等；
 * 安装那一步调起系统安装器（侧载必须用户点一次确认），完成后应用会被系统替换重启。
 *
 * 轮询只在 checking/downloading 期间开着（1.2 秒一次），到 idle/ready/error 立刻停表。
 */

const POLL_INTERVAL_MS = 1_200;
/** 手动检查的去抖：切前台 + 可见性变化 + 退避调度可能同时触发 */
const CHECK_DEBOUNCE_MS = 30_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useAppUpdateStore = defineStore('appUpdate', {
  state: () => ({
    info: emptyAppUpdateInfo(),
    /** 是否已经从本地服务读到过状态（没读到前不显示「已是最新」这类结论） */
    loaded: false,
    lastAttemptAt: 0,
  }),
  getters: {
    hasUpdate(state): boolean {
      return Boolean(state.info.hasUpdate);
    },
    running(state): boolean {
      return state.info.phase === 'checking' || state.info.phase === 'downloading';
    },
    /** 有可装的新版本（下载完成）——绿色图标与设置页徽标都按它提示 */
    installPending(state): boolean {
      return state.info.ready;
    },
  },
  actions: {
    /** 把状态写进 store，并按当前 phase 决定要不要继续轮询 */
    apply(raw: any) {
      this.info = normalizeAppUpdateInfo(raw);
      if (this.running) this.schedulePoll();
      else this.stopPoll();
    },
    schedulePoll() {
      if (pollTimer) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void this.refresh();
      }, POLL_INTERVAL_MS);
    },
    stopPoll() {
      if (!pollTimer) return;
      clearTimeout(pollTimer);
      pollTimer = null;
    },
    async refresh() {
      try {
        const { data } = await api.get('/api/app-update/state');
        this.apply(data);
        this.loaded = true;
      } catch {
        // 能力位为假（桌面/服务端）或本地服务繁忙：保持上一次状态，不打扰用户
      }
    },
    /** 检查更新：与桌面端同一套 30 秒去抖（退避节奏由 Home.vue 的调度决定） */
    async check(force = false) {
      if (!force && Date.now() - this.lastAttemptAt < CHECK_DEBOUNCE_MS) return;
      this.lastAttemptAt = Date.now();
      try {
        const { data } = await api.post('/api/app-update/check', {});
        this.apply(data);
      } catch {
        // 检查失败不改状态：真正的失败原因由本地服务写在 state.error 里（下一次轮询可见）
      }
    },
    async download() {
      try {
        const { data } = await api.post('/api/app-update/download', {});
        this.apply(data);
      } catch {
        await this.refresh();
      }
    },
    /**
     * 调起系统安装器；失败时返回原因（包没下完 / 不在前台 / 调试包）给界面显示。
     * 「安装未知应用」没授权不算失败：本地服务会自动拉起系统授权页并回
     * `needPermission`，界面按提示语气说明「允许后返回会自动继续安装」。
     */
    async install(): Promise<{ ok: boolean; error?: string; needPermission?: boolean }> {
      try {
        const { data } = await api.post('/api/app-update/install', {});
        await this.refresh();
        if (data?.needPermission) {
          return { ok: false, needPermission: true, error: data.message || '已打开系统的「安装未知应用」授权页，允许后返回会自动继续安装' };
        }
        return { ok: true };
      } catch (e: any) {
        const error = e?.response?.data?.error || e?.message || '无法调起系统安装器';
        await this.refresh();
        return { ok: false, error };
      }
    },
    /**
     * 保存更新源：
     *  - `giteaUrl` / `giteaRepo`：本机手填（优先于中枢下发的）；
     *  - `useHub: true`：清掉本机手填，改回跟随多端同步中枢下发的那一份；
     *  - `authType`：私有库凭据方式（`token` / `password`）；换方式时服务端只保留当前方式的凭据；
     *  - `username`：用户名密码方式的用户名（非秘密）；
     *  - `token` / `password`：凭据（空串即清除；留空不传 = 不修改）；
     *  - `autoUpdate`：自动检查 + 后台下载开关。
     */
    async saveConfig(patch: {
      giteaUrl?: string;
      giteaRepo?: string;
      authType?: string;
      username?: string;
      token?: string;
      password?: string;
      autoUpdate?: boolean;
      useHub?: boolean;
    }) {
      try {
        const { data } = await api.put('/api/app-update/config', patch);
        this.apply(data);
        return { ok: true as const };
      } catch (e: any) {
        return { ok: false as const, error: e?.response?.data?.error || e?.message || '保存失败' };
      }
    },
    /** 跳系统「安装未知应用」授权页 */
    async openInstallSettings() {
      try {
        await api.post('/api/app-update/install-permission', {});
      } catch {
        // 应用不在前台时宿主不可用：刷新状态会给出「请回到 Engram 应用内」的提示
        await this.refresh();
      }
    },
    /** 申请通知权限（Android 13+），返回当前是否已授权 */
    async requestNotifications(): Promise<boolean> {
      try {
        const { data } = await api.post('/api/app-update/notifications', {});
        await this.refresh();
        return Boolean(data?.notificationsEnabled);
      } catch {
        return false;
      }
    },
    /**
     * 等一次动作跑完（更新提示条点「立即下载并安装」后要用）：
     * 每秒看一次状态，直到不再 checking/downloading，或超时。
     */
    async waitForSettle(timeoutMs: number, onTick?: (info: AppUpdateInfo) => void): Promise<AppUpdateInfo> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        await this.refresh();
        onTick?.(this.info);
        if (!this.running) return this.info;
        if (Date.now() >= deadline) return this.info;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
  },
});
