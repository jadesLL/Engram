import { defineStore } from 'pinia';
import { editorAiErrorMessage, isEditorAiAbort, requestEditorAi } from '../lib/editorAi';
import { notify } from '../lib/notify';

/**
 * 「AI 全文格式美化」的全局任务状态。
 *
 * 为什么放在 store 而不是对话框里：美化是整页任务，用户最小化或切到别的页面后
 * 请求要继续跑（对话框卸载不能 abort）。对话框只负责展示，任务生命周期在这里：
 *   running → done / failed；最小化只是 minimized=true，胶囊（BeautifyTaskPill）接管状态。
 * 当前只允许一个全局美化任务：重新整理会 abort 上一个。
 */

export type BeautifyStatus = 'running' | 'done' | 'failed';

export interface BeautifyTask {
  /** 本地任务序号：Pinia 会把 task 包成响应式代理，异步回调里用 id 判断「还是不是同一轮」 */
  id: number;
  pageId: string;
  pageTitle: string;
  /** 发起时的正文（wiki 链接形态）：应用前用它判断页面在这期间有没有被改过 */
  source: string;
  status: BeautifyStatus;
  startedAt: number;
  finishedAt: number | null;
  result: string;
  error: string;
  /** 对话框收起为右下角胶囊；离开编辑页也会自动收起 */
  minimized: boolean;
  /** 用户点了胶囊「查看」：等编辑页挂载/接管后打开预览 */
  pendingOpen: boolean;
}

/** 请求句柄放在模块级：Pinia state 里只放可展示的数据 */
let controller: AbortController | null = null;
let taskSeq = 0;

export const useEditorAiStore = defineStore('editorAi', {
  state: () => ({
    task: null as BeautifyTask | null,
  }),
  getters: {
    running: (state) => state.task?.status === 'running',
    done: (state) => state.task?.status === 'done',
    /** 胶囊是否该出现：收起了，或正在等编辑页接管「查看」请求 */
    pillVisible: (state) => Boolean(state.task && (state.task.minimized || state.task.pendingOpen)),
  },
  actions: {
    /** 开始一次全文美化；返回 false 表示当前页面还没准备好 */
    start(input: { pageId: string; pageTitle: string; source: string }): boolean {
      if (!input.pageId) return false;
      controller?.abort();
      const ctrl = new AbortController();
      controller = ctrl;
      const task: BeautifyTask = {
        id: ++taskSeq,
        pageId: input.pageId,
        pageTitle: input.pageTitle,
        source: input.source,
        status: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        result: '',
        error: '',
        minimized: false,
        pendingOpen: false,
      };
      this.task = task;
      void this.run(task.id, ctrl);
      return true;
    },

    async run(id: number, ctrl: AbortController) {
      const task = this.task;
      if (!task || task.id !== id) return;
      try {
        const result = await requestEditorAi(
          { task: 'beautify', title: task.pageTitle, document: task.source },
          ctrl.signal,
        );
        if (!this.task || this.task.id !== id) return;
        this.task.result = result.text;
        this.task.status = 'done';
        this.task.finishedAt = Date.now();
        // 对话框开着时由预览区反馈；收起成胶囊时才需要额外提醒
        if (this.task.minimized) notify.success('全文美化已完成，点右下角胶囊查看预览');
      } catch (error) {
        if (!this.task || this.task.id !== id) return;
        if (isEditorAiAbort(error)) return;
        this.task.status = 'failed';
        this.task.error = editorAiErrorMessage(error);
        this.task.finishedAt = Date.now();
        if (this.task.minimized) notify.error(`全文美化失败：${this.task.error}`);
      }
    },

    /** 收起为胶囊：任务继续，不 abort */
    minimize() {
      if (this.task) this.task.minimized = true;
    },

    /** 胶囊点了「查看」：由编辑页消费 pendingOpen 并打开对话框 */
    requestOpen() {
      if (!this.task) return;
      this.task.minimized = false;
      this.task.pendingOpen = true;
    },

    consumePendingOpen(pageId: string): boolean {
      const task = this.task;
      if (!task || task.pageId !== pageId || !task.pendingOpen) return false;
      task.pendingOpen = false;
      return true;
    },

    /** 用户主动停止（胶囊 ✕ / 对话框「停止」）：abort 并清掉 */
    cancel(silent = false) {
      controller?.abort();
      controller = null;
      const had = Boolean(this.task);
      this.task = null;
      if (!silent && had) notify.info('已取消 AI 全文美化');
    },

    /** 放弃结果 / 关闭胶囊：不提示，不 abort（通常已经结束） */
    clear() {
      controller = null;
      this.task = null;
    },
  },
});
