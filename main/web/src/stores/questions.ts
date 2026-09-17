import { defineStore } from 'pinia';
import { api } from '../api';

/**
 * 待确认问题（外部 Agent 经 MCP ask_user / CLI ask 登记，用户在这里答复）。
 * 未答复条数用于 rail 角标；SSE 收到 question 事件时刷新。
 */

export interface AgentQuestion {
  id: string;
  question: string;
  context: string;
  options: string[];
  answer: string;
  status: 'open' | 'answered';
  created_at: string;
  answered_at: string | null;
}

export const useQuestionsStore = defineStore('questions', {
  state: () => ({
    items: [] as AgentQuestion[],
    /** 未答复条数（角标） */
    open: 0,
    loading: false,
    loaded: false,
  }),
  actions: {
    async refresh(status: 'all' | 'open' | 'answered' = 'all') {
      this.loading = true;
      try {
        const { data } = await api.get('/api/questions', { params: { status } });
        this.items = data.questions || [];
        this.open = data.open ?? 0;
        this.loaded = true;
      } catch {
        /* 保留上次状态：角标不因一次失败闪没 */
      } finally {
        this.loading = false;
      }
    },
    async answer(id: string, answer: string) {
      const { data } = await api.post(`/api/questions/${encodeURIComponent(id)}/answer`, { answer });
      await this.refresh();
      return data.question as AgentQuestion;
    },
  },
});
