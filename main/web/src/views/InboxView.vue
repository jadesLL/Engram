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
        <!-- 提示挂在 span 上：disabled 的按钮收不到鼠标事件，直接挂按钮上等于弹不出来 -->
        <span class="tip-wrap" v-tooltip="convertAllTip">
          <button class="btn inbox" type="button" :disabled="convertAllDisabled" @click="convertAll">
            <Icon name="ai" :size="15" />全部转换为 Markdown
          </button>
        </span>
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

    <form class="url-import" @submit.prevent="submitUrl">
      <div class="url-import-main">
        <label for="inbox-page-url">粘贴网页链接</label>
        <div class="url-import-controls">
          <input
            id="inbox-page-url"
            v-model="pageUrl"
            type="url"
            required
            placeholder="https://example.com/article"
            :disabled="fetchingUrl"
          />
          <button class="btn inbox" type="submit" :disabled="fetchingUrl || !pageUrl.trim()">
            <AppSpinner v-if="fetchingUrl" :size="14" />
            <Icon v-else name="external" :size="14" />
            {{ fetchingUrl ? '正在抓取…' : '保存网页' }}
          </button>
        </div>
        <small>保存网站返回的 HTML 原文；登录、验证码和依赖脚本的内容可能无法完整保存。</small>
      </div>
    </form>

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
      <small>不限格式 · 不限单文件大小 · 同名不覆盖 · 也可点击选择文件</small>
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
        按收纳时间倒序 · 共 {{ inbox.counts.all }} 个文件 · 支持多端同步
        <template v-if="inbox.counts.converting"> · {{ inbox.counts.converting }} 个转换中</template>
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
            <span>{{ fromNow(item.mtime) }} 收纳</span>
            <template v-if="item.rel !== item.name">
              <span>·</span><span class="truncate">{{ item.rel }}</span>
            </template>
            <!-- 入库只发生在本会话，刷新页面后这个标记会消失（服务端不存这个状态） -->
            <span v-if="inbox.adopted.has(item.path)" class="adopted-tag">
              <Icon name="check" :size="11" />已入库
            </span>
          </div>
          <div v-if="item.status === 'failed' && item.error" class="fnote error">
            <Icon name="report" :size="12" /><span class="truncate">{{ item.error }}</span>
          </div>
          <div v-else-if="rowNote(item)" class="fnote">
            <Icon name="file" :size="12" /><span class="truncate">{{ rowNote(item) }}</span>
          </div>
        </div>
        <span class="chip" :class="statusChip(item)" v-tooltip="statusTip(item)">
          <Icon :name="statusIcon(item)" :size="12" />
          {{ statusLabel(item) }}
        </span>
        <div class="factions">
          <span class="tip-wrap" v-tooltip="convertTip(item)">
            <button class="btn sm" type="button" :disabled="!canConvert(item)" @click="convertItem(item)">
              <Icon name="ai" :size="14" />{{ item.status === 'converting' ? '转换中…' : '转为 Markdown' }}
            </button>
          </span>
          <button v-if="item.assistantSessionId" class="btn sm ghost" type="button" @click="openConversionChat(item.assistantSessionId)">
            <Icon name="messages" :size="14" />查看过程
          </button>
          <template v-if="item.status === 'converted'">
            <span class="tip-wrap" v-tooltip="item.derivedPath ? `查看产物：${item.derivedPath}` : '还没有转换产物'">
              <button class="btn sm" type="button" :disabled="!item.derivedPath" @click="openReview(item)">
                <Icon name="eye" :size="14" />查看
              </button>
            </span>
            <span
              class="tip-wrap"
              v-tooltip="inbox.adopted.has(item.path) ? '本次会话已入库' : '入库后成为知识库里可检索、可引用的内容'"
            >
              <button
                class="btn sm"
                type="button"
                :disabled="inbox.adopted.has(item.path)"
                @click="adoptItem(item)"
              >
                <Icon name="check" :size="14" />入库
              </button>
            </span>
          </template>
          <a v-if="!isDesktop" class="btn sm ghost" :href="downloadUrl(item)">
            <Icon name="download" :size="14" />下载原文件
          </a>
          <template v-else>
            <button class="btn sm ghost" type="button" @click="openNatively(item)">
              <Icon name="external" :size="14" />系统默认应用打开
            </button>
            <a class="btn sm ghost" :href="downloadUrl(item)">
              <Icon name="download" :size="14" />下载
            </a>
          </template>
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

    <!-- 产物审阅：先看转换结果，确认没问题再入库（入库是不可见的写操作，值得先过一眼） -->
    <AppModal :open="reviewOpen" :title="reviewTitle" width="min(880px, 94vw)" @close="closeReview">
      <template #subtitle>
        <p class="review-sub">{{ reviewItem?.derivedPath || '转换产物' }}</p>
      </template>
      <div v-if="reviewLoading" class="review-state">
        <AppSpinner :size="14" /> 正在读取产物…
      </div>
      <div v-else-if="reviewError" class="review-state error">
        <Icon name="report" :size="14" />{{ reviewError }}
      </div>
      <div v-else ref="reviewBody" class="review-md" />
      <template #footer>
        <button class="btn" type="button" @click="closeReview">关闭</button>
        <button class="btn inbox" type="button" :disabled="adoptDisabled" @click="adoptFromReview">
          <Icon name="check" :size="14" />{{ adoptLabel }}
        </button>
      </template>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Vditor from 'vditor';
