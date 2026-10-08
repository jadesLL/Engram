<template>
  <div class="home-action" :class="[layout, { expanded }]" :data-action="mode">
    <button v-if="layout === 'tile'" class="action-launch" type="button" :aria-label="`打开${title}`" @click="$emit('open')">
      <span class="action-symbol"><Icon :name="icon" :size="20" /></span><span>{{ shortName }}</span><i v-if="draft" class="draft-dot" aria-label="有草稿" />
    </button>
    <template v-else-if="layout === 'column'">
      <button class="action-column-head" type="button" :aria-label="`打开${title}`" @click="$emit('open')"><Icon :name="icon" :size="19" /><span>{{ shortName }}</span></button>
      <div class="column-actions">
        <button type="button" class="quick-action main-action" @click="primaryAction"><Icon :name="isAsk ? 'report' : 'restore'" :size="15" /><span>{{ isAsk ? '概括' : '续写' }}</span></button>
        <button type="button" class="quick-action" @click="secondaryAction"><Icon :name="isAsk ? 'search' : 'plus'" :size="15" /><span>{{ isAsk ? '资料' : '新建' }}</span></button>
      </div>
      <button v-if="height >= 3" class="recent-action" type="button" :disabled="!isAsk && !recentPath" :title="isAsk ? '继续当前对话' : recentTitle" @click="isAsk ? $emit('continue') : $emit('go', recentPath)">
        <Icon :name="isAsk ? 'messages' : 'lightbulb'" :size="14" /><span>{{ isAsk ? '继续聊' : '最近' }}</span><small v-if="!isAsk">{{ recentTitle }}</small>
      </button>
      <span v-if="draft" class="column-draft">有草稿</span>
    </template>
    <template v-else>
      <header v-if="layout === 'editor'" class="action-head">
        <span class="action-symbol"><Icon :name="icon" :size="17" /></span><strong :title="title">{{ title }}</strong>
        <button v-if="!expanded" class="action-expand" type="button" :aria-label="`展开${title}`" @click="$emit('open')"><Icon name="arrow-up-right" :size="14" /></button>
      </header>
      <div class="action-writing">
        <textarea ref="input" v-model="draft" :rows="layout === 'bar' ? 1 : 3" :wrap="layout === 'bar' ? 'off' : 'soft'" :placeholder="isAsk ? '问点什么…' : '记个想法…'" :aria-label="isAsk ? '快速问答输入' : '快速灵感输入'" :disabled="busy" @keydown="onKey" />
        <button v-if="layout === 'bar' && width >= 3" class="bar-helper" type="button" :aria-label="isAsk ? '概括资料' : '展开续写'" :title="isAsk ? '概括资料' : '展开续写'" :disabled="busy" @click="primaryAction"><Icon :name="isAsk ? 'report' : 'restore'" :size="16" /></button>
        <button v-if="layout === 'bar'" class="action-send" type="button" :aria-label="submitLabel" :disabled="!canSubmit || busy" @click="submit"><AppSpinner v-if="busy" :size="14" /><Icon v-else :name="isAsk ? 'send' : 'check'" :size="16" /></button>
        <button v-if="layout === 'bar' && error" class="bar-error" type="button" :title="error" aria-label="查看提交错误" @click="$emit('open')"><Icon name="alert" :size="14" /></button>
      </div>
      <footer v-if="layout === 'editor'" class="action-foot">
        <span class="action-hint">{{ busy ? '正在提交…' : draft ? `${draft.length} 字` : isAsk ? '从一个问题开始' : '随手记录 · 稍后整理' }}</span>
        <button v-if="expanded || width >= 3" class="text-action" type="button" :disabled="busy" @click="primaryAction">{{ isAsk ? '概括资料' : '继续写' }}</button>
        <button class="action-submit" type="button" :disabled="!canSubmit || busy" @click="submit">{{ submitLabel }}</button>
      </footer>
      <p v-if="layout === 'editor' && error" class="action-error" role="alert">{{ error }}</p>
      <p v-if="layout === 'editor' && draft.trim().length > IDEA_MAX_CHARS" class="action-error" role="alert">内容最多 {{ IDEA_MAX_CHARS.toLocaleString() }} 字，请精简后提交。</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Icon from '../Icon.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { IDEA_MAX_CHARS, canSubmitIdea } from '../../lib/ideaComposer';
import { isHomeActionSubmitKey } from '../../lib/homeAction.ts';

