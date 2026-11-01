import { createRouter, createWebHistory } from 'vue-router';
import { useAppStore } from './stores/app';
import { useAuthStore } from './stores/auth';
import { WINDOW_SIZE_EXPANDED } from './lib/windowSizeClass';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/Login.vue') },
    {
      path: '/',
      component: () => import('./views/Home.vue'),
      children: [
        { path: '', redirect: '/page' },
        { path: 'page/:id?', component: () => import('./views/EditorView.vue') },
        { path: 'search', component: () => import('./views/SearchView.vue') },
        { path: 'graph/:id?', component: () => import('./views/GraphView.vue') },
        { path: 'inbox', component: () => import('./views/InboxViewRoute.vue') },
        { path: 'tasks', component: () => import('./views/TasksView.vue') },
        { path: 'customer-research', component: () => import('./views/CustomerResearchView.vue') },
        { path: 'settings', component: () => import('./views/SettingsView.vue') },
        /* 内置 Agent 的独立全屏页（2026-11 安卓改版）：手机档（<840）的顶层目的地之一。
           桌面档（≥840）没有这一页——下面的守卫把它送回内容页，并按既有方式打开右侧抽屉，
           桌面端「点 Agent 图标开抽屉」的行为完全不变。 */
        { path: 'agent', component: () => import('./views/AgentView.vue') },
        /* 内置 Agent 控制台整页（Engram 原生界面）：Home 的 isActive('/settings') 是前缀匹配，
           settings-open 布局（宽屏隐藏 .content 滚动、由页面自己滚）自动生效。 */
        { path: 'settings/agent-console', component: () => import('./views/AgentConsoleView.vue') },
      ],
    },
  ],
});

/**
 * 手机档（<840）才有独立的 Agent 页。840 是 lib/windowSizeClass 的 expanded 起点
 * （平板横屏 / 桌面网页），那一侧的 Agent 一直是「右侧抽屉」，不新增第二套界面。
 */
function agentPageAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < WINDOW_SIZE_EXPANDED;
}

/** 桌面档访问 /agent 被送回内容页时，等导航落地后再开抽屉用的一次性标记 */
let openChatAfterRedirect = false;

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.check();
  if (to.path === '/login') return true;
  if (!auth.initialized || !auth.authed) return '/login';

  /* 桌面档（≥840）直接打开 /agent（书签 / 旧链接）：没有这一页，回内容页并沿用
     「点 Agent 图标开抽屉」的既有行为。抽屉必须等 afterEach 再开——那里会先
     minimizeChatForNavigation（满窗形态会被收掉），同一钩子里后开才不会被顺手关上。 */
  if (to.path === '/agent' && !agentPageAvailable()) {
    openChatAfterRedirect = true;
    return { path: '/page' };
  }
  return true;
});

/*
 * 满窗形态下导航到别的内容（设置、侧栏实体页、搜索、图谱、双链跳转……）：
 * 把内置 Agent 最小化，正文立刻占满整屏。挂在路由上而不是逐个按钮上，
 * 这样侧栏、搜索结果、双链、返回轨迹这些入口一个都不漏；非满窗形态不受影响。
 *
 * 知识库侧栏满窗同一条规则：满窗目录里点开一篇、或从别处跳走，目录自动收回窄栏
 * （满窗是「找那一篇」的临时形态，找到了就该让位给正文）。
 */
router.afterEach((to, from) => {
  const app = useAppStore();
  /* 桌面档在 /page 上打开 /agent：重定向回到同一路径，afterEach 会因 fullPath 相同提前返回，
     抽屉仍要补开，所以标记先取再判。 */
  const redirectedFromAgent = openChatAfterRedirect;
  openChatAfterRedirect = false;
  if (to.fullPath === from.fullPath) {
    if (redirectedFromAgent) app.toggleChat(true);
    return;
  }
  app.minimizeChatForNavigation();
  app.exitSidebarFullForNavigation();
  if (redirectedFromAgent) app.toggleChat(true);
});
