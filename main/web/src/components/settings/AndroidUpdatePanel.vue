<template>
  <SettingsGroup
    class="settings-native"
    anchor="panel-update-android"
    title="安卓端更新"
    :hint="groupHint"
    :badge="badge.text"
    :badge-tone="badge.tone"
    flush
  >
    <!-- 当前版本 -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>当前版本</strong>
        <span>
          手机上只能靠安装包升级（不能像桌面端那样增量拉源码重建），「检查更新」比对的是远端仓库
          Release 里的 APK；下载完成后调起系统安装器，<strong>安装那一步需要你点一次系统确认</strong>。
        </span>
      </div>
      <code class="app-version">v{{ info.currentVersion || '—' }}</code>
    </div>

    <!-- 状态 + 主按钮（检查 / 下载 / 安装三态） -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>更新</strong>
        <span>{{ statusText }}</span>
      </div>
      <div class="update-controls">
        <span v-if="checkedLabel" class="checked-label">{{ checkedLabel }}</span>
        <button
          class="btn"
          :class="{ primary: primaryAction }"
          type="button"
          :disabled="store.running || busy"
          @click="runPrimary"
        >
          <AppSpinner v-if="store.running" :size="11" />
          <template v-else>{{ actionLabel }}</template>
        </button>
      </div>
    </div>

    <!-- 下载进度 -->
    <div v-if="info.phase === 'downloading' && info.percent !== null" class="update-progress">
      <div class="update-progress-bar" :style="{ width: info.percent + '%' }" />
    </div>

    <p v-if="info.phase === 'error'" class="setting-message err">{{ info.error || '更新失败' }}</p>
    <p v-else-if="blockedHint" class="setting-message warn">{{ blockedHint }}</p>
    <p v-if="message" class="setting-message" :class="messageTone">{{ message }}</p>

    <!-- 权限兜底：安装未知应用 / 通知（下载完成提醒） -->
    <div v-if="info.ready && !info.canInstall" class="setting-row">
      <div class="setting-copy">
        <strong>安装权限</strong>
        <span>系统还没允许 Engram 安装应用（Android 8.0 起侧载都需要这一步）。</span>
      </div>
      <button class="btn primary" type="button" @click="openInstallSettings">去开启安装权限</button>
    </div>
    <div v-else-if="showNotificationRow" class="setting-row">
      <div class="setting-copy">
        <strong>下载完成提醒</strong>
        <span>允许通知后，退到后台时下载完会弹一条「新版本已下载」的提醒。</span>
      </div>
      <button class="btn" type="button" @click="requestNotifications">允许通知</button>
    </div>

    <!-- 自动更新：回前台自动检查 + 发现新版后台下载（安装始终要用户点确认） -->
    <div class="setting-row">
      <div class="setting-copy">
        <strong>自动更新</strong>
        <span>启动与回到前台时自动检查（最短 6 小时一次），发现新版本就在后台下载好；安装仍由你点「立即安装」触发系统确认。</span>
      </div>
      <label class="switch-control">
        <input type="checkbox" :checked="info.autoUpdate" @change="toggleAuto" />
        <span aria-hidden="true"></span>
        <em>{{ info.autoUpdate ? '已开启' : '已关闭' }}</em>
      </label>
    </div>

    <!-- 更新内容（Release 正文，纯文本取前几条） -->
    <div v-if="highlights.length" class="update-notes">
      <div class="update-notes-caption">本次更新内容</div>
      <ul>
        <li v-for="(line, index) in highlights" :key="index">{{ line }}</li>
      </ul>
    </div>

    <!-- 更新源配置 -->
    <div class="integration-note">
      更新源与服务器/桌面端同一套，但这里<strong>不预置任何仓库地址</strong>：可以本机自己填，也可以留空
      <strong>跟随多端同步的中枢</strong>（中枢「更新源配置」里填的那一份会随同步下发到手机，免得多台设备各填一遍）。
      本机填写的地址优先；令牌只保存在本机，由 Android Keystore 密封保管。
    </div>
    <div class="setting-row setting-row-form">
      <div class="setting-copy">
        <strong>远端仓库地址</strong>
        <span v-if="info.fromHub">当前用的是同步中枢下发的地址：<code>{{ info.repoUrl }}</code>。本机填写会覆盖它，留空保存则继续跟随中枢。</span>
        <span v-else-if="info.hasLocalSource">当前用的是本机填写的地址。</span>
        <span v-else>还没配置：填仓库首页地址，例如 https://gitea.xxx.com/username/Engram；若同步中枢已配好更新源，这里留空即可跟随它。</span>
      </div>
      <input
        v-model="form.repoUrl"
        type="text"
        :placeholder="info.fromHub ? info.repoUrl : 'https://gitea.xxx.com/username/Engram'"
        aria-label="远端仓库地址"
        @input="repoUrlError = ''"
      />
      <p v-if="repoUrlError" class="setting-message err">{{ repoUrlError }}</p>
    </div>
    <div v-if="info.hasLocalSource" class="setting-row">
      <div class="setting-copy">
        <strong>改回跟随同步中枢</strong>
        <span>清掉本机填写的地址，改用中枢「更新源配置」里那一份（随多端同步下发）。</span>
      </div>
      <button class="btn" type="button" @click="useHubSource">改回跟随中枢</button>
    </div>
    <div class="setting-row setting-row-form">
      <div class="setting-copy">
        <strong>访问令牌</strong>
        <span>{{ info.tokenSaved ? '已保存令牌（留空表示不修改）。' : '私有仓库才需要，公开仓库留空。' }}</span>
      </div>
      <div class="token-control">
        <input
          v-model="form.token"
          type="password"
          autocomplete="off"
          spellcheck="false"
          :placeholder="info.tokenSaved ? '已保存（留空表示不修改）' : '粘贴访问令牌'"
          aria-label="远端仓库访问令牌"
        />
        <button v-if="info.tokenSaved" class="btn small" type="button" @click="clearToken">清除已保存令牌</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-copy">
        <strong>保存配置</strong>
        <span>保存后立即按新地址检查一次。</span>
      </div>
      <button class="btn primary" type="button" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存配置' }}
      </button>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import SettingsGroup from './SettingsGroup.vue';
