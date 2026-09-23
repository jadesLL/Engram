<template>
  <div class="inbox-view">
    <div class="page-head">
      <span class="mark"><Icon name="inbox" :size="16" /></span>
      <div class="head-text">
        <h1>收集箱</h1>
        <p class="sub">临时收纳 · 待整理 · 待转换 —— 内容尚未纳入知识库</p>
      </div>
      <div class="spacer" />
      <div class="head-actions">
        <button class="btn" type="button" :disabled="inbox.loading" @click="inbox.load()">
          <Icon name="activity" :size="15" />刷新
        </button>
        <button
          class="btn inbox"
          type="button"
          disabled
          v-tooltip="'语义转换在下一个里程碑接入（按内容重写，不是格式搬运）'"
        >
          <Icon name="ai" :size="15" />全部转换为 Markdown
        </button>
      </div>
    </div>

    <div class="notice">
      <Icon name="eye-off" :size="15" />
      <div>
        <b>收集箱不进入知识库</b>：这里的文件不参与检索、不被提炼、不会被 Agent 在回答里引用；
        只有你确认「入库」之后，转换出的 Markdown 才会成为可引用的知识。
        <template v-if="isDesktop">桌面端会用系统默认应用打开原文件，不在 Engram 内浏览。</template>
        <template v-else>Docker / 浏览器版直接把原文件下载到你的电脑，不在 Engram 内浏览。</template>
      </div>
    </div>

    <div
      class="dropzone"
      :class="{ hot: dragOver }"
      role="button"
      tabindex="0"
      @click="pickFiles"
      @keydown.enter.prevent="pickFiles"
      @keydown.space.prevent="pickFiles"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <Icon name="upload" :size="26" />
      <b>把任意文件拖到这里</b>
      <small>不限格式 · 单文件上限 {{ maxFileLabel }} · 同名不覆盖 · 也可点击选择文件</small>
      <input ref="fileInput" class="file-input" type="file" multiple @change="onPicked" />
    </div>

    <div v-if="inbox.error" class="error-line">
      <Icon name="report" :size="14" />{{ inbox.error }}
    </div>

    <div class="toolbar">
      <div class="seg" role="radiogroup" aria-label="按状态筛选">
        <button
          v-for="option in filterOptions"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="filter === option.value"
          :class="{ on: filter === option.value }"
          @click="filter = option.value"
        >{{ option.label }} {{ option.count }}</button>
      </div>
      <div class="spacer" />
      <span class="hint">
        按拖入时间倒序 · 共 {{ inbox.counts.all }} 个文件 · 支持多端同步
      </span>
    </div>

    <div v-if="inbox.loading && !inbox.loaded" class="loading-line">
      <AppSpinner :size="14" /> 正在读取收集箱…
    </div>

    <div v-else-if="visibleItems.length || inbox.uploading.length" class="card list">
      <div class="list-head">
        <span class="col-name">文件</span>
        <span class="col-status">状态</span>
        <span class="col-actions">操作</span>
      </div>

      <!-- 上传中的行：边收边写，进度按单个文件走 -->
      <div v-for="item in inbox.uploading" :key="`up-${item.name}`" class="file-row uploading">
        <div class="ftype other">…</div>
        <div class="fmain">
          <div class="fname truncate">{{ item.name }}</div>
          <div class="progress"><i :style="{ width: progressPercent(item) }" /></div>
        </div>
        <span class="chip">上传中 {{ progressPercent(item) }}</span>
        <div class="factions" />
      </div>

      <div v-for="item in visibleItems" :key="item.path" class="file-row">
        <div class="ftype" :class="item.category">{{ typeLabel(item) }}</div>
        <div class="fmain">
          <div class="fname truncate" v-tooltip="item.rel">{{ item.name }}</div>
          <div class="fmeta">
            <span>{{ formatSize(item.size) }}</span>
            <span>·</span>
            <span>{{ fromNow(item.mtime) }} 拖入</span>
            <template v-if="item.rel !== item.name">
              <span>·</span><span class="truncate">{{ item.rel }}</span>
            </template>
          </div>
        </div>
        <span class="chip" :class="item.status === 'converted' ? 'done' : 'pending'">
          <Icon :name="item.status === 'converted' ? 'check' : 'file'" :size="12" />
          {{ item.status === 'converted' ? '已转换' : '待整理' }}
        </span>
        <div class="factions">
          <button
            class="btn sm"
            type="button"
            disabled
            v-tooltip="'语义转换在下一个里程碑接入'"
          >
            <Icon name="ai" :size="14" />转为 Markdown
          </button>
          <a class="btn sm ghost" :href="downloadUrl(item)">
            <Icon name="download" :size="14" />{{ isDesktop ? '下载' : '下载原文件' }}
          </a>
          <button
            class="icon-btn danger"
            type="button"
            v-tooltip="'移除（进回收站，可恢复）'"
            aria-label="移除"
            @click="removeItem(item)"
          >
            <Icon name="trash" :size="15" />
          </button>
        </div>
      </div>
    </div>

    <AppEmptyState
      v-else
      icon="inbox"
      title="收集箱是空的"
      hint="把还没整理的资料拖进来：合同扫描件、手机拍的笔记、录音、导出表格都行。它们会先待在这里，转换并入库之后才进入知识库。"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useInboxStore, type InboxItem, type InboxUpload } from '../stores/inbox';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';
