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
      this.readingPreferences = { ...this.readingPreferences, ...value };
      localStorage.setItem('readingPreferences', JSON.stringify(this.readingPreferences));
    },
    toggleResolvedTheme() {
      this.setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
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
    /** 按文件路径找其提取任务（侧栏与文件预览进度共用） */
    fileJob(path: string) {
      return this.jobs.active.find((j: any) =>
        j.kind === 'extract_file' && j.payload?.path === path
      );
    },
  },
});
