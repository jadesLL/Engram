import { defineStore } from 'pinia';
import { api } from '../api';
import {
  clampReadingFontSize,
  parseReadingPreferences,
  type ReadingPreferences,
} from '../lib/readingPreview';
import { clampContentWidthRatio } from '../lib/contentWidth';
import { defaultDrawerWidth } from '../lib/chatDrawer';
import {
  pushTrail,
  settleTrail,
  takeTrailBack,
  takeTrailBackTo,
  type PageTrailEntry,
  type PageTrailSource,
} from '../lib/pageTrail';

type Theme = 'light' | 'dark' | 'system';

/** 内置 Agent 聊天抽屉的形态：dock=右侧悬浮卡片，full=满窗铺满内容区 */
export type ChatDrawerMode = 'dock' | 'full';

function resolveDarkTheme(theme: Theme): boolean {
  return theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// 旧版 A/B/C 侧栏方案已收敛为统一样式，清理遗留偏好。
localStorage.removeItem('sidebarStyle');
// 沉浸阅读改为默认阅读方式：不再记忆上次开关，每次启动都直接进阅读视图，
// 需要编辑时用「返回编辑」临时切回（会话内保持）。旧的 htmlPreview 迁移偏好一并清理。
localStorage.removeItem('readingMode');
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
      /** 沉浸阅读状态：默认开启，会话内切换页面保持（不写本地偏好） */
      readingMode: true,
      readingPreferences: parseReadingPreferences(localStorage.getItem('readingPreferences')),
      /** 双链/关联跳转的页面轨迹：压入来源页 id + 标题，「返回上一页」逐级回退或下拉直选 */
      pageTrail: [] as PageTrailEntry[],
      /** 最近一次轨迹跳转的目标页 id：路由落到其它页面即视为离开轨迹并清空 */
      pageTrailTarget: null as string | null,
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
      /** 上次使用的抽屉形态（dock 右侧悬浮卡片 / full 满窗），刷新与重开都沿用 */
      chatDrawerMode: (localStorage.getItem('chatDrawerMode') === 'full' ? 'full' : 'dock') as ChatDrawerMode,
      chatDrawerWidth: Number(localStorage.getItem('chatDrawerWidth')) || 420,
      /**
       * 悬浮档当前生效宽度：首页据此给正文右侧留出等宽空间。
       * 抽屉挂载/窗口变化/拖动时把算好的宽度同步过来，两处不会各算一套。
       */
      chatDockWidth: defaultDrawerWidth(window.innerWidth),
      /** 是否正在拖卡片宽度：拖动中正文让位不做过渡，否则会落后卡片半拍 */
      chatDragging: false,
      chatUnread: false,
      /**
       * 最近一次「满窗下导航导致 Agent 最小化」的时刻：右下角状态胶囊据此提示 4 秒，
       * 让用户知道抽屉为什么不见了、点哪儿能回来（0 表示没有待提示的最小化）。
       */
      chatMinimizedAt: 0,
      /** 聚焦输入框的请求计数：抽屉已开着时也能把光标送到输入框（自增即触发一次） */
      chatComposerFocus: 0,
      /**
       * 侧栏是否显示「AI 工作区」（服务端自动生成的操作日志/索引/关系库）。
       * 默认隐藏：用户日常不需要看这些内容，在 设置 → 账户与外观 → 外观 里打开，
       * 开关存服务端设置（show_ai_workspace），多端一致。
       */
      showAiWorkspace: false,
    };
  },
  actions: {
    applyTheme() {
      this.dark = resolveDarkTheme(this.theme);
      document.documentElement.classList.toggle('dark', this.dark);
      localStorage.setItem('theme', this.theme);
      // 标签页图标跟随主题：亮色/暗色两份静态 SVG 由生成器产出，这里只切换引用
      const favicon = document.getElementById('app-favicon') as HTMLLinkElement | null;
      if (favicon) {
        const href = `/brand/icon-${this.dark ? 'dark' : 'light'}.svg`;
        if (favicon.getAttribute('href') !== href) favicon.setAttribute('href', href);
      }
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
    /** 读一次界面偏好（服务端设置 show_ai_workspace：'1' 才显示 AI 工作区） */
    async loadUiPreferences() {
      try {
        const { data } = await api.get('/api/settings');
        this.showAiWorkspace = data?.settings?.show_ai_workspace === '1';
      } catch {
        /* 未登录或旧服务端：保持默认隐藏 */
      }
    },
    /** 切换「AI 工作区」显示：先本地生效再写服务端，失败回滚（界面与设置项不会各说各话） */
    async setShowAiWorkspace(on: boolean) {
      const before = this.showAiWorkspace;
      this.showAiWorkspace = on;
      try {
        await api.put('/api/settings', { show_ai_workspace: on ? '1' : '0' });
      } catch (error) {
        this.showAiWorkspace = before;
        throw error;
      }
    },
    setReadingMode(on: boolean) {
      this.readingMode = on;
    },
    updateReadingPreferences(value: Partial<ReadingPreferences>) {
      const next = { ...this.readingPreferences, ...value };
      // 字号连续可调，仅收敛到安全区间（非法值回落默认）
      next.fontSize = clampReadingFontSize(value.fontSize ?? this.readingPreferences.fontSize);
      // 正文列宽：占可用区百分比，收敛到 40%–100%（默认 70%）
      next.widthRatio = clampContentWidthRatio(
        value.widthRatio ?? this.readingPreferences.widthRatio
      );
      this.readingPreferences = next;
      localStorage.setItem('readingPreferences', JSON.stringify(this.readingPreferences));
    },
    toggleResolvedTheme() {
      this.setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
    },
    /** 双链/关联跳转：记下来源页（id + 标题），供「返回上一页」逐级回退与下拉直选 */
    pushPageTrail(from: PageTrailSource | null | undefined, toId: string) {
      const next = pushTrail({ trail: this.pageTrail, target: this.pageTrailTarget }, from, toId);
      this.pageTrail = next.trail;
      this.pageTrailTarget = next.target;
    },
    /** 路由已落到 id：是轨迹跳转的目标就保留轨迹，否则（侧栏/搜索/图谱等）清空 */
    settlePageTrail(id: string) {
      const next = settleTrail({ trail: this.pageTrail, target: this.pageTrailTarget }, id);
      this.pageTrail = next.trail;
      this.pageTrailTarget = next.target;
    },
    /** 取上一页并把该页标记为本次导航目标，路由落地时据此保留剩余轨迹 */
    takePageTrailBack(): string | null {
      const { state, from } = takeTrailBack({ trail: this.pageTrail, target: this.pageTrailTarget });
      this.pageTrail = state.trail;
      this.pageTrailTarget = state.target;
      return from;
    },
    /** 下拉直选：跳回轨迹中的任意一层，该层之上的记录一并出栈 */
    takePageTrailBackTo(id: string): string | null {
      const { state, from } = takeTrailBackTo({ trail: this.pageTrail, target: this.pageTrailTarget }, id);
      this.pageTrail = state.trail;
      this.pageTrailTarget = state.target;
      return from;
    },
    bumpSidebar() {
      this.sidebarVersion++;
    },
    /** 开合聊天抽屉：打开即清未读 */
    toggleChat(open?: boolean) {
      this.chatDrawerOpen = open ?? !this.chatDrawerOpen;
      if (this.chatDrawerOpen) {
        this.chatUnread = false;
        // 抽屉回来了，最小化提示就该收工
        this.chatMinimizedAt = 0;
      }
    },
    /**
     * 满窗形态下导航到别的内容：Agent 直接最小化（收进 rail 的 ✨ 入口），
     * 不留在右侧占一条并排抽屉——用户要的是「点设置/实体就能看内容」，不是换一种占位方式。
     * 形态偏好（chatDrawerMode）不动，所以从 rail ✨ 或状态胶囊再打开时还是原来的满窗。
     * 非满窗形态（并排/已关）本来就不挡内容，这里不插手。
     */
    minimizeChatForNavigation() {
      if (!this.chatDrawerOpen || this.chatDrawerMode !== 'full') return;
      this.chatDrawerOpen = false;
      this.chatMinimizedAt = Date.now();
    },
    /**
     * 用户主动点抽屉头部的「最小化」：任何形态都收起来，右下角状态胶囊接管——
     * 空闲时提示 4 秒「已最小化 · 点此继续对话」，有轮次在跑就常驻显示进度。
     * 与关闭的区别只在「告诉用户它去哪儿了」：会话、草稿与形态偏好全部保留。
     */
    minimizeChat() {
      if (!this.chatDrawerOpen) return;
      this.chatDrawerOpen = false;
      this.chatMinimizedAt = Date.now();
    },
    /** 请聊天抽屉把光标放进输入框（选中文字提问后用户只需敲问题） */
    focusChatComposer() {
      this.chatComposerFocus += 1;
    },
    /**
     * 记下抽屉宽度偏好。这里只做安全收敛（不小于 320、不超过窗口宽度）：
     * 「并排最多占窗口 70%，越过即转满窗」是 ChatDrawer 的交互规则，不能在这里写死上限——
     * 否则拖过 70% 前就被悄悄截断（旧实现在这里固定 720，拖拽永远够不到满窗线）。
     */
    setChatDrawerWidth(width: number) {
      const max = Math.max(320, window.innerWidth);
      this.chatDrawerWidth = Math.min(max, Math.max(320, Math.round(width)));
      localStorage.setItem('chatDrawerWidth', String(this.chatDrawerWidth));
    },
    /** 切换抽屉形态：写入偏好，下次打开（含 rail ✨ 入口）沿用 */
    setChatDrawerMode(mode: ChatDrawerMode) {
      this.chatDrawerMode = mode;
      localStorage.setItem('chatDrawerMode', mode);
    },
    /**
     * 悬浮档生效宽度同步给首页（正文让位按它算）。
     * 值没变就不写，避免拖动/窗口变化时白白触发一轮渲染。
     */
    setChatDockWidth(width: number) {
      const next = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
      if (next !== this.chatDockWidth) this.chatDockWidth = next;
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
