import { reactive } from 'vue';
import { api } from '../api';
import { notify } from './notify';

/**
 * 页面图片资产抽屉的全局状态。
 *
 * 图片是 md 父项（Wiki 页面 / 原始资料 md）的私有资产，没有全局图片视图：
 * 唯一入口是侧栏里右击那个父项 →「查看引用图片」。抽屉挂在 App.vue 上（Teleport 到 body），
 * 这样任何视图都能开它，不用把组件层层往下传。
 */

export interface AssetItem {
  name: string;
  /** 正文里该写的引用：/media/<parentId>/<name> */
  url: string;
  /** brain 相对路径：assets/<parentId>/<name> */
  path: string;
  ext: string;
  mime: string;
  size: number;
  updatedAt: string;
  /** 父项正文是否引用了它；false = 孤儿，可清理 */
  referenced: boolean;
  /** 外链本地化时保留的原出处 */
  sourceUrl?: string;
}

export const assetDrawerState = reactive({
  open: false,
  parentId: '',
  parentTitle: '',
  /** 父项在 brain 内的路径（面包屑用） */
  parentPath: '',
  assets: [] as AssetItem[],
  /** 正文里还没本地化成功的外链图 URL（抓取失败时正文保留外链，这里给用户一个交代） */
  remoteImages: [] as string[],
  loading: false,
  retrying: false,
  error: '',
  /** 当前预览的大图 URL（空 = 不显示查看器） */
  previewUrl: '',
});

export function closeAssetDrawer(): void {
  assetDrawerState.open = false;
  assetDrawerState.previewUrl = '';
}

export function closeAssetPreview(): void {
  assetDrawerState.previewUrl = '';
}

export async function reloadAssetDrawer(): Promise<void> {
  const parentId = assetDrawerState.parentId;
  if (!parentId) return;
  assetDrawerState.loading = true;
  assetDrawerState.error = '';
  try {
    const { data } = await api.get(`/api/assets/${encodeURIComponent(parentId)}`);
    // 请求返回时抽屉可能已经切到别的父项，丢弃过期响应
    if (assetDrawerState.parentId !== parentId) return;
    assetDrawerState.assets = data.assets || [];
    assetDrawerState.remoteImages = data.remoteImages || [];
  } catch (error: any) {
    assetDrawerState.error = error?.response?.data?.error || '图片资产读取失败';
  } finally {
    if (assetDrawerState.parentId === parentId) assetDrawerState.loading = false;
  }
}

/** 手动重试外链图片本地化：正文里还挂着外链时用户能自己再拉一次，失败原因直接显示出来 */
export async function retryRemoteImages(): Promise<void> {
  const parentId = assetDrawerState.parentId;
  if (!parentId || assetDrawerState.retrying) return;
  assetDrawerState.retrying = true;
  try {
    const { data } = await api.post('/api/assets/localize', { parent: parentId });
    if (data.localized) {
      notify.success(`已把 ${data.localized} 张外链图存为本地资产`);
    } else if (data.failed?.length) {
      notify.error(`仍抓不到：${data.failed[0].reason}`);
    } else {
      notify.info('正文里已经没有外链图了');
    }
    await reloadAssetDrawer();
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '本地化失败');
  } finally {
    assetDrawerState.retrying = false;
  }
}

export async function openAssetDrawer(parent: {
  id?: string;
  title?: string;
  path?: string;
}): Promise<void> {
  const id = String(parent?.id || '');
  if (!id) return;
  assetDrawerState.open = true;
  assetDrawerState.parentId = id;
  assetDrawerState.parentTitle = parent.title || '图片资产';
  assetDrawerState.parentPath = parent.path || '';
  assetDrawerState.assets = [];
  assetDrawerState.remoteImages = [];
  assetDrawerState.error = '';
  await reloadAssetDrawer();
}

export async function deleteAsset(item: AssetItem): Promise<boolean> {
  const parentId = assetDrawerState.parentId;
  if (!parentId) return false;
  try {
    await api.delete('/api/assets', { data: { parentId, name: item.name } });
    notify.success('图片已删除');
    await reloadAssetDrawer();
    return true;
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '删除失败');
    return false;
  }
}

export function formatAssetSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
