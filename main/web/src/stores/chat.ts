import { defineStore } from 'pinia';
import { api } from '../api';
import { useAppStore } from './app';
import {
  buildSelectionContext,
  composeSelectionText,
  type SelectionExcerpt,
  type SelectionLocation,
} from '../lib/askAgent';

/**
 * 内置 Agent（聊天抽屉）的前端状态：会话列表 + 快照 + SSE 增量。
 *
 * 数据面与 v1.1 的聊天抽屉一致（同一套 assistant_* 表与 SSE 契约），驱动方换成了
 * Engram 随包内置的 dsh：正文按步整段到达（delta），工具调用以快照刷新（snapshot）。
 */

export interface ChatContext {
  route?: string;
  currentPage?: { id?: string; title?: string; path?: string };
  currentFile?: { path?: string; name?: string };
  selection?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface ChatRun {
  id: string;
  sessionId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  error?: string;
  ingestedPath?: string;
  createdAt: string;
}

export interface ChatToolCall {
  id: string;
  runId: string;
  name: string;
  args: string;
  status: string;
  ok: boolean;
  text: string;
  createdAt: string;
}

export interface ChatSnapshot {
  session: ChatSession;
  messages: ChatMessage[];
  runs: ChatRun[];
  toolCalls: ChatToolCall[];
}

function errorText(error: any): string {
  return error?.response?.data?.error || error?.message || '请求失败';
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    initialized: false,
    loading: false,
    sessions: [] as ChatSession[],
    activeSessionId: localStorage.getItem('chatSessionId') || '',
    snapshot: null as ChatSnapshot | null,
    eventSource: null as EventSource | null,
    currentContext: {} as ChatContext,
    /** 输入框上方逐条展示的选中片段（右击「在 Agent 中提问」累积） */
    selections: [] as SelectionExcerpt[],
    statusText: '',
    error: '',
  }),
  getters: {
    messages(state): ChatMessage[] {
      return state.snapshot?.messages || [];
    },
    runs(state): ChatRun[] {
      return state.snapshot?.runs || [];
    },
    currentRun(state): ChatRun | null {
      const runs = state.snapshot?.runs || [];
      return [...runs].reverse().find((run) =>
        ['queued', 'running'].includes(run.status)
      ) || null;
    },
    latestRun(state): ChatRun | null {
      return state.snapshot?.runs?.[state.snapshot.runs.length - 1] || null;
    },
    sessionToolCalls(state): ChatToolCall[] {
      return state.snapshot?.toolCalls || [];
    },
  },
  actions: {
    async init() {
      if (this.initialized || this.loading) return;
      this.loading = true;
      try {
        await this.loadSessions();
        if (!this.sessions.length) {
          await this.createSession();
        } else {
          const exists = this.sessions.some((s) => s.id === this.activeSessionId);
          await this.selectSession(exists ? this.activeSessionId : this.sessions[0].id);
        }
        this.initialized = true;
      } finally {
        this.loading = false;
      }
    },
    async loadSessions() {
      const { data } = await api.get('/api/assistant/sessions');
      this.sessions = data.sessions;
    },
    async createSession(title?: string) {
      const { data } = await api.post('/api/assistant/sessions', { title });
      this.sessions = [data.session, ...this.sessions.filter((s) => s.id !== data.session.id)];
      await this.selectSession(data.session.id);
      return data.session as ChatSession;
    },
    async selectSession(id: string) {
      if (!id) return;
      this.activeSessionId = id;
      localStorage.setItem('chatSessionId', id);
      this.closeEvents();
      const { data } = await api.get(`/api/assistant/sessions/${id}`);
      this.snapshot = data;
      const active = this.currentRun;
      if (active) this.connect(active.id);
    },
    async deleteActiveSession() {
      if (!this.activeSessionId) return;
      await api.delete(`/api/assistant/sessions/${this.activeSessionId}`);
      this.closeEvents();
      this.snapshot = null;
      await this.loadSessions();
      if (this.sessions.length) await this.selectSession(this.sessions[0].id);
      else await this.createSession();
    },
    setContext(context: ChatContext) {
      this.currentContext = context;
    },
    /**
     * 选中文字提问：把片段追加进列表（同一段不重复加），刷新所在位置上下文，
     * 并把全部片段拼成 wire 上的 `selection`。片段本身留给抽屉在输入框上方逐条展示。
     */
    askAboutSelection(input: { text: string; source?: string; location: SelectionLocation }) {
      const text = (input.text || '').trim();
      if (!text) return;
      const source = (input.source || '').trim();
      if (!this.selections.some((item) => item.text === text && item.source === source)) {
        this.selections.push({
          id: `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          source,
        });
      }
      this.currentContext = {
        ...buildSelectionContext(input.location),
        ...(composeSelectionText(this.selections)
          ? { selection: composeSelectionText(this.selections) }
          : {}),
      };
    },
    removeSelection(id: string) {
      this.selections = this.selections.filter((item) => item.id !== id);
      this.syncSelectionText();
    },
    clearSelections() {
      this.selections = [];
      this.syncSelectionText();
    },
    /** 片段增删后同步 wire 上的 selection：没有片段就整条去掉，避免送出空上下文 */
    syncSelectionText() {
      const text = composeSelectionText(this.selections);
      const next: ChatContext = { ...this.currentContext };
      if (text) next.selection = text;
      else delete next.selection;
      this.currentContext = next;
    },
    clearContext() {
      this.currentContext = {};
      this.selections = [];
    },
    async send(message: string, context?: ChatContext) {
      await this.init();
      const text = message.trim();
      if (!text || !this.activeSessionId) return;
      this.error = '';
      this.statusText = '';
      try {
        const { data } = await api.post(`/api/assistant/sessions/${this.activeSessionId}/runs`, {
          message: text,
          context: context || this.currentContext,
        });
        // 先本地插入用户消息，不等服务端快照
        if (this.snapshot) {
          this.snapshot.messages.push({
            id: `local-${Date.now()}`,
            sessionId: this.activeSessionId,
            runId: data.run.id,
            role: 'user',
            content: text,
            metadata: {},
            createdAt: new Date().toISOString(),
          });
        }
        this.connect(data.run.id);
        await this.loadSessions();
      } catch (error) {
        this.error = errorText(error);
      }
    },
    connect(runId: string) {
      this.closeEvents();
      const source = new EventSource(`/api/assistant/runs/${encodeURIComponent(runId)}/events`);
      this.eventSource = source;
      source.addEventListener('snapshot', (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data) as ChatSnapshot;
        // 保留本地插入但服务端还没有的乐观消息
        const serverIds = new Set(snapshot.messages.map((m) => m.runId));
        const pending = this.messages.filter((m) => m.id.startsWith('local-') && m.runId && !serverIds.has(m.runId));
        this.snapshot = snapshot;
        if (pending.length) snapshot.messages.push(...pending);
      });
      source.addEventListener('status', (event) => {
        try {
          this.statusText = JSON.parse((event as MessageEvent).data).text || '';
        } catch { /* 忽略坏帧 */ }
      });
      source.addEventListener('delta', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        this.statusText = '';
        if (!this.snapshot) return;
        let message = this.snapshot.messages.find((m) => m.id === data.messageId);
        if (!message) {
          message = {
            id: data.messageId,
            sessionId: this.activeSessionId,
            runId,
            role: 'assistant',
            content: '',
            metadata: {},
            createdAt: new Date().toISOString(),
          };
          this.snapshot.messages.push(message);
          this.snapshot.runs.forEach((run) => {
            if (run.id === runId && !run.status) run.status = 'running';
          });
        }
        message.content += data.text;
      });
      source.addEventListener('completed', () => {
        this.statusText = '';
        const app = useAppStore();
        if (!app.chatDrawerOpen) app.chatUnread = true;
        this.closeEvents();
        void this.loadSessions().catch(() => {});
        if (this.activeSessionId) {
          void this.selectSession(this.activeSessionId).catch(() => {});
        }
      });
      source.addEventListener('error', (event) => {
        if (event instanceof MessageEvent && event.data) {
          try {
            this.error = JSON.parse(event.data).message || '';
          } catch { /* 网络抖动会让 EventSource 自动重连 */ }
        }
      });
    },
    closeEvents() {
      this.eventSource?.close();
      this.eventSource = null;
    },
    async cancel() {
      const run = this.currentRun;
      if (!run) return;
      await api.post(`/api/assistant/runs/${run.id}/cancel`);
    },
    async retry(runId?: string) {
      const target = runId || this.latestRun?.id;
      if (!target) return;
      const { data } = await api.post(`/api/assistant/runs/${target}/retry`);
      this.connect(data.run.id);
    },
    async ingest(runId?: string) {
      const target = runId || this.latestRun?.id;
      if (!target) return;
      const { data } = await api.post(`/api/assistant/runs/${target}/ingest`);
      await this.selectSession(this.activeSessionId);
      return data.meta as { path: string; title: string };
    },
  },
});
