<template>
  <span ref="rootEl" class="related-menu">
    <slot :toggle="toggle" :open="open" :count="count" />

    <!-- 本页关联面板：入口由调用方给（编辑视图放状态栏、阅读视图放底部胶囊），面板自己管开合。
         桌面端就地绝对定位，从触发按钮上方弹出；手机端改成贴屏幕底部的弹窗（bottom sheet），
         触发按钮所在的胶囊有 backdrop-filter——它会成为 fixed 后代的包含块，所以手机端必须 Teleport 出 DOM。 -->
    <Teleport to="body" :disabled="!mobile">
      <div v-if="open" class="rel-overlay" :class="{ mobile }">
        <div v-if="mobile" class="rel-mask" @click="close" />
        <div class="rel-panel" role="dialog" aria-label="本页关联">
          <header class="rel-head">
            <h4>本页关联</h4>
            <span class="rel-total">{{ count }}</span>
            <button type="button" class="rel-x" aria-label="关闭本页关联" @click="close">
              <Icon name="x" :size="14" />
            </button>
          </header>

          <div class="rel-body">
            <template v-if="neighbors.length">
              <p class="rel-group">双链 <em>{{ neighbors.length }}</em></p>
              <button
                v-for="(n, i) in neighbors"
                :key="`n-${n.id}-${n.rel}-${i}`"
                type="button"
                class="rel-row"
                @click="pick(n.id)"
              >
                <span class="rel-arw">{{ n.direction === 'out' ? '→' : '←' }}</span>
                <span class="rel-name">{{ n.title }}</span>
                <span class="rel-note">{{ n.direction === 'out' ? '本页引用' : '引用了本页' }}</span>
              </button>
            </template>

            <template v-if="similar.length">
              <p class="rel-group">语义相似 <em>{{ similar.length }}</em></p>
              <button
                v-for="(s, i) in similar"
                :key="`s-${s.id}-${i}`"
                type="button"
                class="rel-row"
                @click="pick(s.id)"
              >
                <span class="rel-arw">≈</span>
                <span class="rel-name">{{ s.title }}</span>
                <span class="rel-note">{{ similarity(s.distance) }}</span>
              </button>
            </template>

            <template v-if="entities.length">
              <p class="rel-group">实体 <em>{{ entities.length }}</em></p>
              <div class="rel-chips">
                <span
                  v-for="(e, i) in entities"
                  :key="`e-${e.name}-${e.rel}-${i}`"
                  class="rel-chip"
                >{{ e.name }}</span>
              </div>
            </template>
          </div>

          <footer class="rel-foot">
            <span>Esc 关闭 · 点击条目跳转</span>
            <button type="button" class="rel-graph" @click="openGraph">图谱 ↗</button>
          </footer>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  /** /api/pages/:id/related 的结果：{ neighbors, similar, entities } */
  related?: any;
  /** 当前页标识：只有真正换页才收起面板（关联数据被后台刷新重取不算换页） */
  resetKey?: string;
}>();

const emit = defineEmits<{
  (event: 'open-page', id: string): void;
  (event: 'open-graph'): void;
}>();

const open = ref(false);
const rootEl = ref<HTMLElement>();

/* 手机端（≤768px）走贴底弹窗；断点与全局响应式规范一致 */
const mobileMedia = window.matchMedia('(max-width: 768px)');
const mobile = ref(mobileMedia.matches);
function onMediaChange(e: MediaQueryListEvent) {
  mobile.value = e.matches;
}
mobileMedia.addEventListener('change', onMediaChange);

const neighbors = computed(() => props.related?.neighbors || []);
const similar = computed(() => props.related?.similar || []);
const entities = computed(() => props.related?.entities || []);
const count = computed(() => neighbors.value.length + similar.value.length + entities.value.length);

/** 语义相似度：后端给的是距离，面板里显示 1 - distance（与旧折叠区一致） */
function similarity(distance: number) {
  const value = 1 - Number(distance);
  return Number.isFinite(value) ? value.toFixed(2) : '';
}

