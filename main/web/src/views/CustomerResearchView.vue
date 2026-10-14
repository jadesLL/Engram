<template>
  <main class="research-view">
    <header class="research-header"><div><span class="eyebrow">客户洞察</span><h1>客户调研</h1><p>用统一流程，从已有资料与公开信息中找到值得推进的机会。</p></div><button class="btn" @click="rulesOpen = !rulesOpen">{{ rulesOpen ? '收起流程与模板' : '流程与模板' }}</button></header>
    <form class="research-form" @submit.prevent="start">
      <label>客户名称<input v-model="customer" placeholder="输入客户全名或简称" maxlength="100" required :disabled="starting" aria-label="客户名称" /></label>
      <label>资料范围<AppSelect v-model="scope" :options="scopeOptions" aria-label="调研资料范围" :disabled="starting" /></label>
      <button class="btn primary" type="submit" :disabled="starting || !customer.trim()"><Icon name="search" :size="16" />{{ starting ? '正在启动…' : '调研并保存' }}</button>
    </form>
    <p class="research-note">内置 Agent 执行 · 报告保存为新原始资料 · 流程 v{{ rules?.version || 1 }}</p>
    <p v-if="error" class="research-error" role="alert">{{ error }}</p>
    <section v-if="rulesOpen && rules" class="rules-panel">
      <header><h2>调研流程与报告模板</h2><span>修改后对下一次调研生效，内置与外部 Agent 共用。</span></header>
      <label>调研流程<textarea v-model="workflowDraft" rows="12" aria-label="调研流程" /></label>
      <div class="template-headings"><label v-for="(section, index) in rules.sections" :key="section.id">{{ index + 1 }}<input v-model="titlesDraft[index]" :aria-label="`报告章节 ${index + 1}`" maxlength="80" /></label></div>
      <p class="research-note">末章“来源与结论对照”由系统生成，固定保留。</p>
      <button class="btn primary" :disabled="savingRules" @click="saveRules">{{ savingRules ? '保存中…' : '保存流程与模板' }}</button>
    </section>
    <div class="research-layout">
      <aside class="history"><h2>调研记录</h2><p v-if="!tasks.length" class="muted">还没有调研记录</p><button v-for="task in tasks" :key="task.id" class="history-item" :class="{ selected: task.id === selectedId }" :aria-pressed="task.id === selectedId" @click="selectedId = task.id"><strong>{{ task.customer }}</strong><span>{{ statusLabel(task) }} · {{ clientLabel(task.client) }}</span><small>{{ formatTime(task.createdAt) }}</small></button></aside>
      <section class="research-result" aria-live="polite">
        <template v-if="selected">
          <header class="result-head"><div><h2>{{ selected.customer }}</h2><p>{{ statusLabel(selected) }} · 流程 v{{ selected.version }}</p></div><div class="result-actions"><button v-if="isRunning(selected)" class="btn" @click="stop">停止调研</button><button v-if="selected.sessionId" class="btn" @click="openProcess">查看执行过程</button><button v-if="selected.path" class="btn" @click="openReport">打开原始资料</button></div></header>
          <p v-if="selected.error" class="research-error">{{ selected.error }}</p>
          <div v-if="selected.markdown" class="report-markdown" v-html="renderMarkdown(selected.markdown)" />
          <div v-else class="result-empty"><Icon :name="isRunning(selected) ? 'ai' : 'report'" :size="28" /><h3>{{ isRunning(selected) ? '正在收集资料与形成判断' : '尚未收到符合模板的报告' }}</h3><p>{{ isRunning(selected) ? '可以离开页面，稍后回来查看；执行过程保留在 Agent 会话中。' : '调研未完成时不会生成原始资料。可查看执行过程，或重新发起调研。' }}</p></div>
          <p v-if="selected.path" class="saved-path">已保存：{{ selected.path }}</p><p v-else-if="selected.markdown" class="research-note">外部 Agent 返回的报告预览，尚未保存为原始资料。</p>
        </template>
        <div v-else class="result-empty"><Icon name="report" :size="32" /><h2>先选一个客户，开始调研</h2><p>报告包含五看洞察、联合创新、客户关系、机会与风险、90 天行动计划及来源。</p><p>外部 Agent 经 Engram 工具提交的调研，也会出现在左侧记录里。</p></div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import Icon from '../components/Icon.vue';