import Icon from '../components/Icon.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';

/** 桌面端（有 Electron 桥）：原文件用系统默认应用打开；Docker/浏览器端=下载 */
const isDesktop = Boolean((window as any).wikiDesktop);

const inbox = useInboxStore();
const fileInput = ref<HTMLInputElement>();
const dragOver = ref(false);
const filter = ref<'all' | 'pending' | 'converted'>('all');

const filterOptions = computed(() => [
  { value: 'all' as const, label: '全部', count: inbox.counts.all },
  { value: 'pending' as const, label: '待整理', count: inbox.counts.pending },
  { value: 'converted' as const, label: '已转换', count: inbox.counts.converted },
]);

const visibleItems = computed(() => {
  if (filter.value === 'all') return inbox.items;
  return inbox.items.filter((item) => item.status === filter.value);
});

const maxFileLabel = computed(() =>
  inbox.maxFileMb >= 1024 ? `${(inbox.maxFileMb / 1024).toFixed(0)} GB` : `${inbox.maxFileMb} MB`
);

const TYPE_LABELS: Record<string, string> = {
  document: 'DOC', spreadsheet: 'XLS', presentation: 'PPT', pdf: 'PDF',
  image: 'IMG', text: 'TXT', audio: 'AUD', video: 'VID', archive: 'ZIP', other: 'FILE',
};

function typeLabel(item: InboxItem): string {
  return TYPE_LABELS[item.category] || 'FILE';
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fromNow(mtime: number): string {
  const diff = Date.now() - mtime;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return new Date(mtime).toLocaleDateString('zh-CN');
}

function progressPercent(item: InboxUpload): string {
  if (!item.total) return '0%';
  return `${Math.min(100, Math.round((item.loaded / item.total) * 100))}%`;
}

function downloadUrl(item: InboxItem): string {
  return `/api/inbox/download?path=${encodeURIComponent(item.path)}`;
}

function pickFiles() {
  fileInput.value?.click();
}

async function onPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files?.length) await submit(input.files);
  input.value = '';
}

async function onDrop(event: DragEvent) {
  dragOver.value = false;
  const files = event.dataTransfer?.files;
  if (files?.length) await submit(files);
}

/** 拖入即进入收集箱：不区分格式，也不做客户端类型过滤 */
async function submit(files: FileList | File[]) {
  const { saved, skipped } = await inbox.upload(files);
  if (saved) notify.success(`已收进收集箱：${saved} 个文件`);
  if (skipped.length) notify.error(`跳过 ${skipped.length} 个文件：${skipped[0]}`);
}

async function removeItem(item: InboxItem) {
  const ok = await confirmDialog({
    title: '移出收集箱',
    message: `「${item.name}」将被移入回收站，可随时恢复。`,
    confirmText: '移除',
    danger: true,
  });
  if (!ok) return;
  try {
    await inbox.remove(item.path);
    notify.success('已移入回收站');
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '移除失败');
  }
}

onMounted(() => {
  inbox.load();
});
</script>

<style scoped>
/*
 * 收集箱的身份色：紫色（与知识库的 Engram Blue 区分开）。
 * 只在本视图内定义，不污染全局令牌。
 */
.inbox-view {
  --inbox-accent: #6d4bc4;
  --inbox-accent-soft: rgba(109, 75, 196, 0.1);
  --inbox-accent-border: rgba(109, 75, 196, 0.3);
  padding: 20px 26px 60px;
  max-width: 1180px;
}