// 收集箱不在编辑器路由下，MarkdownEditor 那份 vditor 样式在这里不会加载；
// 产物预览要用到 .vditor-reset 的基础排版，所以自己引一次（与文件预览的呈现保持一致）
import 'vditor/dist/index.css';
import { vditorPreviewOptions } from '../lib/vditorPreview';
import { useInboxStore, type InboxItem, type InboxUpload } from '../stores/inbox';
import { useChatStore } from '../stores/chat';
import { useAppStore } from '../stores/app';
import { confirmDialog } from '../lib/confirm';
import { notify } from '../lib/notify';
import Icon from '../components/Icon.vue';
import AppSpinner from '../components/ui/AppSpinner.vue';
import AppEmptyState from '../components/ui/AppEmptyState.vue';
import AppModal from '../components/ui/AppModal.vue';

/** 桌面端（有 Electron 桥）：原文件用系统默认应用打开；Docker/浏览器端=下载 */
const isDesktop = Boolean((window as any).wikiDesktop);

const inbox = useInboxStore();
const chat = useChatStore();
const app = useAppStore();
const fileInput = ref<HTMLInputElement>();
const pageUrl = ref('');
const fetchingUrl = ref(false);
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

/* ===== 转换：能不能转由服务端的 capability 说了算，界面不自己猜格式 ===== */

/** 服务端能按内容语义转换的三类；agent-only / unsupported 只能等 Agent 通道 */
const CONVERTIBLE = new Set(['office', 'pdf', 'text']);

const STATUS_STYLE: Record<InboxItem['status'], { label: string; icon: string; chip: string }> = {
  pending: { label: '待整理', icon: 'file', chip: 'pending' },
  converting: { label: '转换中', icon: 'activity', chip: 'converting' },
  converted: { label: '已转换', icon: 'check', chip: 'done' },
  failed: { label: '转换失败', icon: 'report', chip: 'failed' },
};

function statusLabel(item: InboxItem): string {
  return STATUS_STYLE[item.status]?.label || item.status;
}

function statusIcon(item: InboxItem): string {
  return STATUS_STYLE[item.status]?.icon || 'file';
}

function statusChip(item: InboxItem): string {
  return STATUS_STYLE[item.status]?.chip || 'pending';
}

function statusTip(item: InboxItem): string {
  if (item.status === 'failed') return item.error || '转换失败，可以重试';
  if (item.status === 'converting') return '正在按内容语义转换，完成后自动刷新';
  return '';
}

/** 转换中不给点（重复提交没有意义），失败可以点（重跑一次），其余按格式能力判断 */
function canConvert(item: InboxItem): boolean {
  return CONVERTIBLE.has(item.capability) && item.status !== 'converting';
}

function convertTip(item: InboxItem): string {
  if (item.status === 'converting') return '正在转换，完成后会自动刷新';
  if (!CONVERTIBLE.has(item.capability)) return item.hint || '这个格式暂时不能转换';
  if (item.status === 'failed') return '重新转换';
  return '按内容语义重写成人类可读的 Markdown，不是格式搬运';
}

