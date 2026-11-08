<template>
  <SettingsGroup
    anchor="storage-trash"
    class="settings-native"
    title="回收站"
    hint="误删的内容可恢复，也可永久删除"
    flush
  >
    <span v-if="trashLoading" class="setting-value trash-summary">正在读取回收站…</span>
    <span v-else-if="trashItems.length" class="setting-value trash-summary">{{ trashItems.length }} 个项目 · 共 {{ formatBytes(trashTotalSize) }}</span>
    <p v-else class="setting-note">回收站为空，删除的内容会先放这里。</p>

    <template v-if="trashItems.length">
      <div class="trash-tools">
        <input v-model="trashQuery" class="trash-filter" placeholder="筛选名称或原路径" aria-label="筛选回收站" />
        <label class="trash-select-all">
          <input
            type="checkbox"
            :checked="allVisibleTrashSelected"
            :disabled="!filteredTrash.length"
            @change="toggleAllTrash"
          />
          <span>全选</span>
        </label>
        <button class="btn" type="button" :disabled="!selectedTrash.size || trashBusy" @click="restoreSelectedTrash">
          <Icon name="restore" :size="14" />
          恢复所选
        </button>
        <button class="btn danger" type="button" :disabled="!selectedTrash.size || trashBusy" @click="deleteSelectedTrash">
          <Icon name="trash" :size="14" />
          永久删除
        </button>
      </div>

      <div v-if="filteredTrash.length" class="trash-list">
        <div v-for="item in filteredTrash" :key="item.id" class="trash-row">
          <input
            type="checkbox"
            :checked="selectedTrash.has(item.id)"
            :aria-label="'选择 ' + item.name"
            @change="toggleTrash(item.id)"
          />
          <Icon :name="item.kind === 'page' ? 'pages' : 'attach'" :size="16" class="trash-kind" />
          <div class="trash-main">
            <div class="trash-name-line">
              <span class="trash-name" v-tooltip.auto="item.name">{{ item.name }}</span>
              <span v-if="item.legacy" class="legacy-tag">历史项目</span>
            </div>
            <div class="trash-meta" v-tooltip="item.originalPath">
              <span>{{ item.originalPath }}</span>
              <span>{{ formatTrashDate(item.deletedAt) }}</span>
              <span>{{ formatBytes(item.size) }}</span>
            </div>
          </div>
          <div class="trash-actions">
            <button class="icon-btn" type="button" v-tooltip="'恢复'" aria-label="恢复" :disabled="trashBusy" @click="restoreTrash([item.id])">
              <Icon name="restore" :size="15" />
            </button>
            <button class="icon-btn danger-icon" type="button" v-tooltip="'永久删除'" aria-label="永久删除" :disabled="trashBusy" @click="deleteTrash([item.id])">
              <Icon name="trash" :size="15" />
            </button>
          </div>
        </div>
      </div>
      <p v-else class="setting-note">没有匹配的项目。</p>
    </template>

    <p v-if="trashMsg" class="setting-message" :class="trashOk ? 'ok' : 'err'">{{ trashMsg }}</p>

    <div v-if="trashItems.length" class="setting-actions trash-footer">
      <button class="btn danger" type="button" :disabled="trashBusy" @click="emptyTrash">
        <Icon name="trash" :size="14" />
        清空回收站
      </button>
    </div>
  </SettingsGroup>

  <!-- 图片资产：图片是 md 父项的私有资产，正常入口是右击那个条目 →「查看引用图片」。
       这里只收没有归属、或父项正文已经不再引用的图片——它们是唯一的清理出口。 -->
  <SettingsGroup
    anchor="storage-assets"
    class="settings-native"
    title="图片资产"
    hint="正文没再引用的图片，可删除或重新挂载"
    flush
  >
    <div class="setting-row">
      <div class="setting-copy">
        <strong>待清理图片</strong>
        <span v-if="assetLoading">正在读取图片资产…</span>
        <span v-else-if="!orphanTotal">没有未归属或未被引用的图片。</span>
        <span v-else>未归属是散图；未被引用是正文删了引用的残留。</span>
      </div>
      <span v-if="!assetLoading" class="setting-value">{{ orphanTotal }} 张 · {{ formatBytes(orphanAssets.totalBytes) }}</span>
    </div>

    <div v-if="orphanTotal" class="trash-list asset-list">
      <div v-for="item in orphanList" :key="item.path" class="trash-row asset-row">
        <img class="asset-thumb" :src="item.url" :alt="item.name" loading="lazy" />
        <div class="trash-main">
          <div class="trash-name-line">
            <span class="trash-name" v-tooltip.auto="item.name">{{ item.name }}</span>
            <span class="legacy-tag">{{ item.unassigned ? '未归属' : '未被引用' }}</span>
          </div>
          <div class="trash-meta" v-tooltip="item.path">
            <span>{{ formatBytes(item.size) }}</span>
            <span>{{ item.unassigned ? '没有父项' : '原父项 ' + (item.parentTitle || item.parentId) }}</span>
          </div>
        </div>
        <div class="trash-actions">
          <AppSelect
            v-if="item.unassigned"
            variant="mini"
            :model-value="attachPick"
            :disabled="assetBusy"
            aria-label="挂载到"
            placeholder="挂载到…"
            :options="attachOptions"
            @change="attachAsset(item, $event)"
          />
          <button
            class="icon-btn danger-icon"
            type="button"
            v-tooltip="'删除'"
            aria-label="删除"
            :disabled="assetBusy"
            @click="deleteOrphan(item)"
          >
            <Icon name="trash" :size="15" />
          </button>
        </div>
      </div>
    </div>
    <p v-if="assetMsg" class="setting-message" :class="assetOk ? 'ok' : 'err'">{{ assetMsg }}</p>

    <div v-if="orphanTotal" class="setting-actions asset-footer">
      <button class="btn danger" type="button" :disabled="assetBusy" @click="deleteAllOrphans">
        <Icon name="trash" :size="14" />
        全部清理
      </button>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import { useAppStore } from '../../stores/app';
