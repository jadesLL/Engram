<template>
  <AppModal :open="open" title="从收集箱添加文件" :close-on-mask="false" @close="emit('close')">
    <template #subtitle>
      <p class="picker-sub">选中后随这条消息交给 Agent 处理；文件本身不会移动，也不会入库。</p>
    </template>

    <div class="picker">
      <div class="picker-search">
        <Icon name="search" :size="13" />
        <input
          v-model="query"
          type="text"
          placeholder="搜索文件名或路径"
          aria-label="搜索收集箱文件"
        />
      </div>

      <p v-if="inbox.loading && !inbox.loaded" class="picker-state"><AppSpinner :size="13" /> 正在读取收集箱…</p>
      <p v-else-if="inbox.error" class="picker-state error">{{ inbox.error }}</p>
      <p v-else-if="!inbox.items.length" class="picker-state">
        收集箱还是空的：可以把文件拖到收集箱页面，或直接在内置 Agent 输入区点附件上传。
      </p>
      <p v-else-if="!visible.length" class="picker-state">没有匹配「{{ query.trim() }}」的文件。</p>

      <div v-else class="picker-list" role="group" aria-label="收集箱文件">
        <button
          v-for="item in visible"
          :key="item.path"
          class="picker-row"
          :class="{ picked: picked.has(item.path) }"
          type="button"
          :aria-pressed="picked.has(item.path)"
          @click="toggle(item)"
        >
          <span class="picker-check" aria-hidden="true">
            <Icon v-if="picked.has(item.path)" name="check" :size="11" />
          </span>
          <span class="picker-main">
            <b class="picker-name">{{ item.name }}</b>
            <span class="picker-meta">
              <span v-if="item.rel && item.rel !== item.name" class="picker-path">{{ item.rel }}</span>
              <span>{{ formatSize(item.size) }}</span>
              <span class="picker-status" :class="item.status">{{ statusLabel(item) }}</span>
            </span>
          </span>
        </button>
      </div>
    </div>

    <template #footer>
      <button class="btn small" type="button" @click="emit('close')">取消</button>
      <button class="btn primary small" type="button" :disabled="!pickedFiles.length" @click="confirmPick">
        添加 {{ pickedFiles.length ? pickedFiles.length + ' 份' : '文件' }}
      </button>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppModal from './ui/AppModal.vue';
import AppSpinner from './ui/AppSpinner.vue';
import Icon from './Icon.vue';
import { useInboxStore, type InboxItem } from '../stores/inbox';
import { chatInboxFileFromPath } from '../lib/chatInboxFiles';
import type { ChatInboxFile } from '../stores/chat';

/**
 * 从收集箱挑选文件作为这条消息的上下文。
 *
 * 只读收集箱列表（`/api/inbox/items` 的目录实时扫描），不移动/转换/入库；
 * 选中项由 ChatDrawer 转成附件 chip，与刚上传的文件走同一条上下文通道。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; pick: [files: ChatInboxFile[]] }>();

const inbox = useInboxStore();
const query = ref('');
const picked = ref<Set<string>>(new Set());

/** 每次打开都重新拉一次列表：抽屉可能开着，收集箱在别处（拖入/同步）刚有变化 */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    query.value = '';
    picked.value = new Set();
    void inbox.load();
  },
  { immediate: true }
);

const visible = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return inbox.items;
  return inbox.items.filter((item) =>
    `${item.name} ${item.rel} ${item.path}`.toLowerCase().includes(keyword)
  );
});

const pickedFiles = computed<ChatInboxFile[]>(() => {
  const files: ChatInboxFile[] = [];
  for (const item of inbox.items) {
    if (!picked.value.has(item.path)) continue;
    const file = chatInboxFileFromPath(item.path, 'inbox', item.name);
    if (file) files.push(file);
  }
  return files;
});

function toggle(item: InboxItem) {
  const next = new Set(picked.value);
  if (next.has(item.path)) next.delete(item.path);
  else next.add(item.path);
  picked.value = next;
}

function confirmPick() {
  if (!pickedFiles.value.length) return;
  emit('pick', pickedFiles.value);
  emit('close');
}

/** 与服务端收集箱列表同一档状态口径（转换产物是否存在以磁盘为准） */
function statusLabel(item: InboxItem): string {
  if (item.status === 'converting') return '转换中';
  if (item.status === 'converted') return '已转换';
  if (item.status === 'failed') return '转换失败';
  return '待整理';
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
</script>

<style scoped>
.picker-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--faint);
  line-height: 1.45;
}

.picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

.picker-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--faint);
  background: var(--bg-sunken, transparent);
}

.picker-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
}

.picker-state {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 2px 10px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--faint);
}

.picker-state.error {
  color: var(--danger, #c0392b);
}

.picker-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(420px, 52vh);
  overflow-y: auto;
  padding-right: 2px;
}

.picker-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.picker-row:hover {
  background: var(--hover, rgba(127, 127, 127, 0.08));
}

.picker-row.picked {
  border-color: var(--accent, #4d8aff);
  background: var(--accent-soft, rgba(77, 138, 255, 0.08));
}

.picker-check {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--accent, #4d8aff);
}

.picker-row.picked .picker-check {
  border-color: var(--accent, #4d8aff);
}

.picker-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.picker-name {
  font-size: 13px;
  font-weight: 500;
  word-break: break-all;
}

.picker-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 11.5px;
  color: var(--faint);
}

.picker-path {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-status.pending { color: var(--faint); }
.picker-status.converting { color: var(--accent, #4d8aff); }
.picker-status.converted { color: var(--success, #2e9e6b); }
.picker-status.failed { color: var(--danger, #c0392b); }
</style>
