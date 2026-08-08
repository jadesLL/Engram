<template>
  <div class="file-preview">
    <div class="fp-head">
      <span class="fp-name">{{ fileName }}</span>
      <div class="fp-actions">
        <a class="btn small" :href="rawUrl" :download="fileName"><Icon name="download" :size="14" /> 下载</a>
        <button class="btn small" @click="openExternal" v-if="isDesktop"><Icon name="external" :size="14" /> 用系统程序打开</button>
      </div>
    </div>

    <div v-if="loading" class="fp-body muted">加载中…</div>
    <div v-else-if="kind === 'office'" ref="officeEl" class="fp-body office"></div>
    <div v-else-if="kind === 'html'" class="fp-body docx" v-html="html"></div>
    <div v-else-if="kind === 'markdown'" class="fp-body docx" ref="mdEl"></div>
    <div v-else-if="kind === 'image'" class="fp-body"><img :src="imageUrl" /></div>
    <pre v-else-if="kind === 'text'" class="fp-body pre">{{ text }}</pre>
    <div v-else class="fp-body unsupported">
      <p>该格式（.{{ ext }}）暂不支持在线预览。</p>
      <p class="muted small">请下载后使用系统默认程序打开。</p>
      <a class="btn primary" :href="rawUrl" :download="fileName"><Icon name="download" :size="14" /> 下载 {{ fileName }}</a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import Vditor from 'vditor';
import { api } from '../api';
import Icon from './Icon.vue';

const props = defineProps<{ path: string }>();

const loading = ref(true);
const kind = ref('');
const html = ref('');
const text = ref('');
const imageUrl = ref('');
const ext = ref('');
const mdEl = ref<HTMLDivElement>();
const officeEl = ref<HTMLDivElement>();
/** 保存当前渲染的 spreadsheet 实例，切换文件时销毁 */
let currentSpreadsheet: any = null;

const fileName = computed(() => props.path.split('/').pop() || props.path);
const rawUrl = computed(() => `/api/files/raw?path=${encodeURIComponent(props.path)}`);
/** 桌面端环境（Electron 注入 wikiDesktop） */
const isDesktop = Boolean((window as any).wikiDesktop || (window as any).__TAURI__);

