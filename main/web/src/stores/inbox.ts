import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api';

/**
 * 收集箱：拖进来的文件先落在这里，属于「待整理 / 待转换」的暂存资产。
 *
 * 界面只读服务端的目录扫描结果（`/api/inbox/items`）——收集箱不维护额外状态表，
 * 转换产物的有无直接由磁盘推导，因此多端同步落地后刷新一次即可看到一致状态。
 */

export interface InboxItem {
  /** vault 相对路径，如 收集箱/合同.pdf */
  path: string;
  name: string;
  /** 相对收集箱根的子路径 */
  rel: string;
  ext: string;
  size: number;
  mtime: number;
  category: string;
  status: 'pending' | 'converting' | 'converted' | 'failed';
  /** 转换产物的 vault 路径；为 null 表示还没有产物 */
  derivedPath: string | null;
  /** 服务端对这个格式的转换能力：office/pdf/text 能转，agent-only/unsupported 不能 */
  capability: 'office' | 'pdf' | 'text' | 'agent-only' | 'unsupported';
  /** 不能转换时的原因（可直接显示给用户）；能转时是空串 */
  hint: string;
  /** 最近一次转换失败的原因 */
  error: string;
  /** 转换任务 id；null 表示这份文件还没有转换任务 */
  jobId: number | null;
  /** 最近一次转换的 Agent 对话 */
  assistantSessionId: string | null;
}

/** POST /api/inbox/convert 的回执：哪些进了队列、哪些被跳过及原因 */
export interface InboxConversion {
  queued: { path: string; jobId: number; sessionId: string }[];
  skipped: { path: string; reason: string }[];
}

/** GET /api/inbox/derived 的产物：转换出的 Markdown 全文 */
export interface InboxDerived {
  path: string;
  derivedPath: string;
  markdown: string;
  chars: number;
}

/** POST /api/inbox/adopt 的结果：产物在知识库里的落点 */
export interface InboxAdoption {
  pageId: string;
  pagePath: string;
  pageTitle: string;
  source: string;
}

export interface InboxCounts {
  all: number;
  pending: number;
  converted: number;
  converting: number;
  failed: number;
}

export interface InboxUpload {
  name: string;
  loaded: number;
  total: number;
}

export const useInboxStore = defineStore('inbox', () => {
  const items = ref<InboxItem[]>([]);
  const counts = ref<InboxCounts>({ all: 0, pending: 0, converted: 0, converting: 0, failed: 0 });
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref('');
  const uploading = ref<InboxUpload[]>([]);
  /**
   * 本会话内已入库的路径。服务端没有「已入库」这个状态——入库后原件仍在收集箱里，
   * 重新扫描也看不出区别，所以只在本地记住，用来拦住同一行的重复入库。
   */
  const adopted = ref<Set<string>>(new Set());

  const pendingItems = computed(() => items.value.filter((item) => item.status === 'pending'));

  /** 拉取列表；失败时保留上次结果并把错误交给界面展示 */
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const { data } = await api.get('/api/inbox/items');
      items.value = data.items || [];
      counts.value = data.counts || counts.value;
      error.value = '';
      loaded.value = true;
    } catch (err: any) {
      error.value = err?.response?.data?.error || err?.message || '收集箱读取失败';
    } finally {
      loading.value = false;
    }
  }

  /**
   * 上传：逐个文件走一次请求，单个文件单独报进度与错误——
   * 批量里某一份超限或失败，不应该让整批的进度都变得不可读。
   */
  async function upload(files: File[] | FileList, dir = ''): Promise<{ saved: number; skipped: string[] }> {
    const list = Array.from(files);
    let saved = 0;
    const skipped: string[] = [];
    for (const file of list) {
      const progress: InboxUpload = { name: file.name, loaded: 0, total: file.size };
      uploading.value = [...uploading.value, progress];
      const form = new FormData();
      form.append('files', file);
      if (dir) form.append('dir', dir);
      try {
        const { data } = await api.post('/api/inbox/upload', form, {
          onUploadProgress: (event) => {
            progress.loaded = event.loaded || 0;
            progress.total = event.total || file.size;
            uploading.value = [...uploading.value];
          },
        });
        saved += (data.saved || []).length;
        for (const item of data.skipped || []) skipped.push(`${item.name}：${item.reason}`);
      } catch (err: any) {
        skipped.push(`${file.name}：${err?.response?.data?.error || err?.message || '上传失败'}`);
      } finally {
        uploading.value = uploading.value.filter((entry) => entry !== progress);
      }
    }
    await load();
    return { saved, skipped };
  }

  /** 直接按网址抓取网页 HTML，保存成收集箱原件。 */
  async function fetchUrl(url: string): Promise<InboxItem> {
    const { data } = await api.post('/api/inbox/fetch-url', { url });
    await load();
    return data.saved as InboxItem;
  }

  /**
   * 排队转换：paths 指定文件，'all' 交给服务端自己挑可转项。
   * 转换是服务端队列在跑，这里拿到的只是「已受理」的回执，所以立刻刷新一次列表，
   * 让界面马上出现 converting 状态（后续进度由视图侧的轮询接手）。
   */
  async function convert(paths: string[] | 'all'): Promise<InboxConversion> {
    const body = paths === 'all' ? { all: true } : { paths };
    const { data } = await api.post('/api/inbox/convert', body);
    const result: InboxConversion = {
      queued: Array.isArray(data?.queued) ? data.queued : [],
      skipped: Array.isArray(data?.skipped) ? data.skipped : [],
    };
    await load();
    return result;
  }

  /** 读取转换产物的 Markdown 全文；还没有产物时服务端 404，交给调用方提示 */
  async function loadDerived(path: string): Promise<InboxDerived> {
    const { data } = await api.get('/api/inbox/derived', { params: { path } });
    return data as InboxDerived;
  }

  /** 入库：把产物收进知识库，成为可检索、可引用的页面（原件仍留在收集箱） */
  async function adopt(path: string): Promise<InboxAdoption> {
    const { data } = await api.post('/api/inbox/adopt', { path });
    adopted.value.add(path);
    await load();
    return data as InboxAdoption;
  }

  /** 移除一份文件（进回收站，可恢复） */
  async function remove(path: string): Promise<void> {
    await api.delete('/api/inbox/items', { data: { path } });
    // 同名文件之后可能被重新拖进来，那一份是新的，不该继承「已入库」的标记
    adopted.value.delete(path);
    await load();
  }

  return {
    items,
    counts,
    loading,
    loaded,
    error,
    uploading,
    adopted,
    pendingItems,
    load,
    upload,
    fetchUrl,
    remove,
    convert,
    loadDerived,
    adopt,
  };
});
