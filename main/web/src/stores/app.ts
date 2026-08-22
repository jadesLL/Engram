import { defineStore } from 'pinia';
import { api } from '../api';
import {
  parseReadingPreferences,
  type ReadingPreferences,
} from '../lib/readingPreview';

type Theme = 'light' | 'dark' | 'system';

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

/** AI 抽屉宽度：默认 0 表示未自定义（用 CSS 默认 clamp），拖拽后记住像素宽度；超过视口 70% 时覆盖正文区 */
const AI_DRAWER_MAX_RATIO = 0.7;
const storedAiDrawerWidth = Number(localStorage.getItem('aiDrawerWidth'));
const initialAiDrawerWidth = Number.isFinite(storedAiDrawerWidth) && storedAiDrawerWidth > 0
  ? storedAiDrawerWidth
  : 0;

export const useAppStore = defineStore('app', {
  state: () => {
    const theme = (localStorage.getItem('theme') as Theme) || 'light';
    return {
      sidebarOpen: window.innerWidth > 768,
      aiDrawerOpen: false,
      /** AI 抽屉宽度（px），0 = 未自定义 */
      aiDrawerWidth: initialAiDrawerWidth,
      /** AI 抽屉处于折叠状态期间收到新回复，左侧栏 AI 图标显示未读提示 */
      aiUnread: false,
      theme,
      dark: resolveDarkTheme(theme),
      /** 当前编辑模式（ir/sv），切换页面时保持不重置 */
      editorMode: (localStorage.getItem('editorMode') as 'ir' | 'sv') || 'ir',
      /** 沉浸阅读状态与偏好，切换页面时保持 */
      readingMode: initialReadingMode,
      readingPreferences: parseReadingPreferences(localStorage.getItem('readingPreferences')),
      openReportCount: 0,
      /** 侧栏数据版本号：页面增删改/移动后自增，侧栏监听并刷新 */
      sidebarVersion: 0,
      /** 页面内容版本号：服务端 SSE 推送页面变更后自增，EditorView 监听并重载当前页 */
      pageVersion: 0,
      /** 最近一次页面事件（page-changed/deleted/moved），EditorView 据此判断是否重载当前页 */
      lastPageEvent: null as any,
      /** AI 任务队列：单一数据源（Home 角标 / JobsPanel / Sidebar 进度共用） */
      jobs: {
        active: [] as any[],
        recent: [] as any[],
        pending: 0,
        running: 0,
        paused: 0,
        failed: 0,
        queueRunning: true,
      },
    };
  },
  getters: {
    /** 角标数 = 待执行 + 执行中 */
    activeJobCount: (state) => state.jobs.pending + state.jobs.running + state.jobs.paused,
  },
  actions: {
    applyTheme() {
      this.dark = resolveDarkTheme(this.theme);
      document.documentElement.classList.toggle('dark', this.dark);
      localStorage.setItem('theme', this.theme);
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
      this.readingPreferences = { ...this.readingPreferences, ...value };
      localStorage.setItem('readingPreferences', JSON.stringify(this.readingPreferences));
    },
    toggleResolvedTheme() {
      this.setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
    },
    toggleAi() {
      this.aiDrawerOpen = !this.aiDrawerOpen;
      if (this.aiDrawerOpen) this.aiUnread = false;
    },
    setAiDrawerWidth(width: number) {
      this.aiDrawerWidth = width;
      if (width > 0) localStorage.setItem('aiDrawerWidth', String(width));
      else localStorage.removeItem('aiDrawerWidth');
    },
    /** 抽屉宽度是否覆盖正文区（超过视口 70% 时全屏覆盖，只留左侧栏） */
    aiDrawerOverlay(): boolean {
      if (this.aiDrawerWidth <= 0) return false;
      return this.aiDrawerWidth > window.innerWidth * AI_DRAWER_MAX_RATIO;
    },
    bumpSidebar() {
      this.sidebarVersion++;
    },
    /** 应用服务端推送的页面事件：记录事件 + 自增版本号 + 刷新侧栏 */
    applyPageEvent(ev: any) {
      this.lastPageEvent = ev;
      this.pageVersion++;
      this.bumpSidebar();
    },
    /** 拉取一次任务队列；失败保留上次状态（自适应轮询会很快重试） */
    async refreshJobs() {
      try {
        const { data } = await api.get('/api/jobs');
        this.jobs = data;
      } catch { /* 保留上次状态 */ }
    },
    /** 按文件路径找其提取/整理任务（侧栏与文件预览进度共用） */
    fileJob(path: string) {
      return this.jobs.active.find((j: any) =>
        ['extract_file', 'ingest'].includes(j.kind) && j.payload?.path === path
      );
    },
  },
});
