<template>
  <div class="ai-inner">
    <div class="ai-head">
      <span class="ai-title"><Icon name="ai" :size="16" /> AI 助手</span>
      <div class="ai-head-actions">
        <button class="icon-btn" title="清空对话" @click="clear"><Icon name="trash" :size="15" /></button>
        <button class="icon-btn" title="关闭" @click="app.toggleAi()"><Icon name="x" :size="15" /></button>
      </div>
    </div>

    <div ref="scrollEl" class="ai-body">
      <div v-if="!messages.length" class="ai-empty faint">
        <p>基于你的知识库回答，答案带引用来源与差距分析。</p>
        <div class="suggests">
          <button v-for="s in suggests" :key="s" class="btn small" @click="ask(s)">{{ s }}</button>
        </div>
      </div>
      <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
        <div class="msg-bubble">
          <div class="msg-text" v-html="renderMd(m.text)"></div>
          <div v-if="m.hits?.length" class="msg-refs">
            <div class="refs-title">📎 引用来源</div>
            <div
              v-for="(h, j) in m.hits"
              :key="j"
              class="ref-item"
              @click="openHit(h)"
            >
              <b>[{{ j + 1 }}]</b> {{ h.title }}
              <span class="faint small">{{ h.evidence.join('+') }}</span>
            </div>
          </div>
          <div v-if="m.streaming" class="cursor">▍</div>
        </div>
      </div>
    </div>

    <div class="ai-input">
      <textarea
        v-model="input"
        rows="2"
        placeholder="向知识库提问…"
        @keydown.enter.exact.prevent="ask(input)"
      />
      <button class="btn primary" :disabled="streaming || !input.trim()" @click="ask(input)">
        {{ streaming ? '…' : '发送' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { ssePost } from '../api';
import Icon from './Icon.vue';

const router = useRouter();
const app = useAppStore();

interface Msg {
  role: 'user' | 'ai';
  text: string;
  hits?: any[];
  streaming?: boolean;
}

const messages = ref<Msg[]>([]);
const input = ref('');
const streaming = ref(false);
const scrollEl = ref<HTMLElement>();

const suggests = ['这个库里关于 Docker 都记录了什么？', '最近更新的页面有哪些主题？', '帮我总结这个知识库'];

/** 收到编辑器选中文本时作为上下文提问 */
function askWith(text: string) {
  input.value = text;
  app.aiDrawerOpen = true;
}
defineExpose({ askWith });

function clear() {
  messages.value = [];
}

async function ask(q: string) {
  const query = q.trim();
  if (!query || streaming.value) return;
  messages.value.push({ role: 'user', text: query });
  input.value = '';
  const aiMsg: Msg = { role: 'ai', text: '', streaming: true };
  messages.value.push(aiMsg);
  streaming.value = true;
  scroll();
  try {
    await ssePost('/api/search/think', { q: query }, {
      onDelta: (t) => {
        aiMsg.text += t;
        scroll();
      },
      onEvent: (event, data) => {
        if (event === 'hits') aiMsg.hits = data.hits;
        if (event === 'error') aiMsg.text += `\n\n⚠ ${data.message}`;
      },
    });
  } catch (e: any) {
    aiMsg.text += `\n\n⚠ ${e.message}`;
  } finally {
    aiMsg.streaming = false;
    streaming.value = false;
    scroll();
  }
}

function openHit(h: any) {
  if (h.refType === 'page') router.push(`/page/${h.refId}`);
  else router.push({ path: '/page', query: { file: h.path } });
}

function renderMd(text: string): string {
  // 轻量渲染：标题/粗体/行内代码/换行/引用角标高亮
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<sup class="cite">[$1]</sup>')
    .replace(/^### (.+)$/gm, '<b>$1</b>')
    .replace(/^## (.+)$/gm, '<b>$1</b>')
    .replace(/^# (.+)$/gm, '<b>$1</b>')
    .replace(/^[-*] (.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}

async function scroll() {
  await nextTick();
  scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight });
}
</script>

<style scoped>
.ai-inner { display: flex; flex-direction: column; height: 100%; }
.ai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.ai-title { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 14px; }
.ai-head-actions { display: flex; gap: 2px; }
.icon-btn {
  display: flex;
  padding: 5px;
  border-radius: 5px;
  color: var(--text-secondary);
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.ai-body { flex: 1; overflow-y: auto; padding: 14px; }
.ai-empty { text-align: center; margin-top: 40px; font-size: 13px; }
.suggests { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.msg { margin-bottom: 12px; display: flex; }
.msg.user { justify-content: flex-end; }
.msg-bubble {
  max-width: 92%;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--bg-tertiary);
  font-size: 14px;
  line-height: 1.65;
  word-break: break-word;
}
.msg.user .msg-bubble { background: var(--accent-soft); }
.msg-text :deep(code) {
  background: var(--bg-active);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 12px;
}
.msg-text :deep(.cite) { color: var(--accent); font-weight: 600; }
.cursor { display: inline-block; animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: 0; } }
.msg-refs {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-strong);
}
.refs-title { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.ref-item {
  font-size: 13px;
  padding: 3px 6px;
  border-radius: 5px;
  cursor: pointer;
  display: flex;
  gap: 6px;
  align-items: center;
}
.ref-item:hover { background: var(--bg-hover); }
.ai-input {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border);
}
.ai-input textarea { flex: 1; resize: none; }
</style>
