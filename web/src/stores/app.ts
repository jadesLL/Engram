import { defineStore } from 'pinia';
import { api } from '../api';

type Theme = 'light' | 'dark' | 'system';
type SidebarStyle = 'a' | 'b' | 'c';

export const useAppStore = defineStore('app', {
  state: () => ({
    sidebarOpen: window.innerWidth > 768,
    aiDrawerOpen: false,
    theme: (localStorage.getItem('theme') as Theme) || 'light',
    sidebarStyle: (localStorage.getItem('sidebarStyle') as SidebarStyle) || 'c',
    /** 编辑页阅读窄栏模式（true=阅读窄栏，false=宽幅画布）。默认宽幅。 */
    editorRead: localStorage.getItem('editorRead') === '1',
    openReportCount: 0,
    /** 侧栏数据版本号：页面增删改/移动后自增，侧栏监听并刷新 */
    sidebarVersion: 0,
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
    setSidebarStyle(s: SidebarStyle) {
      this.sidebarStyle = s;
      localStorage.setItem('sidebarStyle', s);
    },
    toggleEditorRead() {
      this.editorRead = !this.editorRead;
      localStorage.setItem('editorRead', this.editorRead ? '1' : '0');
    },
    toggleAi() {
      this.aiDrawerOpen = !this.aiDrawerOpen;
    },
    bumpSidebar() {
      this.sidebarVersion++;
    },
    /** 拉取一次任务队列；失败保留上次状态（自适应轮询会很快重试） */
    async refreshJobs() {
      try {
        const { data } = await api.get('/api/jobs');
        this.jobs = data;
      } catch { /* 保留上次状态 */ }
    },
    /** 按文件路径找其 ingest 任务（侧栏文件行进度用） */
    fileJob(path: string) {
      return this.jobs.active.find((j: any) => j.kind === 'ingest' && j.payload?.path === path);
    },
  },
});
