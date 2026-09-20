<template>
  <AppModal
    :open="open"
    title="名称核验"
    placement="right"
    width="min(520px, 94vw)"
    @close="emit('close')"
  >
    <template #subtitle>
      <p class="muted small">
        Agent 提炼时遇到「公司名称不是工商全名、资料库里也查不到」会在这里请示：
        先问是否允许联网查企查查/天眼查，查到后再问是否改用全名。同意改名即由服务端执行（保持页面 ID、双链自动重定向）。
      </p>
    </template>

    <div v-if="store.loading && !store.loaded" class="empty-hint"><AppSpinner :size="14" /> 正在加载…</div>

    <AppEmptyState
      v-else-if="!pendingItems.length && !waitingItems.length"
      icon="clipboard"
      title="没有待核验的名称"
      hint="Agent 撞上查不到工商全名的公司时才会登记到这里，并用通知提醒你。"
    />

    <section v-for="item in pendingItems" :key="item.id" class="check">
      <div class="check-head">
        <span class="badge">{{ item.stage === 'query_consent' ? '待答复 · 是否允许查询' : '待答复 · 是否改用全名' }}</span>
        <span class="faint small">#{{ item.id }} · {{ formatTime(item.createdAt) }}</span>
      </div>
      <p class="check-title">「{{ item.entity }}」</p>
      <p v-if="item.pagePath" class="check-context">关联页面：{{ item.pageTitle }}（{{ item.pagePath }}）</p>
      <p v-if="item.note" class="check-context">{{ item.note }}</p>

      <template v-if="item.stage === 'query_consent'">
        <p class="check-ask">
          资料库里没有这个名称的工商全名。是否允许 Agent 联网用<strong>企查查 / 天眼查</strong>查询？
          查询只用于确认全名，不会写入资料库；查到后会再问你一次是否改名。
        </p>
        <div class="check-actions">
          <button
            class="btn primary small"
            type="button"
            :disabled="submitting === item.id"
            @click="answer(item, 'allow')"
          >允许联网查询</button>
          <button
            class="btn small"
            type="button"
            :disabled="submitting === item.id"
            @click="answer(item, 'deny')"
          >不允许</button>
        </div>
      </template>

      <template v-else>
        <p class="check-ask">
          查到的工商全名：<strong>{{ item.fullName }}</strong>
          <a
            v-if="isUrl(item.fullNameSource)"
            class="check-source"
            :href="item.fullNameSource"
            target="_blank"
            rel="noreferrer noopener"
          ><Icon name="external" :size="12" /> 出处</a>
        </p>
        <p v-if="item.fullNameSource && !isUrl(item.fullNameSource)" class="check-context">出处：{{ item.fullNameSource }}</p>
        <p class="check-ask">
          是否把页面标题「{{ item.pageTitle || item.entity }}」改成该全名？
          改名保持页面 ID 与图谱边，其他页面引用的双链会自动重定向，并记入操作日志。
        </p>
        <div class="check-actions">
          <button
            class="btn primary small"
            type="button"
            :disabled="submitting === item.id"
            @click="answer(item, 'allow')"
          >{{ submitting === item.id ? '处理中…' : '改用全名' }}</button>
          <button
            class="btn small"
            type="button"
            :disabled="submitting === item.id"
            @click="answer(item, 'deny')"
          >保持原样</button>
        </div>
      </template>

      <input
        v-model="drafts[item.id]"
        class="check-note"
        type="text"
        placeholder="备注（可选，写进核验记录供 Agent 参考）"
      />
    </section>

    <section v-for="item in waitingItems" :key="item.id" class="check waiting">
      <div class="check-head">
        <span class="badge done">进行中</span>
        <span class="faint small">#{{ item.id }} · {{ formatTime(item.createdAt) }}</span>
      </div>
      <p class="check-title">「{{ item.entity }}」</p>
      <p class="check-ask">你已允许联网查询，等 Agent 查到全名后回填——届时会再问你一次是否改名。</p>
    </section>

    <div v-if="doneItems.length" class="done-block">
      <button class="done-toggle" type="button" @click="showDone = !showDone">
        <Icon :name="showDone ? 'chevron-down' : 'chevron-right'" :size="13" />
        已办结（{{ doneItems.length }}）
      </button>
      <section v-for="item in showDone ? doneItems : []" :key="item.id" class="check done">
        <div class="check-head">
          <span class="badge done">已办结</span>
          <span class="faint small">#{{ item.id }} · {{ formatTime(item.answeredAt || item.createdAt) }}</span>
        </div>
        <p class="check-title">「{{ item.entity }}」</p>
        <p class="check-answer">{{ outcomeLabel(item) }}</p>
        <p v-if="item.fullNameSource" class="check-context">出处：{{ item.fullNameSource }}</p>
      </section>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppModal from './ui/AppModal.vue';
import AppEmptyState from './ui/AppEmptyState.vue';
import AppSpinner from './ui/AppSpinner.vue';
import Icon from './Icon.vue';
import { outcomeLabel, useEntityNamesStore, type EntityNameCheck } from '../stores/entityNames';
import { notify } from '../lib/notify';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useEntityNamesStore();
const drafts = reactive<Record<string, string>>({});
const submitting = ref('');
const showDone = ref(false);

/** 等用户点选的两轮请示 */
const pendingItems = computed(() =>
  store.items.filter((item) => item.stage === 'query_consent' || item.stage === 'rename_consent')
);
/** 已允许查询、等 Agent 回填的（用户无需动作） */
const waitingItems = computed(() => store.items.filter((item) => item.stage === 'lookup'));
const doneItems = computed(() => store.items.filter((item) => item.stage === 'closed'));

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('sv-SE').slice(0, 16);
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(String(value || '').trim());
}

async function answer(item: EntityNameCheck, decision: 'allow' | 'deny') {
  submitting.value = item.id;
  try {
    const check = await store.answer(item.id, decision, drafts[item.id] || '');
    drafts[item.id] = '';
    if (check.outcome === 'renamed') {
      notify.success(`已改用全名：${check.fullName}`);
    } else if (decision === 'allow') {
      notify.info('已允许联网查询，等 Agent 回填全名');
    } else {
      notify.info('已答复：保持材料写法');
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '答复失败');
  } finally {
    submitting.value = '';
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void store.refresh();
  }
);
</script>

<style scoped>
.empty-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-faint);
  font-size: 12px;
}

.check {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  margin-bottom: 10px;
}

.check.waiting,
.check.done {
  background: var(--bg);
}

.check-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.badge {
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg);
  color: var(--accent, #4d8aff);
  font-size: 11px;
}

.badge.done {
  color: var(--text-faint);
}

.check-title {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.check-context {
  margin: 0 0 6px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.check-ask {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.check-source {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 6px;
  color: var(--accent, #4d8aff);
  font-size: 12px;
  text-decoration: none;
}

.check-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.check-note {
  width: 100%;
  font-size: 12px;
}

.check-answer {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.done-block {
  margin-top: 4px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.done-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
  border: none;
  background: none;
  color: var(--text-faint);
  font-size: 12px;
  cursor: pointer;
}

.done-toggle:hover {
  color: var(--text);
}
</style>
