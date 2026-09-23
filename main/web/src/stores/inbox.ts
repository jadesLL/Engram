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
  status: 'pending' | 'converted';
  derivedPath: string | null;
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
  const maxFileMb = ref(2048);
  const loading = ref(false);
  const loaded = ref(false);
  const error = ref('');
  const uploading = ref<InboxUpload[]>([]);

  const pendingItems = computed(() => items.value.filter((item) => item.status === 'pending'));

  /** 拉取列表；失败时保留上次结果并把错误交给界面展示 */
  async function load(): Promise<void> {
    loading.value = true;
    try {
      const { data } = await api.get('/api/inbox/items');
      items.value = data.items || [];
      counts.value = data.counts || counts.value;
      maxFileMb.value = data.maxFileMb || maxFileMb.value;
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

  /** 移除一份文件（进回收站，可恢复） */
  async function remove(path: string): Promise<void> {
    await api.delete('/api/inbox/items', { data: { path } });
    await load();
  }

  return {
    items,
    counts,
    maxFileMb,
    loading,
    loaded,
    error,
    uploading,
    pendingItems,
    load,
    upload,
    remove,
  };
});