import Icon from '../Icon.vue';
import AppSelect from '../ui/AppSelect.vue';
import SettingsGroup from './SettingsGroup.vue';
import { confirmDialog } from '../../lib/confirm';
import { useSettingsBadge } from '../../lib/settingsBadges';

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

/* ---------- 图片资产 ---------- */

interface OrphanAsset {
  parentId: string;
  name: string;
  path: string;
  url: string;
  size: number;
  /** true = 没有父项（在 assets/_unassigned/），可挂载到某个页面 */
  unassigned: boolean;
  /** 未被引用时：原本挂在哪个页面上 */
  parentTitle?: string;
}

const orphanAssets = ref<{ unassigned: OrphanAsset[]; unreferenced: OrphanAsset[]; totalBytes: number }>({
  unassigned: [],
  unreferenced: [],
  totalBytes: 0,
});
const assetLoading = ref(false);
const assetBusy = ref(false);
const assetMsg = ref('');
const assetOk = ref(true);
/** 挂载目标下拉：所有 md 页面（Wiki 页面 + 原始资料 md） */
const attachTargets = ref<Array<{ id: string; title: string }>>([]);
/** 挂载是「选中即执行」的动作下拉，不必记住选中值，选中后仍显示占位文案 */
const attachPick = ref('');
const attachOptions = computed(() =>
  attachTargets.value.map((page) => ({ value: page.id, label: page.title })),
);

const orphanTotal = computed(
  () => orphanAssets.value.unassigned.length + orphanAssets.value.unreferenced.length
);

const orphanList = computed<OrphanAsset[]>(() => [
  ...orphanAssets.value.unassigned.map((item) => ({ ...item, unassigned: true })),
  ...orphanAssets.value.unreferenced.map((item) => ({ ...item, unassigned: false })),
]);

// 设置页二级导航的状态徽标：有多少项等着清理，不用进分类就知道
useSettingsBadge('storage-trash', computed(() => (trashItems.value.length ? `${trashItems.value.length} 项` : '')));
useSettingsBadge('storage-assets', computed(() => (orphanTotal.value ? `${orphanTotal.value} 张` : '')));

async function loadAssets() {
  assetLoading.value = true;
  try {
    const [{ data }, pagesRes] = await Promise.all([
      api.get('/api/assets/orphans/list'),
      api.get('/api/pages/list'),
    ]);
    orphanAssets.value = {
      unassigned: data.unassigned || [],
      unreferenced: data.unreferenced || [],
      totalBytes: data.totalBytes || 0,
    };
    const titleById = new Map<string, string>(
      (pagesRes.data.pages || []).map((p: any) => [String(p.id), String(p.title)])
    );
    for (const item of orphanAssets.value.unreferenced) {
      item.parentTitle = titleById.get(String(item.parentId));
    }
    attachTargets.value = (pagesRes.data.pages || [])
      .filter((p: any) => /\.(md|markdown)$/i.test(String(p.path)))
      .map((p: any) => ({ id: String(p.id), title: String(p.title) }));
  } catch (e: any) {
    assetOk.value = false;
    assetMsg.value = e.response?.data?.error || '图片资产读取失败';
  } finally {
    assetLoading.value = false;
  }
}

