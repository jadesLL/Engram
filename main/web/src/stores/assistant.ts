import { defineStore } from 'pinia';
import { api } from '../api';
import { router } from '../router';
import { useAppStore } from './app';

export interface AssistantContext {
  route?: string;
  currentPage?: { id: string; title: string; path: string; updatedAt?: string };
  currentFile?: { path: string; name?: string };
  selection?: string;
  preset?: 'continue' | 'polish' | 'expand' | 'summarize' | 'translate';
  presetText?: string;
}

export interface AssistantSession {
  id: string;
  title: string;
  summary: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantMessage {
  id: string;
  sessionId: string;
  runId?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface AssistantRun {
  id: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId?: string;
  status: string;
  context: AssistantContext;
  stepCount: number;
  cancelRequested: boolean;
  error?: string;
  ingestedPath?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AssistantToolCall {
  id: string;
  runId: string;
  name: string;
  arguments: Record<string, any>;
  risk: 'read' | 'reversible' | 'high' | 'restricted';
  status: string;
  preview: {
    title?: string;
    summary?: string;
    target?: string;
    details?: Record<string, any>;
    diff?: { kind: 'same' | 'add' | 'remove'; text: string }[];
    secondConfirmation?: boolean;
  };
  result: Record<string, any>;
  undo: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantSnapshot {
  session: AssistantSession;
  messages: AssistantMessage[];
  runs: AssistantRun[];
  toolCalls: AssistantToolCall[];
}

function errorText(error: any): string {
  return error?.response?.data?.error || error?.message || '请求失败';
}

export const useAssistantStore = defineStore('assistant', {
  state: () => ({
    initialized: false,
    loading: false,
    sessions: [] as AssistantSession[],
    activeSessionId: localStorage.getItem('assistantSessionId') || '',
    snapshot: null as AssistantSnapshot | null,
    eventSource: null as EventSource | null,
    currentContext: {} as AssistantContext,
    error: '',
  }),
  getters: {
    visibleMessages(state): AssistantMessage[] {
      return (state.snapshot?.messages || []).filter(
        (message: AssistantMessage) => !message.metadata.hidden && message.role !== 'tool'
      );
    },
    currentRun(state): AssistantRun | null {
      const runs = state.snapshot?.runs || [];
      return [...runs].reverse().find((run) =>
        ['queued', 'running', 'executing', 'waiting_approval'].includes(run.status)
      ) || null;
    },
    latestRun(state): AssistantRun | null {
      return state.snapshot?.runs?.[state.snapshot.runs.length - 1] || null;
    },
    pendingToolCalls(state): AssistantToolCall[] {
      const runId = [...(state.snapshot?.runs || [])].reverse()
        .find((run) => run.status === 'waiting_approval')?.id;
      return runId
        ? (state.snapshot?.toolCalls || []).filter(
          (call: AssistantToolCall) => call.runId === runId && call.status === 'proposed'
        )
        : [];
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
          const exists = this.sessions.some((session: AssistantSession) => session.id === this.activeSessionId);
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
    async refreshSnapshot() {
      if (!this.activeSessionId) return;
      const { data } = await api.get(`/api/assistant/sessions/${this.activeSessionId}`);
      this.snapshot = data;
    },
    async createSession(title?: string) {
      const { data } = await api.post('/api/assistant/sessions', { title });
      this.sessions = [
        data.session,
        ...this.sessions.filter((item: AssistantSession) => item.id !== data.session.id),
      ];
      await this.selectSession(data.session.id);
      return data.session as AssistantSession;
    },
    async selectSession(id: string) {
      if (!id) return;
      this.activeSessionId = id;
      localStorage.setItem('assistantSessionId', id);
      this.closeEvents();
      const { data } = await api.get(`/api/assistant/sessions/${id}`);
      this.snapshot = data;
      const active = [...data.runs].reverse().find((run: AssistantRun) =>
        ['queued', 'running', 'executing', 'waiting_approval'].includes(run.status)
      );
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
    setContext(context: AssistantContext) {
      this.currentContext = context;
    },
    clearContext() {
      this.currentContext = {};
    },
    async start(message: string, context?: AssistantContext) {
      await this.init();
      const text = message.trim();
      if (!text || !this.activeSessionId) return;
      this.error = '';
      try {
        const runContext = context || this.currentContext;
        const { data } = await api.post(
          `/api/assistant/sessions/${this.activeSessionId}/runs`,
          { message: text, context: runContext }
        );
        if (runContext.preset) {
          const { preset: _preset, presetText: _presetText, selection: _selection, ...rest } = runContext;
          this.currentContext = rest;
        }
        this.connect(data.run.id);
        await this.loadSessions();
      } catch (error) {
        this.error = errorText(error);
      }
    },
    async openWith(message = '', context?: AssistantContext, autoSend = false) {
      const app = useAppStore();
      app.aiDrawerOpen = true;
      if (context) this.setContext(context);
      await this.init();
      if (!autoSend) {
        window.dispatchEvent(new CustomEvent('assistant-prefill', { detail: { message } }));
      }
      if (autoSend && message.trim()) await this.start(message, context);
    },
    connect(runId: string) {
      this.closeEvents();
      const source = new EventSource(`/api/assistant/runs/${encodeURIComponent(runId)}/events`);
      this.eventSource = source;
      source.addEventListener('snapshot', (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data) as AssistantSnapshot;
        this.snapshot = snapshot;
        const run = snapshot.runs.find((item: AssistantRun) => item.id === runId);
        if (run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
          // 抽屉折叠时收到回复：左侧栏 AI 图标显示未读提示，打开抽屉时清除
          if (run.status === 'completed' && !useAppStore().aiDrawerOpen) {
            useAppStore().aiUnread = true;
          }
          this.closeEvents();
        }
      });
      source.addEventListener('delta', (event) => {
        const data = JSON.parse((event as MessageEvent).data);
        if (!this.snapshot) return;
        let message = this.snapshot.messages.find(
          (item: AssistantMessage) => item.id === data.messageId
        );
        if (!message) {
          message = {
            id: data.messageId,
            sessionId: this.activeSessionId,
            runId,
            role: 'assistant',
            content: '',
            metadata: { streaming: true },
            createdAt: new Date().toISOString(),
          };
          this.snapshot.messages.push(message);
        }
        message.content += data.text;
      });
      source.addEventListener('client_action', (event) => {
        const action = JSON.parse((event as MessageEvent).data);
        if (action.type === 'navigate' && action.path) router.push(action.path);
        if (action.type === 'upload') {
          window.dispatchEvent(new CustomEvent('assistant-open-upload'));
        }
      });
      const closeTerminal = async () => {
        this.closeEvents();
        await this.loadSessions().catch(() => {});
      };
      source.addEventListener('completed', closeTerminal);
      source.addEventListener('error', (event) => {
        if (event instanceof MessageEvent && event.data) {
          try { this.error = JSON.parse(event.data).message || ''; } catch { /* reconnect automatically */ }
        }
      });
    },
    closeEvents() {
      this.eventSource?.close();
      this.eventSource = null;
    },
    async decideAll(approved: boolean, confirmHighImpact = false) {
      const run = this.currentRun;
      if (!run || !this.pendingToolCalls.length) return;
      await api.post(`/api/assistant/runs/${run.id}/decisions`, {
        decisions: this.pendingToolCalls.map((call: AssistantToolCall) => ({
          toolCallId: call.id,
          approved,
          confirmHighImpact: approved && (call.risk !== 'high' || confirmHighImpact),
        })),
      });
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
      await api.post(`/api/assistant/runs/${target}/ingest`);
      await this.refreshSnapshot();
    },
    async undo(callId: string) {
      await api.post(`/api/assistant/tool-calls/${encodeURIComponent(callId)}/undo`);
      await this.refreshSnapshot();
    },
  },
});