async function openExternal() {
  // 桌面端：拉取文件字节 → 主进程写临时目录 → 系统默认程序打开
  try {
    const res = await fetch(rawUrl.value, { credentials: 'include' });
    if (!res.ok) throw new Error(`下载失败 ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const wd = (window as any).wikiDesktop;
    if (wd) {
      const err = await wd.openFileBytes(fileName.value, Array.from(buf));
      if (err) throw new Error(err);
    } else if ((window as any).__TAURI__) {
      const { invoke } = (window as any).__TAURI__.core;
      await invoke('open_file_bytes', { name: fileName.value, data: Array.from(buf) });
    }
  } catch (e) {
    console.error(e);
    alert('打开失败，请尝试下载后手动打开');
  }
}

/** Office 格式：拉取二进制，用开源组件渲染（docx-preview / x-data-spreadsheet / pptx-preview） */
async function renderOffice(url: string, officeExt: string) {
  // office 容器在 v-else-if 分支，需先卸载 loading 才会渲染，否则 ref 未绑定
  loading.value = false;
  await nextTick();
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`获取文件失败 ${res.status}`);
  const buf = await res.arrayBuffer();
  const el = officeEl.value!;
  if (officeExt === 'docx') {
    const { renderAsync } = await import('docx-preview');
    await renderAsync(buf, el, undefined, { inWrapper: true });
  } else if (officeExt === 'xlsx') {
    const XLSX = await import('xlsx');
    const { default: Spreadsheet } = await import('x-data-spreadsheet');
    await import('x-data-spreadsheet/dist/xspreadsheet.css');
    // x-data-spreadsheet 的 zh-cn locale 文件导出为空对象，直接内联中文数据
    Spreadsheet.locale('zh-cn', {
      toolbar: {
        undo: '撤销', redo: '恢复', print: '打印', paintformat: '格式刷',
        clearformat: '清除格式', format: '数据格式', fontName: '字体',
        fontSize: '字号', fontBold: '加粗', fontItalic: '倾斜',
        underline: '下划线', strike: '删除线', color: '字体颜色',
        bgcolor: '填充颜色', border: '边框', merge: '合并单元格',
        align: '水平对齐', valign: '垂直对齐', textwrap: '自动换行',
        freeze: '冻结', autofilter: '自动筛选', formula: '函数', more: '更多',
      },
      contextmenu: {
        copy: '复制', cut: '剪切', paste: '粘贴',
        pasteValue: '粘贴数据', pasteFormat: '粘贴格式',
        hide: '隐藏', insertRow: '插入行', insertColumn: '插入列',
        deleteSheet: '删除', deleteRow: '删除行', deleteColumn: '删除列',
        deleteCell: '删除', deleteCellText: '删除数据',
        validation: '数据验证', cellprintable: '可打印',
        cellnonprintable: '不可打印', celleditable: '可编辑',
        cellnoneditable: '不可编辑',
      },
      format: {
        normal: '正常', text: '文本', number: '数值', percent: '百分比',
        rmb: '人民币', usd: '美元', eur: '欧元',
        date: '短日期', time: '时间', datetime: '长日期', duration: '持续时间',
      },
      formula: {
        sum: '求和', average: '求平均值', max: '求最大值', min: '求最小值',
        concat: '字符拼接', _if: '条件判断', and: '和', or: '或',
      },
    });
    const wb = XLSX.read(new Uint8Array(buf));
    currentSpreadsheet = new Spreadsheet(el, {
      mode: 'edit',
      showToolbar: true,
      showContextmenu: true,
      view: { width: () => el.clientWidth || 800, height: () => el.clientHeight || 520 },
    }).loadData(wbToXss(wb, XLSX.utils));
  } else if (officeExt === 'pptx') {
    const { init } = await import('pptx-preview');
    await init(el, { width: 960, height: 540 }).preview(buf);
  } else {
    throw new Error(`不支持的 Office 格式 .${officeExt}`);
  }
}

/** SheetJS 工作簿 → x-data-spreadsheet 数据格式（只读预览：单元格文本 + 列宽） */
function wbToXss(wb: any, utils: any): any[] {
  return wb.SheetNames.map((name: string) => {
    const ws: any = wb.Sheets[name];
    const sheet: any = { name, rows: {} };
    if (!ws || !ws['!ref']) return sheet;
    const range = utils.decode_range(ws['!ref']);
    const cols: any = {};
    for (let c = range.s.c; c <= range.e.c; c++) {
      const w = ws['!cols']?.[c]?.wch;
      if (w) cols[c] = { width: Math.max(40, w * 7 + 12) };
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

/** 清理 office 容器中的旧渲染内容和实例 */
function clearOfficeEl() {
  // 销毁 x-data-spreadsheet 实例（如果有）
  if (currentSpreadsheet) {
    try {
      // x-data-spreadsheet 没有公开的 destroy 方法，通过移除 DOM 和引用清理
      const container = currentSpreadsheet.el;
      if (container && container.parentNode) {
        container.parentNode.removeChild(container);
      }
    } catch (e) {
      console.warn('清理 spreadsheet 实例失败', e);
    }
    currentSpreadsheet = null;
  }
  // 清空 officeEl 中的所有子节点（包括 pptx-preview 创建的 #pptx-wrap 等）
  const el = officeEl.value;
  if (el) {
    // 使用 while 循环彻底移除所有子节点，确保事件监听器也被清理
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }
}

/** 加载并渲染当前文件 */
async function loadFile() {
  loading.value = true;
  kind.value = '';
  html.value = '';
  text.value = '';
  imageUrl.value = '';
  ext.value = '';
  clearOfficeEl();

  try {
    const { data } = await api.get('/api/files/preview', { params: { path: props.path } });
    kind.value = data.kind;
    if (data.kind === 'office') await renderOffice(data.url, data.ext);
    else if (data.kind === 'html') html.value = data.html;
    else if (data.kind === 'image') imageUrl.value = data.url;
    else if (data.kind === 'text') text.value = data.text;
    else if (data.kind === 'markdown') {
      // md 容器在 v-else-if 分支，需先卸载 loading 才会渲染，否则 ref 未绑定
      loading.value = false;
      await nextTick();
      // 用 Vditor 静态渲染 md（静态导入：动态 import 在生产构建下会加载失败）
      await Vditor.preview(mdEl.value!, data.text, {
        mode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      });
    } else ext.value = data.ext;
  } catch (e) {
    console.error('文件预览失败', e);
    kind.value = 'unsupported';
  } finally {
    loading.value = false;
  }
}

onMounted(loadFile);
watch(() => props.path, loadFile);
</script>

<style scoped>
.file-preview { height: 100%; display: flex; flex-direction: column; }
.fp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
}
.fp-name { font-weight: 600; }
.fp-actions { display: flex; gap: 8px; }
.fp-actions .btn { display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
.fp-body { flex: 1; overflow-y: auto; padding: 24px; }
.fp-body img { max-width: 100%; }
.fp-body.docx {
  max-width: var(--content-max);
  margin: 0 auto;
  line-height: 1.8;
  font-size: 15px;
}
.fp-body.docx :deep(h1) { font-size: 1.8em; }
.fp-body.docx :deep(table) { border-collapse: collapse; }
.fp-body.docx :deep(td), .fp-body.docx :deep(th) { border: 1px solid var(--border-strong); padding: 4px 10px; }
.pre { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 13px; }
.office { background: var(--bg-soft, #f6f6f6); }
.office :deep(.docx-wrapper) { background: transparent; padding: 8px 0; }
.office :deep(section.docx) { box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12); margin-bottom: 16px; }
.office :deep(#pptx-wrap), .office :deep(.pptx-slide) { margin: 0 auto 16px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12); }
.unsupported { text-align: center; padding-top: 80px; }
</style>
