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
 * Engram 随包内置的 dsh：正文按步整段到达（delta），思考过程按原始增量逐块到达
 * （delta + kind='reasoning'），工具调用以快照刷新（snapshot）。
 *
 * 多对话：每个会话同时最多一轮运行（服务端单飞），不同会话可并行。事件流按 runId
 * 各开一条并全程保留，所以切走再回来能看到进行中的回复，后台会话跑完会标未读。
 */

export interface ChatContext {
  route?: string;
  currentPage?: { id?: string; title?: string; path?: string };
  currentFile?: { path?: string; name?: string };
  selection?: string;
}

export type TitleSource = 'default' | 'auto' | 'user';

export interface ChatSession {
  id: string;
  title: string;
  titleSource?: TitleSource;
  /** 该会话当前有正在跑的一轮（服务端按 runs 表实时算） */
  running?: boolean;
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

/**
 * 每个运行一条 SSE 连接，放在 store 之外：EventSource 不该进 Vue 响应式代理，
 * 且切换会话时连接要保留（后台会话照常收事件、跑完标未读）。
 */
const connections = new Map<string, { source: EventSource; sessionId: string }>();

function closeConnection(runId: string): void {
  const entry = connections.get(runId);
  if (!entry) return;
  connections.delete(runId);
  entry.source.close();
}

function closeSessionConnections(sessionId: string): void {
  for (const [runId, entry] of [...connections]) {
    if (entry.sessionId === sessionId) closeConnection(runId);
  }
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
    currentContext: {} as ChatContext,
    /** 输入框上方逐条展示的选中片段（右击「在 Agent 中提问」累积） */
    selections: [] as SelectionExcerpt[],
    statusText: '',
    error: '',
    /** 会话列表面板（替换转录区显示） */
    sessionPanelOpen: false,
    sessionQuery: '',
    /** 后台会话跑完但还没看：会话列表里标「新回复」 */
    unread: {} as Record<string, boolean>,
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
    /** 正在跑的会话数：头部按钮上给个数字，关着面板也知道有活儿在跑 */
    runningCount(state): number {
      return state.sessions.filter((session) => session.running).length;
    },
    filteredSessions(state): ChatSession[] {
      const query = state.sessionQuery.trim().toLowerCase();
      if (!query) return state.sessions;
      return state.sessions.filter((session) => session.title.toLowerCase().includes(query));
    },
  },
  actions: {
    /**
     * 打开抽屉时调用：刷新会话列表与当前会话快照。
     * 不做「只初始化一次」的短路——抽屉是随开关挂载/卸载的，重开时必须重新对齐
     * （后台跑完的一轮、自动更名后的标题、别人改过的会话都要能立刻看到）。
     */
    async init() {
      if (this.loading) return;
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
    /** 把快照/列表里的会话信息并回会话列表（标题自动更名后要立刻反映到列表） */
    mergeSession(session: ChatSession | undefined) {
      if (!session?.id) return;
      const index = this.sessions.findIndex((item) => item.id === session.id);
      if (index === -1) return;
      const merged = { ...this.sessions[index], ...session };
      this.sessions = [
        ...this.sessions.slice(0, index),
        merged,
        ...this.sessions.slice(index + 1),
      ];
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
      this.sessionPanelOpen = false;
      this.statusText = '';
      if (this.unread[id]) this.unread = { ...this.unread, [id]: false };
      await this.reload(id);
    },
    /** 重新拉取某个会话的快照；进行中的一轮顺带把事件流接上（连接已在则不重复接） */
    async reload(id: string) {
      const { data } = await api.get(`/api/assistant/sessions/${id}`);
      if (this.activeSessionId !== id) return;
      this.snapshot = data as ChatSnapshot;
      this.mergeSession(data.session);
      const active = this.currentRun;
      if (active) this.connect(active.id, id);
    },
    async renameSession(id: string, title: string) {
      const next = title.trim();
      if (!next) return;
      const { data } = await api.patch(`/api/assistant/sessions/${id}`, { title: next });
      if (data?.session) this.mergeSession(data.session);
      if (this.snapshot?.session.id === id) this.snapshot.session = { ...this.snapshot.session, ...data.session };
    },
    async deleteSession(id: string) {
      if (!id) return;
      await api.delete(`/api/assistant/sessions/${id}`);
      closeSessionConnections(id);
      this.sessions = this.sessions.filter((session) => session.id !== id);
      if (this.activeSessionId !== id) return;
      this.snapshot = null;
      if (this.sessions.length) await this.selectSession(this.sessions[0].id);
      else await this.createSession();
    },
    toggleSessionPanel(open?: boolean) {
      this.sessionPanelOpen = open ?? !this.sessionPanelOpen;
      if (this.sessionPanelOpen) this.sessionQuery = '';
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
      if (!this.initialized) await this.init();
      const text = message.trim();
      if (!text || !this.activeSessionId) return;
      const sessionId = this.activeSessionId;
      this.error = '';
      this.statusText = '';
      try {
        const { data } = await api.post(`/api/assistant/sessions/${sessionId}/runs`, {
          message: text,
          context: context || this.currentContext,
        });
        // 先本地插入用户消息，不等服务端快照
        if (this.snapshot && this.activeSessionId === sessionId) {
          this.snapshot.messages.push({
            id: `local-${Date.now()}`,
            sessionId,
            runId: data.run.id,
            role: 'user',
            content: text,
            metadata: {},
            createdAt: new Date().toISOString(),
          });
        }
        this.connect(data.run.id, sessionId);
        await this.loadSessions();
      } catch (error) {
        this.error = errorText(error);
      }
    },
    connect(runId: string, sessionId: string) {
      if (connections.has(runId)) return; // 同一轮只接一条流，切会话来回不重复叠加
      const source = new EventSource(`/api/assistant/runs/${encodeURIComponent(runId)}/events`);
      connections.set(runId, { source, sessionId });
      const isActive = () => this.activeSessionId === sessionId;

      source.addEventListener('snapshot', (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data) as ChatSnapshot;
        // 标题可能刚被自动更名：列表与快照都要跟上
        this.mergeSession(snapshot.session);
        if (!isActive()) return;
        // 保留本地插入但服务端还没有的乐观消息
        const serverIds = new Set(snapshot.messages.map((m) => m.runId));
        const pending = this.messages.filter((m) => m.id.startsWith('local-') && m.runId && !serverIds.has(m.runId));
        this.snapshot = snapshot;
        if (pending.length) snapshot.messages.push(...pending);
      });
      source.addEventListener('status', (event) => {
        if (!isActive()) return;
        try {
          this.statusText = JSON.parse((event as MessageEvent).data).text || '';
        } catch { /* 忽略坏帧 */ }
      });
      source.addEventListener('delta', (event) => {
        if (!isActive() || !this.snapshot) return;
        const data = JSON.parse((event as MessageEvent).data);
        this.statusText = '';
        let message = this.snapshot.messages.find((m) => m.id === data.messageId);
        if (!message) {
          message = {
            id: data.messageId,
            sessionId,
            runId,
            role: 'assistant',
            content: '',
            metadata: data.kind === 'reasoning' ? { kind: 'reasoning' } : {},
            createdAt: new Date().toISOString(),
          };
          this.snapshot.messages.push(message);
        }
        message.content += data.text;
      });
      source.addEventListener('completed', () => {
        closeConnection(runId);
        void this.finishRun(sessionId);
      });
      source.addEventListener('error', (event) => {
        if (!isActive()) return;
        if (event instanceof MessageEvent && event.data) {
          try {
            this.error = JSON.parse(event.data).message || '';
          } catch { /* 网络抖动会让 EventSource 自动重连 */ }
        }
      });
    },
    /** 一轮收口：刷新列表；当前会话重取快照，后台会话标未读 */
    async finishRun(sessionId: string) {
      const app = useAppStore();
      if (!app.chatDrawerOpen) app.chatUnread = true;
      await this.loadSessions().catch(() => {});
      if (this.activeSessionId === sessionId) {
        this.statusText = '';
        await this.reload(sessionId).catch(() => {});
        return;
      }
      this.unread = { ...this.unread, [sessionId]: true };
    },
    closeEvents(runId?: string) {
      if (runId) {
        closeConnection(runId);
        return;
      }
      for (const id of [...connections.keys()]) closeConnection(id);
    },
    async cancel() {
      const run = this.currentRun;
      if (!run) return;
      await api.post(`/api/assistant/runs/${run.id}/cancel`);
    },
    async retry(runId?: string) {
      const target = runId || this.latestRun?.id;
      if (!target) return;
      const sessionId = this.snapshot?.session.id || this.activeSessionId;
      const { data } = await api.post(`/api/assistant/runs/${target}/retry`);
      this.connect(data.run.id, sessionId);
      await this.loadSessions().catch(() => {});
    },
    async ingest(runId?: string) {
      const target = runId || this.latestRun?.id;
      if (!target) return;
      const { data } = await api.post(`/api/assistant/runs/${target}/ingest`);
      await this.reload(this.activeSessionId);
      return data.meta as { path: string; title: string };
    },
  },
});
