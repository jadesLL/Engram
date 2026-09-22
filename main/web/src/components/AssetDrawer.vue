<template>
  <Teleport to="body">
    <!-- 悬浮玻璃卡片：与 Agent 卡片同一材质，不再压一层全屏遮罩——正文照常可见可点，
         换一份内容不用先关卡片（关闭走 ✕ 或 Esc）。
         v-if 必须挂在 transition 的子节点上，挂外层会让卡片被整块移除、开合动画不播。 -->
    <transition name="asset-slide">
      <aside
        v-if="state.open"
        class="asset-drawer"
        role="dialog"
        aria-label="图片资产"
        :style="{ right: `${cardRight}px` }"
      >
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
          <!-- 正文里还有外链图没落成本地：抓取失败时正文保留外链，不提示的话用户
               只会看到「图没存下来」而不知道为什么，也没法重试 -->
          <div v-if="state.remoteImages.length" class="remote-warn">
            <Icon name="link" :size="14" />
            <div class="remote-warn-text">
              <b>正文里还有 {{ state.remoteImages.length }} 张外链图没有存到本地</b>
              <span>Engram 会在正文变动和每次启动时自动抓取；抓不到（对方防盗链 / 离线 / 图片已失效）就保留外链。也可以现在重试。</span>
            </div>
            <button type="button" :disabled="state.retrying" @click="retryRemoteImages">
              {{ state.retrying ? '抓取中…' : '重试' }}
            </button>
          </div>

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
    </transition>

    <div v-if="state.previewUrl" class="asset-preview" @click.self="closeAssetPreview">
      <button class="preview-close" v-tooltip="'关闭预览'" aria-label="关闭预览" @click="closeAssetPreview">
        <Icon name="x" :size="18" />
      </button>
      <ImageViewer :url="state.previewUrl" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import ImageViewer from './ImageViewer.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import { confirmDialog } from '../lib/confirm';
import { useAppStore } from '../stores/app';
import {
  assetDrawerState as state,
  closeAssetDrawer,
  closeAssetPreview,
  deleteAsset,
  formatAssetSize,
  retryRemoteImages,
  type AssetItem,
} from '../lib/assetDrawer';

type FilterKey = 'all' | 'referenced' | 'orphan';
const filter = ref<FilterKey>('all');

const app = useAppStore();

/**
 * 卡片离右缘的距离：Agent 悬浮卡片占着右侧时让开它的宽度，
 * 否则两张卡片叠在一起，后开的把对话整块盖住。
 * 桌面壳顶部还有原生标题栏（--win-titlebar-h 在样式里让位）。
 */
const viewportWidth = ref(window.innerWidth);
const cardRight = computed(() => {
  const docked =
    app.chatDrawerOpen && app.chatDrawerMode === 'dock' && viewportWidth.value > 1024;
  if (!docked) return 8;
  // 让位后卡片仍要留在屏内（窄窗口里宁可叠着，也不要挤出左边缘）
  const offset = app.chatDockWidth + 8;
  return viewportWidth.value - offset < 520 ? 8 : offset + 8;
});

function onViewportResize() {
  viewportWidth.value = window.innerWidth;
}

/** Esc 关卡片；大图预览开着时先收预览（弹窗的 Esc 会 stopPropagation，不会误触发） */
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  if (!state.open) return;
  if (state.previewUrl) closeAssetPreview();
  else closeAssetDrawer();
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onViewportResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onViewportResize);
});

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
/*
 * 悬浮玻璃卡片（UI 2.0 语言）：四周留 8px 露出窗口底色，与 Agent 卡片、左侧文件树同一材质。
 * 没有遮罩：卡片浮在正文之上而不是压暗整屏，正文照常可见可点，换一份内容不用先关卡片。
 * 顶部还要避开桌面壳的原生标题栏（--win-titlebar-h 只在 desktop-frame 下有值）。
 */
.asset-drawer {
  position: fixed;
  top: calc(8px + var(--win-titlebar-h, 0px));
  bottom: 8px;
  /* 比侧栏(35)高一档：窗口不宽时卡片要给 Agent 卡片让位、会压到文件树上，
     用 --z-drawer(25) 会被侧栏盖掉半张（卡片是临时浮层，盖住谁都不影响它的关闭按钮） */
  z-index: var(--z-chrome);
  width: min(430px, calc(100vw - 16px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--sidebar-glass-border);
  border-radius: 8px;
  background: var(--sidebar-material);
  box-shadow: var(--sidebar-glass-shadow);
  backdrop-filter: saturate(150%) blur(28px);
  -webkit-backdrop-filter: saturate(150%) blur(28px);
}

/* 不支持毛玻璃时退回不透明底色（与左侧栏、Agent 卡片同一处理） */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .asset-drawer { background: var(--sidebar-material-solid); }
}

/* 开合动画：与 Agent 卡片同一套节奏（右缘滑入 + 轻微缩放 + 淡入，160ms），
   只碰 transform / opacity 两个合成层属性，不触发重排 */
.asset-slide-enter-active,
.asset-slide-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.asset-slide-enter-from,
.asset-slide-leave-to {
  opacity: 0;
  transform: translateX(14px) scale(0.985);
}

@media (prefers-reduced-motion: reduce) {
  .asset-slide-enter-active,
  .asset-slide-leave-active {
    transition-duration: 0.01ms;
  }
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
.asset-crumb .sep { opacity: 0.6; flex-shrink: 0; }
/* 首尾两段（原始资料 / 图片资产）不许换行——窄抽屉里它们会被压成「原始资」+「料」两行；
   只有中间那段父项名允许省略号收缩 */
.asset-crumb > span:not(.cur) { flex-shrink: 0; white-space: nowrap; }
.asset-crumb .cur {
  flex: 0 1 auto;
  min-width: 0;
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

/* 正文里还有外链图没落本地时的提示条 */
.remote-warn {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warn);
  border-radius: var(--radius);
  background: var(--warn-soft);
  color: var(--text-secondary);
}
.remote-warn > svg { flex-shrink: 0; margin-top: 2px; color: var(--warn); }
.remote-warn-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11.5px;
  line-height: 1.6;
}
.remote-warn-text b { color: var(--text); font-size: 12px; }
.remote-warn button {
  flex-shrink: 0;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  background: var(--card-bg);
  color: var(--text-secondary);
  font-size: 11.5px;
}
.remote-warn button:hover:not(:disabled) { color: var(--text); background: var(--bg-tertiary); }
.remote-warn button:disabled { opacity: 0.6; cursor: default; }

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
  /* 不铺底色：卡片是毛玻璃，实心底条会在下缘压出一条不透明的带子（与 Agent 卡片同一处理） */
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

/* 手机端：卡片仍是浮层，只留一圈 8px 边（宽度已由 min() 收好），
   但底部导航是 48px 常驻胶囊，卡片要抬到它上面 */
@media (max-width: 768px) {
  .asset-drawer { bottom: calc(64px + env(safe-area-inset-bottom)); }
}
</style>