/**
 * 行内补充说明：不能转的给服务端原因，已转的给产物落点。
 * 失败原因由模板单独一行渲染（要用危险色），这里不重复。
 */
function rowNote(item: InboxItem): string {
  if (!CONVERTIBLE.has(item.capability)) return item.hint;
  if (item.status === 'converted' && item.derivedPath) return `产物：${item.derivedPath}`;
  return '';
}

const convertibleItems = computed(() => inbox.items.filter((item) => CONVERTIBLE.has(item.capability)));
// 只看有没有可转项：不做 loading 门闩，否则转换中的 2 秒轮询会让按钮一闪一闪地禁用
const convertAllDisabled = computed(() => !convertibleItems.value.length);
const convertAllTip = computed(() =>
  convertibleItems.value.length
    ? `把 ${convertibleItems.value.length} 个可转换的文件一起交给语义转换`
    : '收集箱里没有可转换的文件：图片和音视频要走 Agent 通道，压缩包等格式暂不支持'
);

async function convertItem(item: InboxItem) {
  if (!canConvert(item)) return;
  try {
    const result = await inbox.convert([item.path]);
    if (result.queued.length) {
      notify.success('已开始转换');
      expectConversion();
      await openConversionChat(result.queued[0].sessionId);
    } else if (result.skipped.length) {
      notify.error(`无法转换：${result.skipped[0].reason}`);
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '无法开始转换');
  }
}

async function convertAll() {
  if (convertAllDisabled.value) return;
  try {
    const result = await inbox.convert('all');
    if (result.queued.length) {
      notify.success(`已开始转换 ${result.queued.length} 个文件`);
      expectConversion();
      await openConversionChat(result.queued[0].sessionId);
    }
    // 服务端会跳过不能转的格式：第一条原因足够说明问题，逐条细节看行内提示
    if (result.skipped.length) {
      const first = result.skipped[0];
      notify.error(`跳过 ${result.skipped.length} 个：${first.path}（${first.reason}）`);
    }
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '无法开始转换');
  }
}

/** 批量转换时先打开第一条；其余转换各自进入 Agent 会话列表。 */
async function openConversionChat(sessionId: string) {
  try {
    await chat.loadSessions();
    await chat.selectSession(sessionId);
    app.toggleChat(true);
  } catch {
    notify.error('转换已受理，但暂时无法打开 Agent 对话');
  }
}

/**
 * 列表里只要还有 converting 的条目，就每 2 秒重新拉一次列表：转换是服务端队列在跑，
 * 进度只能轮询追（视图自己的定时器，卸载时清掉）。
 * 另外留一小段兜底时间：刚点过转换时服务端可能还没把任务挂到列表上，
 * 只看 converting 会漏掉这几百毫秒，用户点了「转换」却看不到任何变化。
 */
const converting = computed(() => inbox.items.some((item) => item.status === 'converting'));
const POLL_MS = 2000;
const CONVERT_GRACE_MS = 10000;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let graceUntil = 0;
/** 卸载后不再重挂定时器：在途的 load 可能在组件已经卸载之后才回到 then 里 */
let disposed = false;

function pollingNeeded(): boolean {
  return converting.value || Date.now() < graceUntil;
}