import AppSpinner from '../ui/AppSpinner.vue';
import { confirmDialog } from '../../lib/confirm';
import { notify } from '../../lib/notify';
import { useSettingsBadge } from '../../lib/settingsBadges';
import { useAppUpdateStore } from '../../stores/appUpdate';
import { parseRepoUrl } from '../../lib/repoSourceUrl';
import {
  appUpdateActionLabel,
  appUpdateBlockedHint,
  appUpdateCheckedLabel,
  appUpdateStatusText,
  needsNotificationPermission,
  releaseHighlights,
} from '../../lib/appUpdate';

/**
 * 「版本与更新 → 安卓端更新」分组（只出现在 Android App 里，能力位 features.apkUpdate）。
 *
 * 与其它两端的更新分组并列：服务器更新是拉镜像换容器、桌面端更新是源码重建或装 exe，
 * 手机端只能下载 APK 再走系统安装器——三条路差别大，分开讲清楚，避免把桌面端的说法
 * 套到手机上（「更新并重启」在手机上不存在）。
 */
const props = defineProps<{ active?: boolean }>();
const store = useAppUpdateStore();
const info = computed(() => store.info);

const form = reactive({ repoUrl: '', token: '' });
const repoUrlError = ref('');
const saving = ref(false);
const busy = ref(false);
const message = ref('');
const messageTone = ref<'ok' | 'warn' | 'err'>('ok');

const statusText = computed(() => appUpdateStatusText(info.value));
const actionLabel = computed(() => appUpdateActionLabel(info.value));
/** 阻塞提示：下面有独立的「安装权限」整行 + 按钮时不再重复同一句话，只留调试包那类说明 */
const blockedHint = computed(() => {
  if (info.value.ready && !info.value.canInstall) return '';
  return appUpdateBlockedHint(info.value);
});
/** 主按钮加粗的时机：有可执行动作（下载/安装），「检查更新」是常规按钮 */
const primaryAction = computed(() => info.value.hasUpdate || info.value.ready || info.value.phase === 'error');
const checkedLabel = computed(() => (info.value.checkedAt ? appUpdateCheckedLabel(info.value.checkedAt) : ''));
const highlights = computed(() => (info.value.hasUpdate || info.value.ready ? releaseHighlights(info.value.releaseNotes) : []));
const showNotificationRow = computed(() => info.value.ready && needsNotificationPermission(info.value));

const groupHint = computed(() =>
  info.value.debugBuild
    ? '当前是调试包：可以检查与下载，但不参与覆盖安装（正式包会与它并存成两个 App）'
    : '手机端只能靠安装包升级：检查远端 Release → 后台下载 APK → 调起系统安装器（安装需你确认一次）',
);

/** 分组徽标：更新中 / 待安装 / 有新版本 / 失败，一眼看出这一组要不要动手 */
const badge = computed<{ text: string; tone: 'accent' | 'ok' | 'warn' | 'danger' | 'muted' }>(() => {
  const current = info.value;
  if (current.phase === 'downloading') {
    return { text: current.percent !== null ? `下载中 ${current.percent}%` : '下载中', tone: 'accent' };
  }
  if (current.phase === 'checking') return { text: '检查中', tone: 'muted' };
  if (current.ready) return { text: '待安装', tone: 'warn' };
  if (current.phase === 'error') return { text: '更新失败', tone: 'danger' };
  if (current.hasUpdate) return { text: `有新版 v${current.latestVersion}`, tone: 'warn' };
  return { text: '', tone: 'muted' };
});
useSettingsBadge('panel-update-android', computed(() => badge.value.text));