/** 挂载：把未归属图片移到目标页面名下，并把引用追加到该页正文末尾 */
async function attachAsset(item: OrphanAsset, parentId: string) {
  if (!parentId || assetBusy.value) return;
  assetBusy.value = true;
  assetMsg.value = '';
  try {
    const { data } = await api.post('/api/assets/attach', { name: item.name, parent: parentId });
    assetOk.value = true;
    assetMsg.value = `已挂载「${item.name}」→ ${data.parentTitle || '目标页面'}`;
    app.bumpSidebar();
    await loadAssets();
  } catch (e: any) {
    assetOk.value = false;
    assetMsg.value = e.response?.data?.error || '挂载失败';
  } finally {
    assetBusy.value = false;
  }
}

async function deleteOrphan(item: OrphanAsset) {
  if (assetBusy.value) return;
  const ok = await confirmDialog({
    title: '删除图片',
    message: `将删除「${item.name}」，此操作不可撤销。继续？`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  assetBusy.value = true;
  assetMsg.value = '';
  try {
    await api.delete('/api/assets', { data: { parentId: item.parentId, name: item.name } });
    assetOk.value = true;
    assetMsg.value = `已删除「${item.name}」`;
    await loadAssets();
  } catch (e: any) {
    assetOk.value = false;
    assetMsg.value = e.response?.data?.error || '删除失败';
  } finally {
    assetBusy.value = false;
  }
}

async function deleteAllOrphans() {
  if (assetBusy.value || !orphanTotal.value) return;
  const ok = await confirmDialog({
    title: '清理全部未引用图片',
    message: `将删除 ${orphanTotal.value} 张图片（未归属 + 未被引用），此操作不可撤销。继续？`,
    confirmText: '全部清理',
    danger: true,
  });
  if (!ok) return;
  assetBusy.value = true;
  assetMsg.value = '';
  let failed = 0;
  for (const item of orphanList.value) {
    try {
      await api.delete('/api/assets', { data: { parentId: item.parentId, name: item.name } });
    } catch {
      failed++;
    }
  }
  assetOk.value = failed === 0;
  assetMsg.value = failed ? `已删除 ${orphanTotal.value - failed} 张，${failed} 张失败` : `已清理 ${orphanTotal.value} 张图片`;
  assetBusy.value = false;
  await loadAssets();
}

onMounted(() => {
  loadTrash();
  loadAssets();
});
</script>

<style scoped>
/* 卡内列表口径：容器给边界、行之间只用细线（不再每行套框，也不再是卡中卡）。
   工具条与动作行都落在 .group-body.flush 的左右内边距里，所以自身不再加左右边距。 */
.setting-value.trash-summary {
  display: block;
  margin: 8px 0 0;
  text-align: left;
}
.trash-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 10px 0 0;
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
  flex: 1 1 200px;
  min-width: 0;
}
.trash-tools .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.trash-list {
  max-height: 520px;
  overflow-y: auto;
  margin: 12px 0 0;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
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
.trash-row:last-child {
  border-bottom: 0;
}
.asset-row {
  grid-template-columns: auto minmax(0, 1fr) auto;
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
.asset-thumb {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border-radius: 6px;
  border: 1px solid var(--border);
  object-fit: cover;
  background: var(--bg-tertiary);
}
/* 行内结果提示与卡底动作行的纵向间距（左右留白由 .group-body 统一给） */
.settings-native .setting-message {
  margin: 8px 0 6px;
}
.trash-footer,
.asset-footer {
  margin: 12px 0 4px;
}

@media (max-width: 768px) {
  .trash-filter {
    flex-basis: 100%;
  }
  .trash-tools .btn {
    flex: 1 1 auto;
    justify-content: center;
    min-height: 40px;
  }
}

@media (max-width: 640px) {
  .trash-row {
    grid-template-columns: auto auto minmax(0, 1fr);
  }
  .asset-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .trash-actions {
    grid-column: 2 / -1;
    justify-content: flex-end;
  }
  .asset-row .trash-actions {
    grid-column: 1 / -1;
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
