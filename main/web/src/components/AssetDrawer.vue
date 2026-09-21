<template>
  <Teleport to="body">
    <template v-if="state.open">
      <div class="asset-mask" @click="closeAssetDrawer" />
      <aside class="asset-drawer" role="dialog" aria-label="图片资产">
        <header class="asset-head">
          <div class="asset-crumb">
            <span>{{ sectionLabel }}</span>
            <span class="sep">›</span>
            <span class="cur">{{ state.parentTitle }}</span>
            <span class="sep">›</span>
            <span>图片资产</span>
          </div>
          <div class="asset-title">
            <h3>图片资产</h3>
            <span class="cnt">
              {{ state.assets.length }} 张<template v-if="totalSize"> · {{ totalSize }}</template>
            </span>
            <span class="spacer" />
            <button class="icon-btn" v-tooltip="'关闭'" aria-label="关闭" @click="closeAssetDrawer">
              <Icon name="x" :size="16" />
            </button>
          </div>
          <div v-if="state.assets.length" class="asset-filters">
            <button
              v-for="chip in chips"
              :key="chip.key"
              class="chip"
              :class="{ on: filter === chip.key }"
              type="button"
              @click="filter = chip.key"
            >
              {{ chip.label }} {{ chip.count }}
            </button>
          </div>
        </header>

        <div class="asset-body">
          <p v-if="state.loading" class="asset-hint">正在读取图片…</p>
          <p v-else-if="state.error" class="asset-hint error">{{ state.error }}</p>
          <AppEmptyState
            v-else-if="!state.assets.length"
            icon="image"
            title="这份内容还没有图片"
            hint="在编辑器里粘贴或拖入图片，它就会成为这份内容的资产，只在这里可见。"
          />
          <AppEmptyState
            v-else-if="!visible.length"
            icon="image"
            title="没有匹配的图片"
            hint="换个筛选条件看看。"
          />
          <div v-else class="asset-wall">
            <figure v-for="item in visible" :key="item.path" class="asset-card">
              <button
                class="shot"
                type="button"
                :aria-label="`预览 ${displayName(item.name)}`"
                @click="state.previewUrl = item.url"
              >
                <img :src="item.url" :alt="displayName(item.name)" loading="lazy" />
                <span v-if="!item.referenced" class="badge orphan">未被引用</span>
                <span v-else-if="item.sourceUrl" class="badge remote">外链已归档</span>
              </button>
              <figcaption class="meta">
                <span class="nm" v-tooltip.auto="item.name">{{ displayName(item.name) }}</span>
                <span class="sub">
                  {{ formatAssetSize(item.size) }}
                  <template v-if="item.sourceUrl"> · 原出处已记录</template>
                  <template v-else-if="!item.referenced"> · 正文里已无引用</template>
                </span>
                <span class="acts">
                  <button type="button" @click="state.previewUrl = item.url">预览</button>
                  <a :href="item.url" :download="item.name">另存</a>
                  <button type="button" class="danger" @click="remove(item)">删除</button>
                </span>
              </figcaption>
            </figure>
          </div>
        </div>

        <footer class="asset-foot">
          <Icon name="image" :size="13" />
          <span>这些图片属于「{{ state.parentTitle }}」，不会出现在目录树、知识图谱或搜索结果里。</span>
        </footer>
      </aside>

      <div v-if="state.previewUrl" class="asset-preview" @click.self="closeAssetPreview">
        <button class="preview-close" v-tooltip="'关闭预览'" aria-label="关闭预览" @click="closeAssetPreview">
          <Icon name="x" :size="18" />
        </button>
        <ImageViewer :url="state.previewUrl" />
      </div>
    </template>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';
import ImageViewer from './ImageViewer.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import { confirmDialog } from '../lib/confirm';
import {
  assetDrawerState as state,
  closeAssetDrawer,
  closeAssetPreview,
  deleteAsset,
  formatAssetSize,
  type AssetItem,
} from '../lib/assetDrawer';

type FilterKey = 'all' | 'referenced' | 'orphan';
const filter = ref<FilterKey>('all');

// 换父项时把筛选复位，避免上一份内容的筛选状态串到下一份
watch(() => state.parentId, () => { filter.value = 'all'; });