import AppSelect from '../components/ui/AppSelect.vue';
import { renderMarkdown } from '../lib/markdown';
import { notify } from '../lib/notify';
import { useChatStore } from '../stores/chat';
import { useAppStore } from '../stores/app';
import { isComposingKey } from '../lib/ime';

type Task = { id: string; customer: string; client: string; version: number; status: string; error: string; createdAt: string; markdown: string; path: string; sessionId: string; runId: string };
type Rules = { version: number; workflow: string; sections: Array<{ id: string; title: string }> };
const router = useRouter(), chat = useChatStore(), app = useAppStore();
const customer = ref(''), scope = ref('knowledge-web'), starting = ref(false), error = ref('');
const scopeOptions = [{ value: 'knowledge-web', label: '知识库 + 联网调研' }, { value: 'knowledge-only', label: '仅知识库资料' }];
const tasks = ref<Task[]>([]), selectedId = ref(''), rules = ref<Rules | null>(null), rulesOpen = ref(false), savingRules = ref(false);
const workflowDraft = ref(''), titlesDraft = ref<string[]>([]);
const selected = computed(() => tasks.value.find(t => t.id === selectedId.value));
let timer: ReturnType<typeof setInterval> | undefined, disposed = false, loading = false;
const isRunning = (task: Task) => ['running', 'queued'].includes(task.status);
function statusLabel(task: Task) { return ({ saved: '报告已保存', draft: '报告待保存', running: '调研中', queued: '等待执行', pending: '等待 Agent 提交', failed: '调研失败', cancelled: '已停止', interrupted: '已中断', completed: '执行结束，报告未提交' } as Record<string, string>)[task.status] || task.status; }
const clientLabel = (client: string) => client === 'builtin' ? '内置 Agent' : client === 'external' ? '外部 Agent' : client;
const formatTime = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });
async function load() {
  if (loading || disposed) return;
  loading = true;
  try {
    const { data } = await api.get<{ tasks: Task[]; rules: Rules }>('/api/customer-research');
    if (disposed) return;
    tasks.value = data.tasks;
    if (!selectedId.value && data.tasks.length) selectedId.value = data.tasks[0].id;
    if (!rules.value || (!rulesOpen.value && data.rules.version !== rules.value.version)) { rules.value = data.rules; workflowDraft.value = data.rules.workflow; titlesDraft.value = data.rules.sections.map(s => s.title); }
  } catch (e: any) { if (!disposed) error.value = e?.response?.data?.error || '读取调研记录失败'; }
  finally { loading = false; }
}
async function start(event?: Event) {
  if (isComposingKey(event) || starting.value) return;
  starting.value = true; error.value = '';
  try { const { data } = await api.post('/api/customer-research', { customer: customer.value.trim(), scope: scope.value, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }); selectedId.value = data.taskId; await load(); }
  catch (e: any) { error.value = e?.response?.data?.error || '启动调研失败'; }
  finally { starting.value = false; }
}
async function stop() { try { await api.post('/api/customer-research/stop', { taskId: selectedId.value }); await load(); } catch(e:any) { error.value=e?.response?.data?.error || '停止失败'; } }
async function saveRules() {
  savingRules.value = true; error.value = '';
  try { const { data } = await api.put<Rules>('/api/customer-research/rules', { workflow: workflowDraft.value, titles: titlesDraft.value }); rules.value = data; notify.success(`已保存流程 v${data.version}，下一次调研生效`); }
  catch(e:any) { error.value=e?.response?.data?.error || '保存规则失败，编辑内容已保留'; }
  finally { savingRules.value=false; }
}
async function openProcess() { if (!selected.value?.sessionId) return; await chat.selectSession(selected.value.sessionId); app.chatDrawerOpen = true; }
async function openReport() { if (!selected.value?.path) return; const { data } = await api.get('/api/pages/list'); const found = data.pages?.find((p:any) => p.path === selected.value?.path); if(found) void router.push(`/page/${found.id}`); else notify.info('报告已保存，请在侧栏原始资料中打开'); }
onMounted(async () => { await load(); timer = setInterval(() => { if (!document.hidden) void load(); }, 5000); });
onUnmounted(() => { disposed=true; if(timer) clearInterval(timer); });
</script>

