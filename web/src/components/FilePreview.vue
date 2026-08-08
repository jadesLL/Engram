<template>
  <div class="file-preview">
    <div class="fp-head">
      <div class="fp-title">
        <span class="fp-name">{{ fileName }}</span>
        <span v-if="kind === 'office'" class="office-status" :class="officeStatusTone">{{ officeStatus }}</span>
      </div>
      <div class="fp-actions">
        <button v-if="kind === 'office'" class="btn small" @click="openVersions">
          <Icon name="restore" :size="14" /> 历史版本
        </button>
        <a class="btn small" :href="rawUrl" :download="fileName">
          <Icon name="download" :size="14" /> 下载
        </a>
        <button v-if="isDesktop" class="btn small" @click="openExternal">
          <Icon name="external" :size="14" /> 用系统程序打开
        </button>
      </div>
    </div>

    <div v-if="loading" class="fp-body muted loading-state">加载中…</div>
    <template v-else-if="kind === 'office'">
      <div v-if="officeMode === 'online'" :id="editorId" class="office-online"></div>
      <div v-else class="office-fallback-wrap">
        <div class="fallback-banner">
          <b>简化预览</b>
          <span>{{ officeError || '在线编辑服务暂不可用，可下载或用系统程序打开。' }}</span>
          <button class="btn small" @click="retryOnlineOffice">重试在线编辑</button>
        </div>
        <div ref="officeEl" class="fp-body office-fallback"></div>
      </div>
    </template>
    <div v-else-if="kind === 'html'" class="fp-body docx" v-html="html"></div>
    <div v-else-if="kind === 'markdown'" ref="mdEl" class="fp-body docx"></div>
    <div v-else-if="kind === 'image'" class="fp-body"><img :src="imageUrl" /></div>
    <pre v-else-if="kind === 'text'" class="fp-body pre">{{ text }}</pre>
    <div v-else class="fp-body unsupported">
      <p>该格式（.{{ ext }}）暂不支持在线预览。</p>
      <p class="muted small">请下载后使用系统默认程序打开。</p>
      <a class="btn primary" :href="rawUrl" :download="fileName">
        <Icon name="download" :size="14" /> 下载 {{ fileName }}
      </a>
    </div>

    <div v-if="versionsOpen" class="version-backdrop" @click.self="versionsOpen = false">
      <section class="version-panel">
        <header>
          <div>
            <b>历史版本</b>
            <p class="muted small">{{ fileName }}</p>
          </div>
          <button class="icon-btn" title="关闭" @click="versionsOpen = false"><Icon name="x" :size="17" /></button>
        </header>
        <div v-if="versionsLoading" class="version-empty muted">加载中…</div>
        <div v-else-if="!versions.length" class="version-empty muted">尚无历史版本</div>
        <div v-else class="version-list">
          <div v-for="version in versions" :key="version.id" class="version-row">
            <div>
              <b>{{ formatDate(version.created_at) }}</b>
              <span class="muted small">{{ reasonLabel(version.reason) }} · {{ formatSize(version.size) }}</span>
            </div>
            <button class="btn small" :disabled="restoringId === version.id" @click="restoreVersion(version)">
              <Icon name="restore" :size="14" />
              {{ restoringId === version.id ? '恢复中…' : '恢复' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Vditor from 'vditor';
import { api } from '../api';
import Icon from './Icon.vue';

const props = defineProps<{ path: string }>();

type OfficeMode = '' | 'online' | 'fallback';
type OfficeVersion = {
  id: string;
  created_at: string;
  reason: string;
  size: number;
};

const loading = ref(true);
const kind = ref('');
const html = ref('');
const text = ref('');
const imageUrl = ref('');
const ext = ref('');
const officeExt = ref('');
const officeUrl = ref('');
const officeMode = ref<OfficeMode>('');
const officeStatus = ref('连接中');
const officeError = ref('');
const mdEl = ref<HTMLDivElement>();
const officeEl = ref<HTMLDivElement>();
const versionsOpen = ref(false);
const versionsLoading = ref(false);
const versions = ref<OfficeVersion[]>([]);
const restoringId = ref('');
const editorId = `onlyoffice-editor-${Math.random().toString(36).slice(2)}`;
let currentSpreadsheet: any = null;
let officeEditor: any = null;
let loadVersion = 0;

const fileName = computed(() => props.path.split('/').pop() || props.path);
const rawUrl = computed(() => `/api/files/raw?path=${encodeURIComponent(props.path)}`);
const isDesktop = Boolean((window as any).wikiDesktop || (window as any).__TAURI__);
const officeStatusTone = computed(() => {
  if (officeMode.value === 'fallback' || officeStatus.value.includes('失败')) return 'warning';
  if (officeStatus.value.includes('保存') || officeStatus.value.includes('就绪')) return 'success';
  return '';
});

async function openExternal() {
  try {
    const res = await fetch(rawUrl.value, { credentials: 'include' });
    if (!res.ok) throw new Error(`下载失败 ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const wd = (window as any).wikiDesktop;
    if (wd) {
      const error = await wd.openFileBytes(fileName.value, Array.from(buf));
      if (error) throw new Error(error);
    } else if ((window as any).__TAURI__) {
      await (window as any).__TAURI__.core.invoke('open_file_bytes', {
        name: fileName.value,
        data: Array.from(buf),
      });
    }
  } catch (error) {
    console.error(error);
    alert('打开失败，请尝试下载后手动打开');
  }
}

function destroyOffice() {
  if (officeEditor) {
    try {
      officeEditor.destroyEditor();
    } catch (error) {
      console.warn('销毁 ONLYOFFICE 编辑器失败', error);
    }
    officeEditor = null;
  }
  clearFallbackOffice();
  const host = document.getElementById(editorId);
  if (host) host.replaceChildren();
}

function loadOnlyOfficeApi(src: string): Promise<void> {
  if ((window as any).DocsAPI?.DocEditor) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>('script[data-onlyoffice-api]');
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('ONLYOFFICE API 加载失败')), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.onlyofficeApi = '1';
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error('ONLYOFFICE API 加载失败'));
    };
    document.head.appendChild(script);
  });
}

async function renderOnlineOffice(version: number) {
  officeStatus.value = '连接中';
  officeError.value = '';
  const { data } = await api.get('/api/files/office-config', { params: { path: props.path } });
  await loadOnlyOfficeApi(data.apiUrl);
  if (version !== loadVersion) return;
  officeMode.value = 'online';
  loading.value = false;
  await nextTick();
  const config = {
    ...data.config,
    events: {
      onAppReady: () => { officeStatus.value = '编辑器就绪'; },
      onDocumentStateChange: (event: any) => {
        officeStatus.value = event?.data ? '正在编辑' : '已保存';
      },
      onError: (event: any) => {
        console.error('ONLYOFFICE error', event?.data);
        officeStatus.value = '编辑失败';
        officeError.value = event?.data?.errorDescription || `错误代码 ${event?.data?.errorCode || 'unknown'}`;
      },
      onWarning: (event: any) => {
        console.warn('ONLYOFFICE warning', event?.data);
      },
    },
  };
  officeEditor = new (window as any).DocsAPI.DocEditor(editorId, config);
}

async function renderOffice(url: string, officeExtension: string, version: number) {
  officeUrl.value = url;
  officeExt.value = officeExtension;
  try {
    await renderOnlineOffice(version);
  } catch (error: any) {
    if (version !== loadVersion) return;
    officeError.value = error?.response?.data?.error || error?.message || '在线编辑服务不可用';
    officeStatus.value = '简化预览';
    officeMode.value = 'fallback';
    loading.value = false;
    await nextTick();
    await renderFallbackOffice(url, officeExtension);
  }
}

async function retryOnlineOffice() {
  destroyOffice();
  officeMode.value = '';
  loading.value = true;
  const version = ++loadVersion;
  try {
    await renderOnlineOffice(version);
  } catch (error: any) {
    officeError.value = error?.response?.data?.error || error?.message || '在线编辑服务不可用';
    officeStatus.value = '简化预览';
    officeMode.value = 'fallback';
    loading.value = false;
    await nextTick();
    await renderFallbackOffice(officeUrl.value, officeExt.value);
  }
}

async function renderFallbackOffice(url: string, officeExtension: string) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`获取文件失败 ${res.status}`);
  const buf = await res.arrayBuffer();
  const el = officeEl.value;
  if (!el) return;
  if (officeExtension === 'docx') {
    const { renderAsync } = await import('docx-preview');
    await renderAsync(buf, el, undefined, { inWrapper: true });
  } else if (officeExtension === 'xlsx') {
    const XLSX = await import('xlsx');
    const { default: Spreadsheet } = await import('x-data-spreadsheet');
    await import('x-data-spreadsheet/dist/xspreadsheet.css');
    const wb = XLSX.read(new Uint8Array(buf));
    currentSpreadsheet = new Spreadsheet(el, {
      mode: 'read',
      showToolbar: false,
      showContextmenu: false,
      view: { width: () => el.clientWidth || 800, height: () => el.clientHeight || 520 },
    }).loadData(wbToXss(wb, XLSX.utils));
  } else if (officeExtension === 'pptx') {
    const { init } = await import('pptx-preview');
    const width = Math.max(320, Math.min(960, el.clientWidth - 32));
    await init(el, { width, height: Math.round(width * 9 / 16) }).preview(buf);
  }
}

function wbToXss(wb: any, utils: any): any[] {
  return wb.SheetNames.map((name: string) => {
    const ws: any = wb.Sheets[name];
    const sheet: any = { name, rows: {} };
    if (!ws || !ws['!ref']) return sheet;
    const range = utils.decode_range(ws['!ref']);
    const cols: any = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const width = ws['!cols']?.[c]?.wch;
      if (width) cols[c] = { width: Math.max(40, width * 7 + 12) };
    }
    if (Object.keys(cols).length) sheet.cols = cols;
    const rowEnd = Math.min(range.e.r, range.s.r + 4999);
    for (let r = range.s.r; r <= rowEnd; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[utils.encode_cell({ r, c })];
        if (!cell || (cell.w == null && cell.v == null)) continue;
        sheet.rows[r] ??= { cells: {} };
        sheet.rows[r].cells[c] = { text: String(cell.w ?? cell.v ?? '') };
      }
    }
    return sheet;
  });
}

function clearFallbackOffice() {
  if (currentSpreadsheet) {
    try {
      currentSpreadsheet.el?.parentNode?.removeChild(currentSpreadsheet.el);
    } catch (error) {
      console.warn('清理 spreadsheet 实例失败', error);
    }
    currentSpreadsheet = null;
  }
  officeEl.value?.replaceChildren();
}

async function openVersions() {
  versionsOpen.value = true;
  versionsLoading.value = true;
  try {
    const { data } = await api.get('/api/files/office-versions', { params: { path: props.path } });
    versions.value = data.versions || [];
  } catch (error) {
    console.error(error);
    versions.value = [];
  } finally {
    versionsLoading.value = false;
  }
}

async function restoreVersion(version: OfficeVersion) {
  if (!confirm(`确定恢复到 ${formatDate(version.created_at)} 的版本吗？当前文件会先自动备份。`)) return;
  restoringId.value = version.id;
  destroyOffice();
  try {
    await api.post(`/api/files/office-versions/${encodeURIComponent(version.id)}/restore`);
    versionsOpen.value = false;
    await loadFile();
  } catch (error: any) {
    alert(error?.response?.data?.error || '恢复失败');
    await loadFile();
  } finally {
    restoringId.value = '';
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function reasonLabel(reason: string) {
  return reason === 'before-restore' ? '恢复前备份' : '编辑会话备份';
}

async function loadFile() {
  const version = ++loadVersion;
  destroyOffice();
  loading.value = true;
  kind.value = '';
  html.value = '';
  text.value = '';
  imageUrl.value = '';
  ext.value = '';
  officeMode.value = '';
  officeStatus.value = '连接中';
  officeError.value = '';

  try {
    const { data } = await api.get('/api/files/preview', { params: { path: props.path } });
    if (version !== loadVersion) return;
    kind.value = data.kind;
    if (data.kind === 'office') await renderOffice(data.url, data.ext, version);
    else if (data.kind === 'html') html.value = data.html;
    else if (data.kind === 'image') imageUrl.value = data.url;
    else if (data.kind === 'text') text.value = data.text;
    else if (data.kind === 'markdown') {
      loading.value = false;
      await nextTick();
      await Vditor.preview(mdEl.value!, data.text, {
        mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      });
    } else ext.value = data.ext;
  } catch (error) {
    console.error('文件预览失败', error);
    kind.value = 'unsupported';
  } finally {
    if (kind.value !== 'office') loading.value = false;
  }
}

onMounted(loadFile);
onBeforeUnmount(destroyOffice);
watch(() => props.path, loadFile);
</script>

<style scoped>
.file-preview { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.fp-head {
  min-height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 24px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.fp-title { min-width: 0; display: flex; align-items: center; gap: 10px; }
.fp-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp-actions { display: flex; gap: 8px; flex-shrink: 0; }
.fp-actions .btn { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
.office-status {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
}
.office-status.success { color: #18794e; background: #e9f7ef; border-color: #b8dfc8; }
.office-status.warning { color: #9a6700; background: #fff8c5; border-color: #eac54f; }
.fp-body { flex: 1; overflow: auto; padding: 24px; min-height: 0; }
.loading-state { display: grid; place-items: center; }
.fp-body img { max-width: 100%; }
.fp-body.docx { max-width: var(--content-max); margin: 0 auto; line-height: 1.8; font-size: 15px; }
.fp-body.docx :deep(h1) { font-size: 1.8em; }
.fp-body.docx :deep(table) { border-collapse: collapse; }
.fp-body.docx :deep(td), .fp-body.docx :deep(th) { border: 1px solid var(--border-strong); padding: 4px 10px; }
.pre { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 13px; }
.office-online { flex: 1; min-height: 0; width: 100%; background: #fff; overflow: hidden; }
.office-fallback-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.fallback-banner {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 16px;
  border-bottom: 1px solid #eac54f;
  background: #fff8c5;
  color: #6e5500;
  flex-shrink: 0;
}
.fallback-banner span { flex: 1; font-size: 13px; }
.office-fallback { background: var(--bg-soft, #f6f6f6); }
.office-fallback :deep(.docx-wrapper) { background: transparent; padding: 8px 0; }
.office-fallback :deep(section.docx) { box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12); margin-bottom: 16px; }
.office-fallback :deep(.pptx-preview-wrapper) { max-width: 100%; margin: 0 auto; }
.unsupported { text-align: center; padding-top: 80px; }
.version-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.28);
  display: flex;
  justify-content: flex-end;
}
.version-panel {
  width: min(420px, 92vw);
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
}
.version-panel header {
  min-height: 68px;
  padding: 14px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
}
.version-panel header p { margin: 3px 0 0; }
.icon-btn { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 6px; }
.icon-btn:hover { background: var(--bg-hover); }
.version-list { overflow-y: auto; padding: 8px 16px 20px; }
.version-row {
  min-height: 66px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border);
}
.version-row > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.version-empty { padding: 48px 20px; text-align: center; }

@media (max-width: 768px) {
  .fp-head { padding: 8px 12px; align-items: flex-start; }
  .fp-title { flex-direction: column; align-items: flex-start; gap: 4px; }
  .fp-actions { gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
  .fp-actions .btn { padding-inline: 7px; }
  .fallback-banner { align-items: flex-start; flex-wrap: wrap; }
}
</style>