const orphanCount = computed(() => state.assets.filter((item) => !item.referenced).length);
const chips = computed(() => [
  { key: 'all' as const, label: '全部', count: state.assets.length },
  { key: 'referenced' as const, label: '正文引用', count: state.assets.length - orphanCount.value },
  { key: 'orphan' as const, label: '未引用', count: orphanCount.value },
]);

const visible = computed(() => {
  if (filter.value === 'referenced') return state.assets.filter((item) => item.referenced);
  if (filter.value === 'orphan') return state.assets.filter((item) => !item.referenced);
  return state.assets;
});

const totalSize = computed(() => {
  const bytes = state.assets.reduce((sum, item) => sum + item.size, 0);
  return bytes ? formatAssetSize(bytes) : '';
});

/** 面包屑首段：Wiki 页面按类型叫「页面」，原始资料 md 叫「原始资料」 */
const sectionLabel = computed(() =>
  state.parentPath.startsWith('原始资料/') ? '原始资料' : '页面'
);

async function remove(item: AssetItem) {
  const ok = await confirmDialog({
    title: '删除图片',
    message: `将删除「${displayName(item.name)}」。如果正文里还引用着它，那一处会变成裂图。继续？`,
    confirmText: '删除',
  });
  if (!ok) return;
  await deleteAsset(item);
}

/** 磁盘上的文件名带内容哈希前缀（去重与 immutable 缓存需要），展示时去掉更干净；
 *  「另存」仍用真实文件名，方便和 assets/ 目录里的文件对上。 */
function displayName(name: string): string {
  return name.replace(/^[0-9a-f]{8}-/, '');
}
</script>

<style scoped>
.asset-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-mask);
  background: rgba(0, 0, 0, 0.28);
}

.asset-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-drawer);
  width: min(430px, 100vw);
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--card-bg);
  box-shadow: var(--shadow-dialog);
}

.asset-head {
  flex-shrink: 0;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--border);
}

.asset-crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--text-faint);
  font-size: 11.5px;
  min-width: 0;
}
.asset-crumb .sep { opacity: 0.6; }
.asset-crumb .cur {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.asset-title h3 { margin: 0; font-size: 14px; font-weight: 650; }
.asset-title .cnt { color: var(--text-faint); font-size: 12px; }
.asset-title .spacer { flex: 1; }

.icon-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--text-secondary);
}
.icon-btn:hover { color: var(--text); background: var(--bg-hover); }

.asset-filters {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.chip {
  height: 25px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 20px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.chip:hover { background: var(--bg-tertiary); }
.chip.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
  font-weight: 600;
}

.asset-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 18px;
}

.asset-hint { margin: 6px 0; color: var(--text-faint); font-size: 12.5px; }
.asset-hint.error { color: var(--danger); }

.asset-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 13px;
}

.asset-card {
  margin: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  overflow: hidden;
}
.asset-card:hover { border-color: var(--accent); box-shadow: var(--shadow-raised); }

.shot {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  padding: 0;
  border: 0;
  background: var(--bg-tertiary);
  cursor: zoom-in;
}
.shot img { width: 100%; height: 100%; object-fit: cover; display: block; }

.badge {
  position: absolute;
  left: 7px;
  top: 7px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 650;
  color: #fff;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(4px);
}
.badge.orphan { background: rgba(196, 43, 28, 0.85); }
.badge.remote { background: rgba(15, 108, 189, 0.85); }

.meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 9px 9px;
  min-width: 0;
}
.nm {
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  color: var(--text-faint);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acts {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.acts button,
.acts a {
  height: 22px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-secondary);
  text-decoration: none;
  cursor: pointer;
}
.acts button:hover,
.acts a:hover { background: var(--bg-tertiary); color: var(--text); }
.acts button.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: transparent;
}

.asset-foot {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.5;
}

.asset-preview {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.72);
}
.asset-preview :deep(.image-viewer) { width: min(1100px, 92vw); height: min(760px, 88vh); }
.preview-close {
  position: absolute;
  top: 18px;
  right: 20px;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.preview-close:hover { background: rgba(255, 255, 255, 0.24); }

@media (max-width: 768px) {
  .asset-drawer { width: 100vw; }
}
</style>