/** 主按钮三态：没检查过/没新版 → 检查；有新版本 → 下载；下好了 → 安装 */
async function runPrimary() {
  message.value = '';
  repoUrlError.value = '';
  if (info.value.ready) {
    const ok = await confirmDialog({
      title: '安装更新',
      message: `将调起系统安装器安装 v${info.value.latestVersion || ''}。系统会再问一次是否安装，装完 Engram 会自动重启，本机知识库数据不受影响。继续？`,
      confirmText: '立即安装',
    });
    if (!ok) return;
    busy.value = true;
    const result = await store.install();
    busy.value = false;
    if (result.ok) {
      messageTone.value = 'ok';
      message.value = '已调起系统安装器：请在系统弹窗里点「安装」，完成后 Engram 会自动重启。';
      notify.success('已调起系统安装器');
    } else {
      messageTone.value = 'err';
      message.value = result.error || '安装失败';
      notify.error(message.value);
    }
    return;
  }
  if (info.value.hasUpdate && !info.value.ready) {
    if (info.value.phase === 'downloading') return;
    await store.download();
    return;
  }
  await store.check(true);
}

async function toggleAuto(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  const result = await store.saveConfig({ autoUpdate: enabled });
  if (!result.ok) notify.error(result.error || '保存失败');
  else notify.success(enabled ? '自动更新已开启' : '自动更新已关闭');
}

async function save() {
  repoUrlError.value = '';
  const raw = form.repoUrl.trim();
  const patch: { giteaUrl?: string; giteaRepo?: string; token?: string; useHub?: boolean } = {};
  if (!raw) {
    // 留空 = 跟随同步中枢下发的地址（中枢也没配时就是「未配置」，界面会继续引导填）
    patch.useHub = true;
  } else {
    const parsed = parseRepoUrl(raw);
    if ('error' in parsed) {
      repoUrlError.value = parsed.error;
      return;
    }
    patch.giteaUrl = parsed.url;
    patch.giteaRepo = parsed.repo;
  }
  // 令牌留空表示不修改（已保存的令牌不回显，避免明文进出页面）
  const token = form.token.trim();
  if (token) patch.token = token;
  saving.value = true;
  const result = await store.saveConfig(patch);
  saving.value = false;
  if (!result.ok) {
    messageTone.value = 'err';
    message.value = result.error || '保存失败';
    return;
  }
  form.token = '';
  messageTone.value = 'ok';
  message.value = raw ? '更新源已保存（本机地址优先），正在检查远端版本…' : '已改为跟随同步中枢的更新源，正在检查远端版本…';
  notify.success(raw ? '更新源已保存' : '已改为跟随同步中枢');
  await store.check(true);
}

/** 清掉本机填写的地址，改回跟随同步中枢下发的那一份 */
async function useHubSource() {
  const result = await store.saveConfig({ useHub: true });
  if (!result.ok) {
    notify.error(result.error || '操作失败');
    return;
  }
  form.repoUrl = '';
  notify.success('已改为跟随同步中枢');
  messageTone.value = 'ok';
  message.value = info.value.repoUrl
    ? `已改用同步中枢的更新源：${info.value.repoUrl}`
    : '同步中枢还没配置更新源：仍需要在上面填一个地址。';
  if (info.value.repoUrl) await store.check(true);
}

async function clearToken() {
  const result = await store.saveConfig({ token: '' });
  if (!result.ok) {
    notify.error(result.error || '清除失败');
    return;
  }
  form.token = '';
  notify.success('已清除保存的令牌');
}

async function openInstallSettings() {
  await store.openInstallSettings();
  messageTone.value = 'warn';
  message.value = '已打开系统的「安装未知应用」页面：允许 Engram 后回到这里点「立即安装」。';
}

async function requestNotifications() {
  const enabled = await store.requestNotifications();
  messageTone.value = enabled ? 'ok' : 'warn';
  message.value = enabled
    ? '通知已开启：退到后台下载完成时会提醒你安装。'
    : '还没有通知权限：可在系统设置里允许 Engram 发送通知。';
}

/** 把本地设置读进表单：跟随中枢时输入框留空（占位符显示中枢地址），避免「一保存就把中枢地址写成本机地址」 */
function syncForm() {
  form.repoUrl = info.value.hasLocalSource ? info.value.repoUrl : '';
}

watch(
  () => props.active,
  (now) => {
    if (now) void store.refresh();
  },
);

onMounted(async () => {
  await store.refresh();
  syncForm();
});
watch(() => info.value.repoUrl, syncForm);
</script>

<style scoped>
.update-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}
.checked-label {
  color: var(--text-faint);
  font-size: 12px;
  white-space: nowrap;
}
.token-control {
  display: flex;
  align-items: center;
  gap: 8px;
}
.token-control input {
  min-width: 220px;
}
.update-notes {
  margin: 0 24px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-secondary);
  padding: 12px 14px;
}
.update-notes-caption {
  color: var(--text-faint);
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 8px;
}
.update-notes ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
}
.update-notes li {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.integration-note {
  margin: 14px 24px 18px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.setting-message {
  margin: 0 24px 14px;
}
.setting-message.ok {
  color: var(--success);
}
.setting-message.warn {
  color: var(--warning, #b45309);
}
.setting-message.err {
  color: var(--danger);
}
</style>
