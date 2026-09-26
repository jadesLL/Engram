import { defineStore } from 'pinia';
import { api } from '../api';
import { parseTaskBoard, type TaskBoard } from '../lib/taskBoard';

/**
 * 任务看板的前端状态：读服务端的看板现状 → 需要时起一轮 → 接事件流看进度 → 完成后重读取答案。
 *
 * 为什么不复用聊天 store：看板要的只是「跑到哪了 + 那一轮的答案」，而聊天 store 的状态
 * 是按「当前打开的会话」组织的（快照、流式正文、未读、排队…）。混在一起会让看板一旦刷新
 * 就在会话列表里点亮未读、甚至把抽屉里的转录换掉。这里单独一条最轻的通道：
 * 自己接同一份 SSE 事件（completion 就重拉一次看板接口），跑完即断。
 */

/** 服务端给的看板状态（与 server/src/assistant/taskBoard.ts 的 TaskBoardState 对应） */
interface BoardPayload {
  sessionId: string;
  status: 'empty' | 'running' | 'ready' | 'failed';
  answer: string;
  generatedAt: string;
  stale: boolean;
  runId: string;
  runStatus: string;
  runStartedAt: string;
  error: string;
}

interface BoardConnection {
  source: EventSource;
  pollTimer?: number;
}

/** SSE 连接放在 store 之外：EventSource 不该进 Vue 响应式代理，也方便随时断掉 */
let connection: BoardConnection | null = null;

function closeConnection(): void {
  if (!connection) return;
  if (connection.pollTimer !== undefined) window.clearInterval(connection.pollTimer);
  connection.source.close();
  connection = null;
}

function errorText(error: any): string {
  return error?.response?.data?.error || error?.message || '请求失败';
}

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    loaded: false,
    loading: false,
    /** 正在起一轮（点刷新到服务端受理之间的空窗） */
    starting: false,
    status: 'empty' as BoardPayload['status'],
    answer: '',
    generatedAt: '',
    stale: false,
    sessionId: '',
    runId: '',
    runStatus: '',
    runStartedAt: '',
    /** 最近一轮的失败原因（有答案时表示「刷新失败，下面是上一版」） */
    error: '',
    /** 运行中的当前动作（服务端 status 事件里的人话，如正在读哪份资料） */
    activity: '',
  }),
  getters: {
    /** 解析好的看板（解析不出来为 null，页面据此显示空状态） */
    board(state): TaskBoard | null {
      return state.answer ? parseTaskBoard(state.answer) : null;
    },
    running(state): boolean {
      return state.status === 'running' || state.starting;
    },
    /** 有答案但已过期：进页面会自动重跑，界面先显示旧的一版 */
    outdated(state): boolean {
      return Boolean(state.answer) && state.stale;
    },
  },
  actions: {
    apply(payload: BoardPayload) {
      this.sessionId = payload.sessionId || '';
      this.status = payload.status;
      this.answer = payload.answer || '';
      this.generatedAt = payload.generatedAt || '';
      this.stale = Boolean(payload.stale);
      this.runId = payload.runId || '';
      this.runStatus = payload.runStatus || '';
      this.runStartedAt = payload.runStartedAt || '';
      this.error = payload.error || '';
      if (this.status !== 'running') this.activity = '';
    },

    /** 拉一次现状；返回是否需要（按新鲜度）重新生成 */
    async load(): Promise<boolean> {
      this.loading = true;
      try {
        const { data } = await api.get<BoardPayload>('/api/tasks/board');
        this.apply(data);
        this.loaded = true;
        if (this.status === 'running' && this.runId) this.attach(this.runId);
        return !this.answer || this.stale;
      } catch (error) {
        this.error = errorText(error);
        this.loaded = true;
        return false;
      } finally {
        this.loading = false;
      }
    },

    /** 起一轮（已在跑就复用服务端那一轮）；成功与否都不改主环境 */
    async refresh(): Promise<boolean> {
      this.starting = true;
      this.error = '';
      try {
        const { data } = await api.post<{ sessionId: string; run: { id: string; status: string; createdAt: string } }>(
          '/api/tasks/board/refresh'
        );
        this.sessionId = data.sessionId;
        this.runId = data.run.id;
        this.runStatus = data.run.status;
        this.runStartedAt = data.run.createdAt;
        this.status = 'running';
        this.attach(data.run.id);
        return true;
      } catch (error) {
        this.error = errorText(error);
        this.status = this.answer ? 'failed' : 'empty';
        return false;
      } finally {
        this.starting = false;
      }
    },

    /**
     * 接这一轮的事件流：只要进度人和终态。
     * 终态到了立刻断流并重拉看板（答案的解析在客户端，服务端只存原文）；
     * 另加 5 秒兜底轮询，SSE 断线时也能收口。
     */
    attach(runId: string) {
      closeConnection();
      const source = new EventSource(`/api/assistant/runs/${encodeURIComponent(runId)}/events`);
      connection = { source };

      source.addEventListener('status', (event) => {
        try {
          this.activity = JSON.parse((event as MessageEvent).data).text || '';
        } catch { /* 坏帧忽略 */ }
      });
      source.addEventListener('completed', () => {
        closeConnection();
        void this.load();
      });
      source.addEventListener('error', () => {
        // EventSource 自己会重连；这里只在断线时不再显示过时的动作文案
        this.activity = '';
      });

      connection.pollTimer = window.setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        void this.load();
      }, 5000);
    },

    /** 离开页面：断流（本轮照常在服务端跑完，下次进来 load 就能看到结果） */
    detach() {
      closeConnection();
    },
  },
});