<style scoped>
.research-view { padding:28px 32px 48px; max-width:1200px; margin:auto; }
.research-header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:24px; }
.eyebrow { color:var(--text-faint); font-size:12px; }
h1 { font-size:26px; margin:4px 0 8px; font-weight:600; } h2 { font-size:16px; margin:0; } h3 { font-size:16px; }
.research-header p,.result-head p { color:var(--text-secondary); margin:0; font-size:13px; }
.research-form { display:flex; gap:14px; align-items:flex-end; }
.research-form label { display:grid; gap:8px; flex:1; min-width:0; font-size:12px; color:var(--text-secondary); }
.research-form input { width:100%; min-height:40px; padding:10px 12px; }
.research-form>.btn { min-height:40px; white-space:nowrap; }
.btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; }
.research-note { font-size:12px; color:var(--text-faint); margin:12px 0 22px; }
.research-error { color:var(--danger); background:var(--bg-secondary); padding:12px; border-radius:8px; font-size:13px; overflow-wrap:anywhere; }
.research-layout { display:grid; grid-template-columns:220px minmax(0,1fr); gap:24px; border-top:1px solid var(--border); padding-top:24px; }
.history h2 { margin-bottom:12px; }
.history-item { display:grid; gap:5px; width:100%; border:0; border-radius:8px; text-align:left; padding:12px; margin:4px 0; background:transparent; color:var(--text); transition:background .16s; overflow-wrap:anywhere; }
.history-item:hover,.history-item.selected { background:var(--bg-secondary); }
.history-item span,.history-item small { color:var(--text-secondary); font-size:11px; }
.history-item strong { font-weight:500; }
.research-result { min-width:0; border:1px solid var(--border); border-radius:12px; padding:24px; background:var(--bg-primary); animation:arrive .22s ease-out; }
.result-head { display:flex; justify-content:space-between; gap:12px; padding-bottom:18px; border-bottom:1px solid var(--border); }
.result-head p { margin-top:6px; }.result-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-start; }
.result-empty { display:grid; justify-items:center; text-align:center; gap:12px; padding:64px 12px; color:var(--text-secondary); }.result-empty p { max-width:470px; font-size:13px; margin:0; }
.saved-path { font-size:12px; padding-top:16px; margin-top:24px; border-top:1px solid var(--border); color:var(--text-secondary); overflow-wrap:anywhere; }
.report-markdown { font-size:14px; line-height:1.8; overflow-wrap:anywhere; padding-top:20px; }.report-markdown :deep(table) { display:block; max-width:100%; overflow:auto; }.report-markdown :deep(th),.report-markdown :deep(td) { padding:7px; border-bottom:1px solid var(--border); }.report-markdown :deep(h2) { font-size:18px; margin:26px 0 10px; }
.rules-panel { padding:20px; background:var(--bg-secondary); border-radius:12px; margin:20px 0; }.rules-panel header { display:grid; gap:8px; margin-bottom:18px; }.rules-panel header span { font-size:12px; color:var(--text-secondary); }.rules-panel label { display:grid; gap:6px; font-size:12px; }.rules-panel textarea { width:100%; resize:vertical; padding:12px; line-height:1.7; }.template-headings { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:16px; }.template-headings input { width:100%; padding:9px; }.muted { color:var(--text-faint); font-size:13px; }
@keyframes arrive { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:translateY(0); } }
@media(max-width:768px) { .research-view { padding:20px 16px 32px; }.research-header { align-items:flex-start; flex-wrap:wrap; }.research-form { flex-wrap:wrap; }.research-form label { min-width:100%; }.research-layout { grid-template-columns:1fr; gap:16px; }.history { display:flex; flex-wrap:wrap; gap:8px; }.history h2 { width:100%; }.history-item { width:auto; flex:1; min-width:150px; }.research-result { padding:16px; }.result-head { flex-wrap:wrap; }.template-headings { grid-template-columns:1fr; }.research-form input { font-size:16px; } }
@media(prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important; } }
</style>
