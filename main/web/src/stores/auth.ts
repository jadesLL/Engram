import { defineStore } from 'pinia';
import { api } from '../api';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    initialized: true,
    authed: false,
    checked: false,
  }),
  actions: {
    async check() {
      if (this.checked) return;
      this.checked = true;
      try {
        const { data } = await api.get('/api/auth/status');
        this.initialized = data.initialized;
        // 探测登录态：请求一个受保护接口
        await api.get('/api/pages/tags');
        this.authed = true;
      } catch (e: any) {
        if (e.response?.status !== 401) {
          this.authed = false;
        }
        this.authed = false;
      }
    },
    async login(password: string, isSetup: boolean) {
      await api.post(isSetup ? '/api/auth/setup' : '/api/auth/login', { password });
      this.authed = true;
      this.initialized = true;
    },
    async logout() {
      await api.post('/api/auth/logout');
      this.authed = false;
      location.href = '/login';
    },
  },
});
