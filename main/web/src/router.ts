import { createRouter, createWebHistory } from 'vue-router';
import { useAppStore } from './stores/app';
import { useAuthStore } from './stores/auth';

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
        { path: 'settings', component: () => import('./views/SettingsView.vue') },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.check();
  if (to.path === '/login') return true;
  if (!auth.initialized || !auth.authed) return '/login';
  return true;
});

/*
 * 满窗形态下导航到别的内容（设置、侧栏实体页、搜索、图谱、双链跳转……）：
 * 把内置 Agent 最小化，正文立刻占满整屏。挂在路由上而不是逐个按钮上，
 * 这样侧栏、搜索结果、双链、返回轨迹这些入口一个都不漏；非满窗形态不受影响。
 */
router.afterEach((to, from) => {
  if (to.fullPath === from.fullPath) return;
  useAppStore().minimizeChatForNavigation();
});
