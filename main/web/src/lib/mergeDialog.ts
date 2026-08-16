import { reactive } from 'vue';

/** 合并对话框共享状态：右键页面行触发，在 MergeDialog.vue 中消费 */
export const mergeState = reactive<{
  open: boolean;
  source: { id: string; title: string; type: string; path: string } | null;
}>({
  open: false,
  source: null,
});

export function openMergeDialog(source: { id: string; title: string; type: string; path: string }) {
  mergeState.source = source;
  mergeState.open = true;
}

export function closeMergeDialog() {
  mergeState.open = false;
  mergeState.source = null;
}
