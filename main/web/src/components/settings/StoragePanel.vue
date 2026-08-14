<template>
  <section class="settings-panel settings-native trash-section">
    <div class="panel-head">
      <div>
        <h3>存储空间</h3>
        <p>
          {{ trashLoading ? '正在读取回收站...' : `回收站中有 ${trashItems.length} 个项目，共 ${formatBytes(trashTotalSize)}` }}
        </p>
      </div>
      <button class="btn danger" type="button" :disabled="trashLoading || !trashItems.length" @click="emptyTrash">
        <Icon name="trash" :size="14" />
        清空回收站
      </button>
    </div>

    <div class="trash-tools">
      <label class="trash-select-all">
        <input
          type="checkbox"
          :checked="allVisibleTrashSelected"
          :disabled="!filteredTrash.length"
          @change="toggleAllTrash"
        />
        <span>全选</span>
      </label>
      <input v-model="trashQuery" class="trash-filter" placeholder="筛选名称或原路径" aria-label="筛选回收站" />
      <button class="btn small" type="button" :disabled="!selectedTrash.size || trashBusy" @click="restoreSelectedTrash">
        <Icon name="restore" :size="14" />
        恢复所选
      </button>
      <button class="btn small danger" type="button" :disabled="!selectedTrash.size || trashBusy" @click="deleteSelectedTrash">
        <Icon name="trash" :size="14" />
        永久删除
      </button>
    </div>

    <div v-if="filteredTrash.length" class="trash-list">
      <div v-for="item in filteredTrash" :key="item.id" class="trash-row">
        <input
          type="checkbox"
          :checked="selectedTrash.has(item.id)"
          :aria-label="`选择 ${item.name}`"
          @change="toggleTrash(item.id)"
        />
        <Icon :name="item.kind === 'page' ? 'pages' : 'attach'" :size="16" class="trash-kind" />
        <div class="trash-main">
          <div class="trash-name-line">
            <span class="trash-name" :title="item.name">{{ item.name }}</span>
            <span v-if="item.legacy" class="legacy-tag">历史项目</span>
          </div>
          <div class="trash-meta" :title="item.originalPath">
            <span>{{ item.originalPath }}</span>
            <span>{{ formatTrashDate(item.deletedAt) }}</span>
            <span>{{ formatBytes(item.size) }}</span>
          </div>
        </div>
        <div class="trash-actions">
          <button class="icon-btn" type="button" title="恢复" aria-label="恢复" :disabled="trashBusy" @click="restoreTrash([item.id])">
            <Icon name="restore" :size="15" />
          </button>
          <button class="icon-btn danger-icon" type="button" title="永久删除" aria-label="永久删除" :disabled="trashBusy" @click="deleteTrash([item.id])">
            <Icon name="trash" :size="15" />
          </button>
        </div>
      </div>
    </div>
    <p v-else-if="trashLoading" class="trash-empty">正在读取回收站...</p>
    <p v-else class="trash-empty">{{ trashQuery ? '没有匹配的项目' : '回收站为空' }}</p>
    <p v-if="trashMsg" class="setting-message trash-message" :class="trashOk ? 'ok' : 'err'">{{ trashMsg }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import Icon from '../Icon.vue';
import { confirmDialog } from '../../lib/confirm';

interface TrashEntry {
  id: string;
  kind: 'page' | 'file';
  name: string;
  originalPath: string;
  deletedAt: string;
  size: number;
  legacy: boolean;
}

const app = useAppStore();
const trashItems = ref<TrashEntry[]>([]);
const trashTotalSize = ref(0);
const trashLoading = ref(false);
const trashBusy = ref(false);
const trashQuery = ref('');
const selectedTrash = ref(new Set<string>());
const trashMsg = ref('');
const trashOk = ref(true);

const filteredTrash = computed(() => {
  const query = trashQuery.value.trim().toLowerCase();
  if (!query) return trashItems.value;
  return trashItems.value.filter((item) =>
    item.name.toLowerCase().includes(query) || item.originalPath.toLowerCase().includes(query)
  );
});
const allVisibleTrashSelected = computed(() =>
  filteredTrash.value.length > 0 && filteredTrash.value.every((item) => selectedTrash.value.has(item.id))
);

function formatBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatTrashDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toggleTrash(id: string) {
  const next = new Set(selectedTrash.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedTrash.value = next;
}

function toggleAllTrash() {
  const next = new Set(selectedTrash.value);
  if (allVisibleTrashSelected.value) {
    filteredTrash.value.forEach((item) => next.delete(item.id));
  } else {
    filteredTrash.value.forEach((item) => next.add(item.id));
  }
  selectedTrash.value = next;
}

async function loadTrash() {
  trashLoading.value = true;
  try {
    const { data } = await api.get('/api/trash');
    trashItems.value = data.items;
    trashTotalSize.value = data.totalSize;
    const available = new Set(trashItems.value.map((item) => item.id));
    selectedTrash.value = new Set([...selectedTrash.value].filter((id) => available.has(id)));
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '回收站读取失败';
  } finally {
    trashLoading.value = false;
  }
}

async function restoreTrash(ids: string[]) {
  if (!ids.length || trashBusy.value) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.post('/api/trash/restore', { ids });
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已恢复 ${data.restored.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已恢复 ${data.restored.length} 个项目`;
    app.bumpSidebar();
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '恢复失败';
  } finally {
    trashBusy.value = false;
  }
}

function restoreSelectedTrash() {
  return restoreTrash([...selectedTrash.value]);
}

async function deleteTrash(ids: string[]) {
  if (!ids.length || trashBusy.value) return;
  const first = await confirmDialog({
    title: '永久删除',
    message: `将永久删除选中的 ${ids.length} 个项目，此操作不可撤销。继续？`,
    confirmText: '永久删除',
    danger: true,
  });
  if (!first) return;
  const second = await confirmDialog({
    title: '最后一次确认',
    message: '真的要永久删除吗？',
    confirmText: '永久删除',
    danger: true,
  });
  if (!second) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.delete('/api/trash', { data: { ids } });
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已删除 ${data.deleted.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已永久删除 ${data.deleted.length} 个项目`;
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '永久删除失败';
  } finally {
    trashBusy.value = false;
  }
}

function deleteSelectedTrash() {
  return deleteTrash([...selectedTrash.value]);
}

async function emptyTrash() {
  if (trashBusy.value || !trashItems.value.length) return;
  const first = await confirmDialog({
    title: '清空回收站',
    message: `将永久删除回收站中的 ${trashItems.value.length} 个项目，此操作不可撤销。继续？`,
    confirmText: '清空回收站',
    danger: true,
  });
  if (!first) return;
  const second = await confirmDialog({
    title: '最后一次确认',
    message: '真的要清空回收站吗？',
    confirmText: '清空回收站',
    danger: true,
  });
  if (!second) return;
  trashBusy.value = true;
  trashMsg.value = '';
  try {
    const { data } = await api.delete('/api/trash/all');
    trashOk.value = data.errors.length === 0;
    trashMsg.value = data.errors.length
      ? `已删除 ${data.deleted.length} 个，${data.errors.length} 个失败：${data.errors[0].error}`
      : `已清空 ${data.deleted.length} 个项目`;
    await loadTrash();
  } catch (e: any) {
    trashOk.value = false;
    trashMsg.value = e.response?.data?.error || '清空回收站失败';
  } finally {
    trashBusy.value = false;
  }
}

onMounted(loadTrash);
</script>

<style scoped>
.trash-tools {
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  margin: 18px 24px 0;
}
.trash-select-all {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.trash-filter {
  min-width: 0;
  width: 100%;
}
.trash-list {
  max-height: 520px;
  overflow-y: auto;
  margin: 12px 24px 24px;
  border-top: 1px solid var(--border);
}
.trash-row {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--border);
}
.trash-kind {
  color: var(--text-faint);
}
.trash-main {
  min-width: 0;
}
.trash-name-line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.trash-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legacy-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 7px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 9px;
}
.trash-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  margin-top: 3px;
  color: var(--text-faint);
  font-size: 10px;
}
.trash-meta span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trash-meta span:not(:first-child) {
  flex-shrink: 0;
}
.trash-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.trash-empty {
  margin: 24px;
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
}
.trash-message {
  margin: -12px 24px 22px;
}

@media (max-width: 768px) {
  .trash-tools {
    grid-template-columns: auto minmax(0, 1fr);
    margin: 16px 18px 0;
  }
  .trash-tools .btn {
    width: 100%;
  }
  .trash-list {
    margin: 12px 18px 20px;
  }
}

@media (max-width: 640px) {
  .trash-tools {
    grid-template-columns: 1fr 1fr;
  }
  .trash-select-all,
  .trash-filter {
    grid-column: 1 / -1;
  }
  .trash-row {
    grid-template-columns: auto auto minmax(0, 1fr);
  }
  .trash-actions {
    grid-column: 2 / -1;
    justify-content: flex-end;
  }
  .trash-meta {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
  }
  .trash-meta span:first-child {
    grid-column: 1 / -1;
  }
}
</style>
