<template>
  <Teleport to="body">
    <section
      v-if="task && editorAi.pillVisible"
      class="beautify-pill"
      :class="task.status"
      role="status"
      aria-live="polite"
    >
      <span class="pill-orb" aria-hidden="true">
        <AppSpinner v-if="task.status === 'running'" :size="14" />
        <Icon v-else :name="task.status === 'done' ? 'check' : 'alert'" :size="15" />
      </span>
      <div class="pill-copy">
        <b>AI 全文美化</b>
        <small>
          <template v-if="task.status === 'running'">
            {{ task.pageTitle }} · 正在整理 · <LiveDuration :from="task.startedAt" />
          </template>
          <template v-else-if="task.status === 'done'">
            {{ task.pageTitle }} · 整理完成，查看预览
          </template>
          <template v-else>
            {{ task.pageTitle }} · 整理失败，查看原因
          </template>
        </small>
      </div>
      <button type="button" class="pill-btn" @click="openTask">
        {{ task.status === 'running' ? '展开' : '查看' }}
      </button>
      <button
        type="button"
        class="pill-x"
        :aria-label="task.status === 'running' ? '停止整理' : '关闭'"
        @click="dismiss"
      >✕</button>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useEditorAiStore } from '../stores/editorAi';
import Icon from './Icon.vue';
import AppSpinner from './ui/AppSpinner.vue';
import LiveDuration from './ui/LiveDuration.vue';

/**
 * 全文美化最小化后的右下角胶囊：全局挂载，切页/收起编辑页都不会丢。
 * 点「展开 / 查看」先回到发起页，再让编辑页消费 pendingOpen 打开对话框；
 * 运行中点 ✕ 是停止（abort），结束后点 ✕ 只是关掉结果。
 */
const editorAi = useEditorAiStore();
const route = useRoute();
const router = useRouter();

const task = computed(() => editorAi.task);

function openTask() {
  const target = editorAi.task;
  if (!target) return;
  editorAi.requestOpen();
  if (String(route.params.id || '') !== target.pageId) void router.push(`/page/${target.pageId}`);
}

function dismiss() {
  const target = editorAi.task;
  if (!target) return;
  if (target.status === 'running') editorAi.cancel();
  else editorAi.clear();
}
</script>

<style scoped>
.beautify-pill {
  position: fixed;
  right: 18px;
  bottom: calc(18px + var(--safe-bottom));
  /* 页面浮层之上、模态遮罩之下：对话框打开时胶囊自动让位 */
  z-index: calc(var(--z-overlay) - 1);
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(390px, calc(100vw - 24px));
  padding: 9px 10px 9px 11px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--card-bg);
  box-shadow: var(--shadow);
  backdrop-filter: blur(12px);
}

.pill-orb {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--ai-soft);
  color: var(--ai);
}

.beautify-pill.done .pill-orb {
  background: var(--success-soft);
  color: var(--success);
}

.beautify-pill.failed .pill-orb {
  background: var(--danger-soft);
  color: var(--danger);
}

.pill-copy {
  min-width: 0;
}

.pill-copy b {
  display: block;
  font-size: 12px;
  font-weight: 650;
  color: var(--text);
}

.pill-copy small {
  display: block;
  margin-top: 1px;
  overflow: hidden;
  color: var(--text-faint);
  font-size: 10.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pill-btn {
  height: 28px;
  flex: none;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--control-bg);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}

.pill-btn:hover {
  border-color: var(--ai-line);
  color: var(--ai);
}

.pill-x {
  width: 24px;
  height: 24px;
  flex: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.pill-x:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

/* 手机档：让开底部导航（fixed 8px + 48px），按钮补到 44px 触控高度 */
@media (max-width: 768px) {
  .beautify-pill {
    right: 10px;
    bottom: calc(72px + var(--safe-bottom));
    left: 10px;
    max-width: none;
  }

  .pill-btn {
    min-height: 44px;
  }

  .pill-x {
    width: 44px;
    height: 44px;
  }
}
</style>
