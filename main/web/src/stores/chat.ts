import { defineStore } from 'pinia';
import { api } from '../api';
import { useAppStore } from './app';
import {
  buildSelectionContext,
  composeSelectionText,
  type SelectionExcerpt,
  type SelectionLocation,
} from '../lib/askAgent';
import { buildAnswer, parseQuestion, pendingQuestions as pickPendingQuestions, type ChatQuestion } from '../lib/chatQuestions';

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

/** 子代理状态：running 在跑 / completed 成功 / failed 失败 / background 本轮结束时仍在后台跑 */
export type ChatSubagentStatus = 'running' | 'completed' | 'failed' | 'background';

/** 子代理过程里的一步（子会话里的工具调用） */
export interface ChatSubagentActivity {
  name: string;
  summary: string;
  status: 'running' | 'completed' | 'failed';
  text?: string;
  at: string;
}

/** 内置 Agent 派出的子代理（dsh 的 subagent / subagent_fork / workflow / ralph 子会话） */
export interface ChatSubagent {
  id: string;
  runId?: string;
  /** 派它的那次工具调用行 id：那张工具卡会合并进子代理卡，不再重复显示 */
  parentCallId?: string;
  parentSessionId: string;
  childSessionId: string;
  label: string;
  mode: string;
  provider: string;
  prompt: string;
  status: ChatSubagentStatus;
  stopReason: string;
  result: string;
  activity: ChatSubagentActivity[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatSnapshot {
  session: ChatSession;
  messages: ChatMessage[];
  runs: ChatRun[];
  toolCalls: ChatToolCall[];
  subagents: ChatSubagent[];
  /** 还在等用户点选的 Agent 提问（对话最下侧弹窗渲染；答复后从快照里消失） */
  questions?: ChatQuestion[];
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

/** 快照里正在跑的那一轮的 id（同一会话同时只有一轮在跑，取最后一条活动轮） */
function activeRunIdOf(snapshot: ChatSnapshot | null): string {
  const runs = snapshot?.runs || [];
  return [...runs].reverse().find((run) => ['queued', 'running'].includes(run.status))?.id || '';
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
    /**
     * 本端已经接上事件流、还没收到终态的轮次（runId → sessionId）。
     * 会话列表里的 running 是「拉取那一刻」的快照，这里是实时事实：抽屉关着、
     * 甚至从没打开过，也要能让用户看到「还在跑」。
     */
    activeRuns: {} as Record<string, string>,
  }),
  getters: {
    messages(state): ChatMessage[] {
      return state.snapshot?.messages || [];
    },
    runs(state): ChatRun[] {
      return state.snapshot?.runs || [];
    },
    /**
     * 正在跑的那一轮（只有 running；排队中的轮次还没送进 dsh，不算在跑）。
     * 输入框的可用性、秒表、状态条都以它为准。
     */
    currentRun(state): ChatRun | null {
      const runs = state.snapshot?.runs || [];
      return [...runs].reverse().find((run) => run.status === 'running') || null;
    },
    /** 排队中的轮次（先来后到）：消息已经在对话里，等当前这轮收口自动接着回复 */
    queuedRuns(state): ChatRun[] {
      return (state.snapshot?.runs || []).filter((run) => run.status === 'queued');
    },
    latestRun(state): ChatRun | null {
      return state.snapshot?.runs?.[state.snapshot.runs.length - 1] || null;
    },
    sessionToolCalls(state): ChatToolCall[] {
      return state.snapshot?.toolCalls || [];
    },
    sessionSubagents(state): ChatSubagent[] {
      return state.snapshot?.subagents || [];
    },
    /** 等用户点选的 Agent 提问（对话最下侧弹窗渲染；服务端只把 pending 的放进快照） */
    pendingQuestions(state): ChatQuestion[] {
      return pickPendingQuestions(state.snapshot?.questions);
    },
    /** 本轮派出的子代理（快照是唯一来源；本轮不在跑就为空） */
    currentSubagents(state): ChatSubagent[] {
      const runId = activeRunIdOf(state.snapshot);
      const all = state.snapshot?.subagents || [];
      return runId ? all.filter((item) => item.runId === runId) : [];
    },
    /** 正在跑的子代理（含后台跑着的），状态条据此报「N 个子代理在跑」 */
    runningSubagents(state): ChatSubagent[] {
      const runId = activeRunIdOf(state.snapshot);
      if (!runId) return [];
      return (state.snapshot?.subagents || []).filter(
        (item) => item.runId === runId && item.status === 'running'
      );
    },
    /**
     * 正在跑的会话数：服务端列表 + 本端实时跟踪的轮次取并集。
     * 头部按钮上给个数字，抽屉关着也知道有活儿在跑。
     */
    runningCount(state): number {
      const ids = new Set(state.sessions.filter((session) => session.running).map((session) => session.id));
      for (const sessionId of Object.values(state.activeRuns)) ids.add(sessionId);
      return ids.size;
    },
    /** 是否有任意会话在跑（图标栏/导航的「运行中」指示） */
    hasRunning(state): boolean {
      if (state.sessions.some((session) => session.running)) return true;
      return Object.keys(state.activeRuns).length > 0;
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
      this.activeRuns = Object.fromEntries(
        Object.entries(this.activeRuns).filter(([, sessionId]) => sessionId !== id)
      );
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
    /**
     * 发一条消息。会话正在回复时也照发：服务端把它落库成「排队中」的轮次，
     * 当前这轮一收口自动接着回复（前端重取快照就能看到那条消息与排队标记）。
     */
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
        if (data.queued) {
          // 排队：服务端已经把这条消息落库了，直接取快照让它立刻出现在转录里
          if (this.activeSessionId === sessionId) await this.reload(sessionId);
        } else if (this.snapshot && this.activeSessionId === sessionId) {
          // 先本地插入用户消息，不等服务端快照
          this.snapshot.messages.push({
            id: `local-${Date.now()}`,
            sessionId,
            runId: data.run.id,
            role: 'user',
            content: text,
            metadata: {},
            createdAt: new Date().toISOString(),
          });
          this.connect(data.run.id, sessionId);
        } else {
          this.connect(data.run.id, sessionId);
        }
        await this.loadSessions();
      } catch (error) {
        this.error = errorText(error);
      }
    },
    connect(runId: string, sessionId: string) {
      if (connections.has(runId)) return; // 同一轮只接一条流，切会话来回不重复叠加
      const source = new EventSource(`/api/assistant/runs/${encodeURIComponent(runId)}/events`);
      connections.set(runId, { source, sessionId });
      this.activeRuns = { ...this.activeRuns, [runId]: sessionId };
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
      // Agent 提问（MCP ask_user 挂起等你点选）：立刻弹在对话最下侧，不等下一次快照
      source.addEventListener('question', (event) => {
        if (!isActive() || !this.snapshot) return;
        let incoming: ChatQuestion | null = null;
        try {
          incoming = parseQuestion(JSON.parse((event as MessageEvent).data));
        } catch { /* 坏帧忽略：快照那条路还会再对一次 */ }
        if (!incoming) return;
        const rest = (this.snapshot.questions || []).filter((item) => item.id !== incoming!.id);
        this.snapshot.questions = incoming.status === 'pending' ? [...rest, incoming] : rest;
      });
      source.addEventListener('completed', () => {
        closeConnection(runId);
        this.forgetRun(runId);
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
    /** 一轮收口（或流被关掉）：从「正在跑」集合里摘掉，指示器才不会一直亮着 */
    forgetRun(runId: string) {
      if (!this.activeRuns[runId]) return;
      const next = { ...this.activeRuns };
      delete next[runId];
      this.activeRuns = next;
    },
    /**
     * 应用启动时调用：把服务端正在跑的轮次接上事件流。
     * 场景是「页面刷新 / 抽屉从没打开过」——此时 store 里没有任何轮次信息，
     * 图标栏的那颗「运行中」指示就无从谈起。
     */
    async syncRunningRuns() {
      try {
        const { data } = await api.get('/api/assistant/runs/active');
        const runs: Array<{ id: string; sessionId: string }> = data?.runs || [];
        for (const run of runs) this.connect(run.id, run.sessionId);
        // 服务端已经收口的轮次，本端还挂着的连接要摘掉（例如另一标签页停了它）
        const alive = new Set(runs.map((run) => run.id));
        for (const runId of Object.keys(this.activeRuns)) {
          if (alive.has(runId)) continue;
          closeConnection(runId);
          this.forgetRun(runId);
        }
      } catch {
        /* 离线/未登录时静默：打开抽屉会重新对齐 */
      }
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
        this.forgetRun(runId);
        return;
      }
      for (const id of [...connections.keys()]) closeConnection(id);
      this.activeRuns = {};
    },
    /**
     * 停止：服务端立刻落终态并广播，这里同步把本端运行态收干净（不等 SSE 终态到达），
     * 再重取快照——按钮按下即见效，不会还挂着「正在回复」。
     *
     * @returns 被一并撤下的排队消息原文（停止 = 全停，交回抽屉填进输入框）
     */
    async cancel(): Promise<string[]> {
      const run = this.currentRun;
      if (!run) return [];
      const sessionId = run.sessionId;
      const { data } = await api.post(`/api/assistant/runs/${run.id}/cancel`);
      closeConnection(run.id);
      this.forgetRun(run.id);
      this.statusText = '';
      if (this.activeSessionId === sessionId) {
        await this.reload(sessionId).catch(() => {});
      }
      await this.loadSessions().catch(() => {});
      return Array.isArray(data?.released) ? (data.released as string[]) : [];
    },
    async retry(runId?: string) {
      const target = runId || this.latestRun?.id;
      if (!target) return;
      const sessionId = this.snapshot?.session.id || this.activeSessionId;
      const { data } = await api.post(`/api/assistant/runs/${target}/retry`);
      // 重试也可能被排到队尾（会话里还有一轮在跑）：那种情况等它转正自然会接上事件流
      if (data.queued) {
        if (this.activeSessionId === sessionId) await this.reload(sessionId).catch(() => {});
      } else {
        this.connect(data.run.id, sessionId);
      }
      await this.loadSessions().catch(() => {});
    },
    async ingest(runId?: string) {
      const target = runId || this.latestRun?.id;
      if (!target) return;
      const { data } = await api.post(`/api/assistant/runs/${target}/ingest`);
      await this.reload(this.activeSessionId);
      return data.meta as { path: string; title: string };
    },
    /**
     * 答复 Agent 的提问（对话最下侧弹窗点选）。
     * 服务端据此唤醒挂起的 MCP ask_user 工具调用——Agent 在同一轮里拿到答复继续往下做，
     * 随后推来的快照会让这条提问从列表里消失。
     */
    async answerQuestion(questionId: string, selected: string[], custom = '') {
      const question = (this.snapshot?.questions || []).find((item) => item.id === questionId);
      const payload = question ? buildAnswer(question, selected, custom) : { selected, custom };
      const { data } = await api.post(
        `/api/assistant/questions/${encodeURIComponent(questionId)}/answer`,
        payload
      );
      // 本地先摘掉：点选即见效，不等下一帧快照
      if (this.snapshot?.questions) {
        this.snapshot.questions = this.snapshot.questions.filter((item) => item.id !== questionId);
      }
      return data.question as ChatQuestion;
    },
  },
});