function syncPolling() {
  if (disposed) return;
  if (pollingNeeded() && !pollTimer) {
    pollTimer = setInterval(pollTick, POLL_MS);
  } else if (!pollingNeeded() && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function pollTick() {
  if (inbox.loading) return;
  // load 自己吞异常，这里只负责拉完再对一次表：转换结束就收工
  void inbox.load().then(syncPolling);
}

/** 转换请求受理之后调用：列表暂时没出现 converting 也先把轮询挂上 */
function expectConversion() {
  graceUntil = Date.now() + CONVERT_GRACE_MS;
  syncPolling();
}

watch(converting, syncPolling);

/* ===== 入库：服务端没有「已入库」状态，标记只存在本会话的 store 里 ===== */

const adopting = ref(false);

function adoptConfirm(item: InboxItem) {
  return {
    title: '入库',
    message: `「${item.name}」转换出的 Markdown 会进入知识库：入库后它会成为知识库里可检索、可引用的内容。原件仍留在收集箱。`,
    confirmText: '入库',
    danger: false,
  };
}

async function runAdopt(item: InboxItem) {
  adopting.value = true;
  try {
    const result = await inbox.adopt(item.path);
    notify.success(`已入库到 ${result.pagePath}`);
  } catch (error: any) {
    notify.error(error?.response?.data?.error || '入库失败');
  } finally {
    adopting.value = false;
  }
}

/** 行内「入库」：页面上没有别的浮层，直接确认就行 */
async function adoptItem(item: InboxItem) {
  const ok = await confirmDialog(adoptConfirm(item));
  if (!ok) return;
  await runAdopt(item);
}

/* ===== 产物审阅弹窗 ===== */

const reviewOpen = ref(false);
const reviewLoading = ref(false);
const reviewError = ref('');
const reviewItem = ref<InboxItem | null>(null);
const reviewMarkdown = ref('');
/** Vditor.preview 只接受 HTMLDivElement（与 FilePreview 的 mdEl 同类型） */
const reviewBody = ref<HTMLDivElement>();
/** 快速连点两份产物时，只认最后一次请求的结果 */
let reviewSeq = 0;

const reviewTitle = computed(() => reviewItem.value?.derivedPath?.split('/').pop() || '转换产物');
const adoptDisabled = computed(() => {
  const item = reviewItem.value;
  if (!item || !reviewMarkdown.value || adopting.value) return true;
  return inbox.adopted.has(item.path);
});
const adoptLabel = computed(() => {
  if (adopting.value) return '入库中…';
  const item = reviewItem.value;
  return item && inbox.adopted.has(item.path) ? '已入库' : '入库';
});

/** 以当前主题渲染 Markdown：与 FilePreview 的 markdown 分支走同一条 Vditor.preview 路径 */
async function renderMarkdown(markdown: string) {
  const host = reviewBody.value;
  if (!host) return;
  await Vditor.preview(host, markdown, vditorPreviewOptions(document.documentElement.classList.contains('dark')));
}

async function openReview(item: InboxItem) {
  const seq = ++reviewSeq;
  reviewItem.value = item;
  reviewMarkdown.value = '';
  reviewError.value = '';
  reviewLoading.value = true;
  reviewOpen.value = true;
  try {
    const derived = await inbox.loadDerived(item.path);
    if (seq !== reviewSeq) return;
    reviewMarkdown.value = derived.markdown || '';
    reviewLoading.value = false;
    await nextTick();
    await renderMarkdown(reviewMarkdown.value);
  } catch (error: any) {
    if (seq !== reviewSeq) return;
    reviewLoading.value = false;
    reviewError.value = error?.response?.data?.error || error?.message || '读取产物失败';
  }
}

function closeReview() {
  reviewOpen.value = false;
  // 关掉之后到达的产物请求不该再往已卸载的容器里渲染
  reviewSeq++;
}

/**
 * 从弹窗里入库：先关掉弹窗再确认。
 * ConfirmHost 的浮层比本视图更早挂到 body 上，两者同为 --z-overlay，DOM 靠后的会盖住确认框；
 * 用户取消时用已取回的正文重新渲染，等于没关过。
 */
async function adoptFromReview() {
  const item = reviewItem.value;
  if (!item || adoptDisabled.value) return;
  const markdown = reviewMarkdown.value;
  reviewOpen.value = false;
  const ok = await confirmDialog(adoptConfirm(item));
  if (!ok) {
    reviewOpen.value = true;
    await nextTick();
    await renderMarkdown(markdown);
    return;
  }
  await runAdopt(item);
}

const TYPE_LABELS: Record<string, string> = {
  document: 'DOC', spreadsheet: 'XLS', presentation: 'PPT', pdf: 'PDF',
  image: 'IMG', text: 'TXT', web: 'WEB', audio: 'AUD', video: 'VID', archive: 'ZIP', other: 'FILE',
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

/**
 * 桌面端：按路径交给系统默认应用打开（主进程只接受收集箱内的 vault 相对路径）。
 * 不走「把整份字节传过去」的老链路——收集箱里可能是 GB 级录屏。
 */
async function openNatively(item: InboxItem) {
  const bridge = (window as any).wikiDesktop;
  if (!bridge?.openInboxFile) {
    notify.error('桌面端桥不可用，请改用下载');
    return;
  }
  const result = await bridge.openInboxFile(item.path);
  if (result && result.ok === false) notify.error(`打不开：${result.error}`);
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

async function submitUrl() {
  const url = pageUrl.value.trim();
  if (!url || fetchingUrl.value) return;
  fetchingUrl.value = true;
  try {
    const saved = await inbox.fetchUrl(url);
    pageUrl.value = '';
    notify.success(`已保存网页：${saved.name}`);
  } catch (error: any) {
    notify.error(error?.response?.data?.error || error?.message || '抓取网页失败');
  } finally {
    fetchingUrl.value = false;
  }
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

onMounted(async () => {
  await inbox.load();
  // store 可能已经被别处（侧栏角标）加载过，watch 不会为初始值补一次，这里对一次表
  syncPolling();
});

onBeforeUnmount(() => {
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
});
</script>

<style scoped>
.inbox-view {
  --inbox-accent: var(--accent);
  --inbox-accent-soft: var(--accent-soft);
  --inbox-accent-border: color-mix(in srgb, var(--accent) 30%, transparent);
  padding: 20px 26px 60px;
  max-width: 1180px;
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
  color: var(--on-accent);
  box-shadow: none;
}

.btn.sm { height: 26px; padding: 0 9px; font-size: 12.5px; }
.btn.ghost { border-color: transparent; background: transparent; box-shadow: none; color: var(--text-secondary); }
.btn.ghost:hover { background: var(--bg-hover); color: var(--text); }
.btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.btn[disabled]:hover { background: var(--card-bg); }

/* 提示的落点：disabled 的按钮收不到鼠标事件，包一层 span 让它照样能弹 */
.tip-wrap { display: inline-flex; }

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

.url-import {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
}
.url-import-main label { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 600; }
.url-import-controls { display: flex; gap: 8px; }
.url-import-controls input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--bg-secondary);
  color: var(--text);
  font: inherit;
}
.url-import-controls input:focus-visible { outline: 2px solid var(--inbox-accent); outline-offset: 1px; }
.url-import-controls .btn { white-space: nowrap; }
.url-import-main small { display: block; margin-top: 7px; color: var(--text-faint); font-size: 11.5px; }

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
/* 与 .factions 同宽：已转换的行多出「查看 / 入库」两个动作，窄了会挤到一起 */
.col-actions { width: 320px; text-align: right; }

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
.ftype.web { background: var(--inbox-accent); }
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
.chip.converting { background: var(--inbox-accent-soft); color: var(--inbox-accent); }
.chip.failed { background: var(--danger-soft); color: var(--danger); }

/* 行内补充说明：失败原因用危险色，其余（不可转换原因 / 产物落点）保持次要文字 */
.fnote {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-faint);
  min-width: 0;
}

.fnote.error { color: var(--danger); }
.fnote svg { flex-shrink: 0; }

.adopted-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--success-soft);
  color: var(--success);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.factions {
  width: 320px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
  flex-shrink: 0;
}

.review-sub {
  color: var(--text-secondary);
  font-size: 12px;
  word-break: break-all;
}

.review-state {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 26px 2px;
  font-size: 13px;
  color: var(--text-secondary);
}

.review-state.error { color: var(--danger); }

/* 产物正文按阅读列排版；`vditor-reset` 的基础排版由 vditor 的样式提供 */
.review-md {
  max-width: var(--content-max);
  margin: 0 auto;
  font-size: 15px;
  line-height: 1.8;
}

.review-md :deep(> :first-child) { margin-top: 0; }
.review-md :deep(h1) { font-size: 1.7em; }
.review-md :deep(table) { border-collapse: collapse; }
.review-md :deep(td),
.review-md :deep(th) { border: 1px solid var(--border-strong); padding: 4px 10px; }
.review-md :deep(img) { max-width: 100%; border-radius: var(--radius); }

@media (max-width: 768px) {
  .inbox-view { padding: 14px 12px 80px; }
  .url-import-controls { flex-wrap: wrap; }
  .url-import-controls input { flex-basis: 100%; }
  .list-head { display: none; }
  .file-row { flex-wrap: wrap; }
  .factions { width: 100%; justify-content: flex-start; }
  .col-actions { display: none; }
}
</style>
