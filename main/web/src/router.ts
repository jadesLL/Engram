import { createRouter, createWebHistory } from 'vue-router';
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
        { path: 'reports', component: () => import('./views/ReportsView.vue') },
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