function toggle() {
  if (open.value) close();
  else if (count.value) open.value = true;
}

function close() {
  open.value = false;
}

function pick(id: string) {
  close();
  emit('open-page', id);
}

function openGraph() {
  close();
  emit('open-graph');
}

/** 点面板外任意位置关闭；点面板内部与触发按钮交给各自的处理函数 */
function onDocPointerDown(event: PointerEvent) {
  if (!open.value) return;
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (rootEl.value?.contains(target)) return;
  if (target.closest('.rel-panel')) return;
  close();
}

/** Esc 关面板：捕获阶段拦下，避免阅读视图把它当成「退出阅读」 */
function onDocKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return;
  event.stopPropagation();
  close();
}

watch(open, (value) => {
  if (value) {
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
  }
});

/* 换页时收起：面板里是上一页的条目，留着会串页。
 * 只看页码不看 related：页面事件（保存/索引完成）会重取关联数据，那不该把正开着的面板关掉 */
watch(
  () => props.resetKey,
  () => close()
);

onBeforeUnmount(() => {
  mobileMedia.removeEventListener('change', onMediaChange);
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
});

defineExpose({ open, close, toggle });
</script>

<style scoped>
.related-menu {
  position: relative;
  display: inline-flex;
  flex: none;
}

/* ---------- 桌面：从触发按钮上方弹出的浮层 ---------- */
.rel-overlay {
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  z-index: var(--z-popup);
  display: flex;
}
.rel-panel {
  display: flex;
  flex-direction: column;
  width: 344px;
  max-height: min(46vh, 372px);
  /* 浮层压在正文上：用不透明卡片底，玻璃底会透出下面的字 */
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 44px -20px rgba(0, 0, 0, 0.42), 0 2px 8px -4px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.rel-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 10px 9px 13px;
  border-bottom: 1px solid var(--border);
}
.rel-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.rel-total {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.rel-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  padding: 4px;
  border: 0;
  border-radius: var(--radius-control);
  background: none;
  color: var(--text-faint);
  cursor: pointer;
}
.rel-x:hover { background: var(--bg-hover); color: var(--text); }
.rel-body {
  overflow-y: auto;
  padding: 6px 6px 8px;
}
.rel-group {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 7px 8px 3px;
  color: var(--text-faint);
  font-size: 11px;
}
.rel-group em { font-style: normal; }
.rel-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.rel-row:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.rel-arw {
  flex: none;
  width: 15px;
  color: var(--text-faint);
  font-size: 12px;
}
.rel-row:hover .rel-arw { color: var(--accent); }
.rel-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rel-note {
  flex: none;
  color: var(--text-faint);
  font-size: 11px;
}
.rel-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 3px 8px 6px;
}
.rel-chip {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
}
.rel-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 13px;
  border-top: 1px solid var(--border);
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}
.rel-graph {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.rel-graph:hover { text-decoration: underline; }

/* ---------- 手机：贴屏幕底部的弹窗 ---------- */
.rel-overlay.mobile {
  position: fixed;
  inset: 0;
  z-index: var(--z-popup);
  align-items: flex-end;
}
.rel-mask {
  position: absolute;
  inset: 0;
  background: rgba(15, 15, 15, 0.26);
}
.rel-overlay.mobile .rel-panel {
  position: relative;
  width: 100%;
  max-height: 62vh;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 14px 14px 0 0;
  box-shadow: 0 -14px 40px -18px rgba(0, 0, 0, 0.45);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
/* 抓手：提示这是一张可以点遮罩关掉的下侧弹窗 */
.rel-overlay.mobile .rel-panel::before {
  content: '';
  display: block;
  width: 34px;
  height: 4px;
  margin: 8px auto 0;
  border-radius: 2px;
  background: var(--border-strong);
}
.rel-overlay.mobile .rel-body { padding: 4px 4px 10px; }
.rel-overlay.mobile .rel-row { padding: 9px 12px; font-size: 13px; }
.rel-overlay.mobile .rel-head { padding: 4px 8px 9px 13px; border-bottom: 0; }
</style>
