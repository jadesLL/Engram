import { defineStore } from 'pinia';
import { api } from '../api';

type Theme = 'light' | 'dark' | 'system';

// 旧版 A/B/C 侧栏方案已收敛为统一样式，清理遗留偏好。
localStorage.removeItem('sidebarStyle');

export const useAppStore = defineStore('app', {
  state: () => ({
    sidebarOpen: window.innerWidth > 768,
    aiDrawerOpen: false,
    theme: (localStorage.getItem('theme') as Theme) || 'light',
    /** 当前编辑模式（ir/sv），切换页面时保持不重置 */
    editorMode: (localStorage.getItem('editorMode') as 'ir' | 'sv') || 'ir',
    /** 是否处于 HTML 预览模式，切换页面时保持 */
    htmlPreview: localStorage.getItem('htmlPreview') === '1',
    openReportCount: 0,
    /** 侧栏数据版本号：页面增删改/移动后自增，侧栏监听并刷新 */
    sidebarVersion: 0,
    /** 页面内容版本号：服务端 SSE 推送页面变更后自增，EditorView 监听并重载当前页 */
    pageVersion: 0,
    /** 最近一次页面事件（page-changed/deleted/moved），EditorView 据此判断是否重载当前页 */
    lastPageEvent: null as any,
    /** AI 任务队列：单一数据源（Home 角标 / JobsPanel / Sidebar 进度共用） */
    jobs: { active: [] as any[], recent: [] as any[], pending: 0, running: 0, failed: 0 },
  }),
  getters: {
    /** 角标数 = 待执行 + 执行中 */
    activeJobCount: (state) => state.jobs.pending + state.jobs.running,
  },
  actions: {
    applyTheme() {
      const dark =
        this.theme === 'dark' ||
        (this.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
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
    toggleHtmlPreview(force?: boolean) {
      this.htmlPreview = force !== undefined ? force : !this.htmlPreview;
      localStorage.setItem('htmlPreview', this.htmlPreview ? '1' : '0');
    },
    toggleAi() {
      this.aiDrawerOpen = !this.aiDrawerOpen;
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
