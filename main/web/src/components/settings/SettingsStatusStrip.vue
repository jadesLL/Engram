<template>
  <div class="settings-status-strip" role="group" aria-label="状态总览">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="settings-status-item"
      :class="'tone-' + item.tone"
      :title="item.detail || item.value"
      @click="$emit('jump', item.domain)"
    >
      <span class="settings-status-dot" aria-hidden="true" />
      <span class="settings-status-label">{{ item.label }}</span>
      <span class="settings-status-value">{{ item.value }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SettingsDomainId } from '../../lib/settingsDomains';
import { syncStatusView } from '../../lib/syncStatus';
import { useRuntimeCapabilities } from '../../lib/capabilities';
import { useSyncStore } from '../../stores/sync';
import { useUpdateStore } from '../../stores/update';
import { useAppUpdateStore } from '../../stores/appUpdate';
import { useServerUpdateStore } from '../../stores/serverUpdate';
import { APP_VERSION } from '../../version';

/**
 * 设置页顶部的「状态总览」。
 *
 * 为什么放在设置页：同步断没断、有没有更新、跑的是哪一版，是用户进设置最常想确认的三件事；
 * 以前它们散在各面板里（同步要进「多端同步」、更新要进「版本与更新」），设置页本身不回答
 * 「我有没有事」。这里只读各 store 的现成状态，不新增任何请求：
 *  - 同步：与首页状态条 / 侧栏胶囊同一套 syncStatusView 文案；
 *  - 更新：服务端/桌面的 useUpdateStore + 安卓端的 appUpdateStore，按能力位二选一；
 *  - 版本：编译期 APP_VERSION，点了去「本机应用」。
 *
 * 每条都可点击跳转到对应分类；点不动的状态不放在这里（否则就是装饰）。
 */
type Tone = 'ok' | 'accent' | 'warn' | 'danger' | 'muted';

interface StatusItem {
  key: string;
  domain: SettingsDomainId;
  label: string;
  value: string;
  detail?: string;
  tone: Tone;
}

const sync = useSyncStore();
const update = useUpdateStore();
const appUpdate = useAppUpdateStore();
const serverUpdate = useServerUpdateStore();
const { capabilities } = useRuntimeCapabilities();

function syncItem(): StatusItem {
  const phase = syncStatusView(sync.status, {
    androidLocal: capabilities.value.runtime === 'android-local',
    updating: serverUpdate.updating,
  });
  if (!phase) {
    return { key: 'sync', domain: 'sync', label: '同步', value: '未配置', tone: 'muted', detail: '还没有加入同步群组' };
  }
  const pending = Number(sync.status?.pending || 0);
  if (pending > 0) {
    return { key: 'sync', domain: 'sync', label: '同步', value: '待推 ' + pending, tone: 'warn', detail: phase.detail || phase.label };
  }
  const tone: Tone = serverUpdate.updating
    ? 'accent'
    : phase.tone === 'warn'
      ? 'danger'
      : phase.tone === 'busy'
        ? 'accent'
        : phase.tone === 'ok'
          ? 'ok'
          : 'muted';
  /* 胶囊里不要把「同步」写两遍：label 已经是「同步」，value 只留状态词 */
  const value = phase.phase === 'done'
    ? '已完成'
    : phase.phase === 'syncing'
      ? '进行中'
      : phase.phase === 'offline'
        ? '已断开'
        : phase.phase === 'disabled'
          ? '已停用'
          : phase.label;
  return { key: 'sync', domain: 'sync', label: '同步', value, tone, detail: phase.hint || phase.detail || phase.label };
}

function updateItem(): StatusItem {
  const features = capabilities.value.features;
  if (features.apkUpdate) {
    const info = appUpdate.info;
    if (info.phase === 'checking') return { key: 'update', domain: 'update', label: '更新', value: '检查中', tone: 'accent' };
    if (info.phase === 'downloading') {
      return {
        key: 'update', domain: 'update', label: '更新',
        value: info.percent !== null ? '下载 ' + info.percent + '%' : '下载中',
        tone: 'accent',
      };
    }
    if (info.ready) return { key: 'update', domain: 'update', label: '更新', value: '待安装', tone: 'accent' };
    if (info.hasUpdate) {
      const latest = info.latestVersion;
      return { key: 'update', domain: 'update', label: '更新', value: latest ? 'v' + latest + ' 可更新' : '有新版本', tone: 'warn' };
    }
    return { key: 'update', domain: 'update', label: '更新', value: '已是最新', tone: 'ok' };
  }
  if (serverUpdate.updating) return { key: 'update', domain: 'update', label: '更新', value: '更新中', tone: 'accent' };
  if (update.checking) return { key: 'update', domain: 'update', label: '更新', value: '检查中', tone: 'accent' };
  if (update.hasNewVersion) {
    const latest = update.lastResult?.latestVersion;
    return {
      key: 'update', domain: 'update', label: '更新',
      value: latest ? 'v' + latest + ' 可更新' : '有新版本',
      tone: 'warn',
    };
  }
  return { key: 'update', domain: 'update', label: '更新', value: '已是最新', tone: 'ok' };
}

const items = computed<StatusItem[]>(() => {
  const list: StatusItem[] = [syncItem()];
  if (capabilities.value.features.serverUpdate || capabilities.value.features.apkUpdate) list.push(updateItem());
  list.push({ key: 'version', domain: 'app', label: '版本', value: 'v' + APP_VERSION, tone: 'muted' });
  return list;
});
</script>