const props = withDefaults(defineProps<{
  mode: 'ask' | 'capture'; title: string; width: number; height: number; expanded: boolean;
  submit: (content: string) => Promise<boolean>; variant?: number; ideas?: any[];
}>(), { ideas: () => [] });
const emit = defineEmits<{ (e: 'open' | 'continue' | 'submitted' | 'new'): void; (e: 'go', path: string): void }>();
// One instance survives shell Teleport and grid resizing; only successful submission clears its draft.
const draft = ref(''), error = ref(''), busy = ref(false), input = ref<HTMLTextAreaElement | null>(null);
const isAsk = computed(() => props.mode === 'ask');
const icon = computed(() => isAsk.value ? 'messages' : 'lightbulb');
const shortName = computed(() => isAsk.value ? '问答' : '灵感');
const layout = computed(() => props.expanded ? 'editor' : props.width === 1 ? props.height === 1 ? 'tile' : 'column' : props.height === 1 || props.variant === 1 ? 'bar' : 'editor');
const canSubmit = computed(() => canSubmitIdea(draft.value));
const submitLabel = computed(() => busy.value ? '提交中' : isAsk.value ? '发送' : '记下');
const recent = computed(() => props.ideas[0]);
const recentTitle = computed(() => recent.value?.title || (recent.value ? '最近灵感' : '暂无灵感'));
const recentPath = computed(() => recent.value?.id ? `/page/${encodeURIComponent(recent.value.id)}` : recent.value?.path ? `/page?file=${encodeURIComponent(recent.value.path)}` : '');
watch(() => props.expanded, async (open) => { if (open) { await nextTick(); input.value?.focus(); } });
function primaryAction() {
  if (busy.value) return;
  if (isAsk.value && !draft.value.trim()) draft.value = '请概括知识库中最近更新的资料，列出关键结论和来源。';
  emit('open');
}
function secondaryAction() {
  if (busy.value) return;
  if (isAsk.value && !draft.value.trim()) draft.value = '请在知识库中查找关于以下问题的资料，并注明来源：';
  // A new note uses the existing global composer, without touching this card's draft.
  emit(isAsk.value ? 'open' : 'new');
}
async function submit() {
  if (!canSubmit.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    if (await props.submit(draft.value.trim())) { draft.value = ''; emit('submitted'); }
    else error.value = isAsk.value ? '没有发出，请重试；问题已保留。' : '没有记下，请重试；草稿已保留。';
  } catch (err: any) { error.value = err?.response?.data?.error || err?.message || '提交失败，草稿已保留。'; }
  finally { busy.value = false; }
}
function onKey(event: KeyboardEvent) {
  if (!isHomeActionSubmitKey(event, layout.value === 'bar')) return;
  event.preventDefault(); void submit();
}
</script>
<style scoped>
.home-action { width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;color:var(--text); }
.home-action button { font:inherit;cursor:pointer;min-width:0;padding:0;border:0; }
.home-action button:disabled { cursor:default;opacity:.45; }
.home-action button:focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
.action-symbol { display:flex;align-items:center;justify-content:center;color:var(--accent);background:var(--accent-soft);border-radius:10px;width:32px;height:32px;flex:none; }
.action-launch { flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;background:transparent;color:var(--text-secondary);font-size:11px!important;position:relative; }
.action-launch .action-symbol { width:30px;height:30px;border-radius:9px; }
.draft-dot { width:5px;height:5px;background:var(--accent);border-radius:50%;position:absolute;right:2px;top:2px; }
.column { gap:9px; }
.action-column-head { display:flex;flex-direction:column;align-items:center;gap:5px;padding:3px 0!important;flex:none;font-size:11px!important;color:var(--text-secondary);background:transparent; }
.action-column-head svg { color:var(--accent); }
.column-actions { display:flex;flex-direction:column;gap:6px; }
.quick-action { display:flex;align-items:center;justify-content:center;gap:4px;min-height:32px;flex:none;border-radius:8px;color:var(--text-secondary);background:var(--bg-secondary);font-size:11px!important;white-space:nowrap; }
.quick-action.main-action { color:var(--accent);background:var(--accent-soft); }
.recent-action { display:flex;flex-direction:column;align-items:center;gap:5px;flex:1;justify-content:center;border-top:1px solid var(--border)!important;color:var(--text-secondary);background:transparent;font-size:11px!important;overflow:hidden;min-height:44px; }
.recent-action small { width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10px;color:var(--text-faint); }
.column-draft { position:absolute;top:0;right:0;width:5px;height:5px;overflow:hidden;font-size:0;background:var(--accent);border-radius:50%; }
.bar { flex-direction:row;align-items:center; }
.action-writing { display:flex;flex:1;gap:6px;min-width:0;min-height:0;align-items:center; }
.action-writing textarea { flex:1;width:100%;min-width:0;min-height:0;padding:3px 0;border:0;outline:0;resize:none;background:transparent;color:var(--text);font:inherit;font-size:13px;line-height:1.6; }
.action-writing textarea::placeholder { color:var(--text-faint); }
.bar .action-writing textarea { height:30px;white-space:pre;overflow:auto;scrollbar-width:none; }
.action-send { display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:10px;background:var(--accent);color:var(--on-accent); }
.action-send:disabled,.action-submit:disabled { background:var(--bg-tertiary);color:var(--text-faint);opacity:1!important; }
.bar-helper,.bar-error,.action-expand { display:flex;align-items:center;justify-content:center;width:28px;height:32px;flex:none;color:var(--text-faint);background:transparent; }
.bar-helper:hover,.action-expand:hover { color:var(--accent); }
.bar-error { width:18px;color:var(--danger); }
.action-head { display:flex;gap:8px;align-items:center;flex:none;margin-bottom:8px;min-width:0; }
.action-head strong { font-size:12px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600; }
.editor .action-writing { align-items:stretch; }
.editor textarea { font-size:14px; }
.action-foot { display:flex;gap:8px;align-items:center;flex:none;min-width:0;padding-top:8px;margin-top:8px;border-top:1px solid var(--border); }
.action-hint { flex:1;font-size:11px;color:var(--text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.action-submit { padding:6px 11px!important;background:var(--accent);color:var(--on-accent);border-radius:8px;font-size:12px!important;flex:none; }
.text-action { color:var(--text-secondary);background:transparent;font-size:11px!important;white-space:nowrap; }
.action-error { color:var(--danger);font-size:11px;line-height:1.5;margin-top:6px;overflow-wrap:anywhere; }
.expanded { height:300px;min-height:220px; }
.expanded .action-head { display:none; }
.expanded textarea { padding:8px;font-size:15px; }
@media(pointer:coarse) { .action-send,.bar-helper { min-height:38px; } }
</style>