html.dark .inbox-view {
  --inbox-accent: #a992f5;
  --inbox-accent-soft: rgba(169, 146, 245, 0.14);
  --inbox-accent-border: rgba(169, 146, 245, 0.32);
}

.page-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
}

.mark {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--inbox-accent-soft);
  color: var(--inbox-accent);
  margin-top: 2px;
}

.head-text h1 {
  margin: 0;
  font-size: 21px;
  line-height: 30px;
  font-weight: 600;
  letter-spacing: -0.2px;
}

.head-text .sub {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.spacer { flex: 1; }

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--card-bg);
  color: var(--text);
  font-size: 13px;
  text-decoration: none;
  box-shadow: var(--shadow-raised);
}

.btn:hover { background: var(--bg-hover); }

.btn.inbox {
  border-color: transparent;
  background: var(--inbox-accent);
  color: #fff;
  box-shadow: none;
}

.btn.sm { height: 26px; padding: 0 9px; font-size: 12.5px; }
.btn.ghost { border-color: transparent; background: transparent; box-shadow: none; color: var(--text-secondary); }
.btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
.btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.btn[disabled]:hover { background: var(--card-bg); }

.icon-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
}

.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn.danger:hover { color: var(--danger); }

.notice {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  margin-bottom: 14px;
  border: 1px solid var(--inbox-accent-border);
  border-radius: var(--radius);
  background: var(--inbox-accent-soft);
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.notice svg { color: var(--inbox-accent); flex-shrink: 0; margin-top: 2px; }
.notice b { color: var(--text); font-weight: 600; }

.dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 116px;
  margin-bottom: 14px;
  border: 1.5px dashed var(--inbox-accent-border);
  border-radius: var(--radius);
  background: linear-gradient(180deg, var(--inbox-accent-soft), transparent 78%);
  color: var(--text-secondary);
  text-align: center;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}

.dropzone svg { color: var(--inbox-accent); }
.dropzone b { color: var(--text); font-size: 14px; font-weight: 600; }
.dropzone small { font-size: 12px; color: var(--text-faint); }
.dropzone:hover,
.dropzone.hot { border-color: var(--inbox-accent); }
.dropzone.hot { background: var(--inbox-accent-soft); }
.dropzone:focus-visible { outline: 2px solid var(--inbox-accent); outline-offset: 2px; }
.file-input { display: none; }

.error-line,
.loading-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 12px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.error-line { color: var(--danger); }

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.seg {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
}

.seg button {
  height: 24px;
  padding: 0 10px;
  border-radius: 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.seg button.on {
  background: var(--card-bg);
  color: var(--text);
  box-shadow: var(--shadow-raised);
}

.hint { font-size: 12.5px; color: var(--text-faint); }

.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
  box-shadow: var(--shadow-raised);
  overflow: hidden;
}

.list-head {
  display: flex;
  align-items: center;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-faint);
}

.col-name { flex: 1; }
.col-status { width: 104px; }
.col-actions { width: 260px; text-align: right; }

.file-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.file-row:last-child { border-bottom: 0; }
.file-row:hover { background: var(--bg-hover); }
.file-row.uploading { background: var(--inbox-accent-soft); }

.ftype {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: #6b6a68;
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
}

.ftype.document { background: var(--file-word); }
.ftype.spreadsheet { background: var(--file-excel); }
.ftype.presentation { background: var(--file-ppt); }
.ftype.pdf { background: var(--file-pdf); }
.ftype.image { background: #2b8a8f; }
.ftype.text { background: var(--file-markdown); }
.ftype.audio,
.ftype.video { background: #7a5ea8; }

.fmain { flex: 1; min-width: 0; }
.fname { font-size: 13.5px; font-weight: 500; }
.fmeta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-faint);
  min-width: 0;
}

.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.progress {
  height: 4px;
  margin-top: 6px;
  border-radius: 2px;
  background: var(--bg-tertiary);
  overflow: hidden;
}

.progress i { display: block; height: 100%; background: var(--inbox-accent); }

.chip {
  width: 92px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 600;
  flex-shrink: 0;
}

.chip.pending { background: var(--warn-soft); color: var(--warn); }
.chip.done { background: var(--success-soft); color: var(--success); }

.factions {
  width: 260px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .inbox-view { padding: 14px 12px 80px; }
  .list-head { display: none; }
  .file-row { flex-wrap: wrap; }
  .factions { width: 100%; justify-content: flex-start; }
  .col-actions { display: none; }
}
</style>
