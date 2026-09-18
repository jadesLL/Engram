import { defineStore } from 'pinia';
import { api } from '../api';
import {
  clampReadingFontSize,
  parseReadingPreferences,
  type ReadingPreferences,
} from '../lib/readingPreview';

type Theme = 'light' | 'dark' | 'system';

/** 内置 Agent 聊天抽屉的形态：dock=右侧并排，full=满窗铺满内容区 */
export type ChatDrawerMode = 'dock' | 'full';

function resolveDarkTheme(theme: Theme): boolean {
  return theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// 旧版 A/B/C 侧栏方案已收敛为统一样式，清理遗留偏好。
localStorage.removeItem('sidebarStyle');
const legacyHtmlPreview = localStorage.getItem('htmlPreview') === '1';
const initialReadingMode = localStorage.getItem('readingMode') === '1' || legacyHtmlPreview;
if (legacyHtmlPreview) localStorage.setItem('readingMode', '1');
localStorage.removeItem('htmlPreview');
localStorage.removeItem('aiDrawerWidth');

export const useAppStore = defineStore('app', {
  state: () => {
    const theme = (localStorage.getItem('theme') as Theme) || 'light';
    return {
      // ≤1024px（手机/折叠屏外屏/紧凑档）侧栏为浮层，默认收起
      sidebarOpen: window.innerWidth > 1024,
      theme,
      dark: resolveDarkTheme(theme),
      /** 当前编辑模式（ir/sv），切换页面时保持不重置 */
      editorMode: (localStorage.getItem('editorMode') as 'ir' | 'sv') || 'ir',
      /** 沉浸阅读状态与偏好，切换页面时保持 */
      readingMode: initialReadingMode,
      readingPreferences: parseReadingPreferences(localStorage.getItem('readingPreferences')),
      /** 侧栏数据版本号：页面增删改/移动后自增，侧栏监听并刷新 */
      sidebarVersion: 0,
      /** 页面内容版本号：服务端 SSE 推送页面变更后自增，EditorView 监听并重载当前页 */
      pageVersion: 0,
      /** 最近一次页面事件（page-changed/deleted/moved），EditorView 据此判断是否重载当前页 */
      lastPageEvent: null as any,
      /** 后台处理状态：仅用于把文档提取进度显示在对应文件旁 */
      jobs: {
        active: [] as any[],
        recent: [] as any[],
        pending: 0,
        running: 0,
        paused: 0,
        failed: 0,
        queueRunning: true,
      },
      /** 内置 Agent 聊天抽屉：开合、形态与未读提示 */
      chatDrawerOpen: false,
      /** 上次使用的抽屉形态（dock 右侧并排 / full 满窗），刷新与重开都沿用 */
      chatDrawerMode: (localStorage.getItem('chatDrawerMode') === 'full' ? 'full' : 'dock') as ChatDrawerMode,
      chatDrawerWidth: Number(localStorage.getItem('chatDrawerWidth')) || 420,
      chatUnread: false,
    };
  },
  actions: {
    applyTheme() {
      this.dark = resolveDarkTheme(this.theme);
      document.documentElement.classList.toggle('dark', this.dark);
      localStorage.setItem('theme', this.theme);
      // 桌面端：窗口控制按钮（标题栏融合条 WCO）配色跟随主题，取值直接来自 CSS 变量
      const wd = (window as any).wikiDesktop;
      if (wd?.setTitleBarOverlay) {
        const cs = getComputedStyle(document.documentElement);
        wd.setTitleBarOverlay({
          color: cs.getPropertyValue('--bg').trim(),
          symbolColor: cs.getPropertyValue('--text').trim(),
        });
      }
    },
    setTheme(t: Theme) {
      this.theme = t;
      this.applyTheme();
    },
    setEditorMode(mode: 'ir' | 'sv') {
      this.editorMode = mode;
      localStorage.setItem('editorMode', mode);
    },
    setReadingMode(on: boolean) {
      this.readingMode = on;
      localStorage.setItem('readingMode', on ? '1' : '0');
    },
    updateReadingPreferences(value: Partial<ReadingPreferences>) {
      const next = { ...this.readingPreferences, ...value };
      // 字号连续可调，仅收敛到安全区间（非法值回落默认）
      next.fontSize = clampReadingFontSize(value.fontSize ?? this.readingPreferences.fontSize);
      this.readingPreferences = next;
      localStorage.setItem('readingPreferences', JSON.stringify(this.readingPreferences));
    },
    toggleResolvedTheme() {
      this.setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
    },
    bumpSidebar() {
      this.sidebarVersion++;
    },
    /** 开合聊天抽屉：打开即清未读 */
    toggleChat(open?: boolean) {
      this.chatDrawerOpen = open ?? !this.chatDrawerOpen;
      if (this.chatDrawerOpen) this.chatUnread = false;
    },
    setChatDrawerWidth(width: number) {
      this.chatDrawerWidth = Math.min(720, Math.max(320, Math.round(width)));
      localStorage.setItem('chatDrawerWidth', String(this.chatDrawerWidth));
    },
    /** 切换抽屉形态：写入偏好，下次打开（含 rail ✨ 入口）沿用 */
    setChatDrawerMode(mode: ChatDrawerMode) {
      this.chatDrawerMode = mode;
      localStorage.setItem('chatDrawerMode', mode);
    },
    toggleChatDrawerMode() {
      this.setChatDrawerMode(this.chatDrawerMode === 'full' ? 'dock' : 'full');
    },
    /** 应用服务端推送的页面事件：记录事件 + 自增版本号 + 刷新侧栏 */
    applyPageEvent(ev: any) {
      this.lastPageEvent = ev;
      this.pageVersion++;
      this.bumpSidebar();
    },
    /** 拉取后台处理状态；失败时保留上次状态，供文件行继续显示提取进度 */
    async refreshJobs() {
      try {
        const { data } = await api.get('/api/jobs');
        this.jobs = data;
      } catch { /* 保留上次状态 */ }
    },
    /** 按文件路径找其提取任务（侧栏与文件预览进度共用） */
    fileJob(path: string) {
      return this.jobs.active.find((j: any) =>
        j.kind === 'extract_file' && j.payload?.path === path
      );
    },
  },
});
