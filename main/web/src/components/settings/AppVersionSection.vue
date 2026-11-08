<template>
  <SettingsGroup class="settings-native" anchor="app-version" title="版本信息" hint="当前版本与提交身份" flush>
    <ul class="value-list">
      <li class="value-row">
        <span class="value-label">版本</span>
        <span class="value-text">v{{ APP_VERSION }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">提交</span>
        <span class="value-text">{{ commitText }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">{{ dateLabel }}</span>
        <span class="value-text">{{ dateText }}</span>
      </li>
      <li class="value-row">
        <span class="value-label">运行形态</span>
        <span class="value-text is-muted">{{ runtimeForm }}</span>
      </li>
    </ul>
    <p v-if="versionNote" class="setting-note">{{ versionNote }}</p>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import SettingsGroup from './SettingsGroup.vue';
import { APP_VERSION } from '../../version';
import { formatVersionHint, type GitIdentity } from '../../lib/buildLabel';
import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 「本机应用 → 版本信息」分组。
 * 2026-09-28 从 AccountPanel 的「连接与版本」拆出（方案 A）：版本号属于"这台机器上跑的是哪一版"，
 * 放进「本机应用」；同一个分组里的「连接通道」留在「账户与访问」。
 *
 * 提交身份两个来源：桌面源码模式由主进程经 IPC 给出（含提交日期/脏标记），
 * Docker 镜像与浏览器访问由服务端 /api/update/state 给出（镜像内烤入 /app/GIT_SHA）。
 * 都拿不到时（安装包形态、无 git 的部署）退回纯版本号。
 *
 * 2026-11 第二轮：成对信息改用 value-list（版本 / 提交 / 日期 / 运行形态），
 * 空值统一写「—」；只保留一条真正需要解释的备注（预构建安装、源码模式读不到提交号）。
 */
const { capabilities, loaded: capabilitiesLoaded, load: loadCapabilities } = useRuntimeCapabilities();

const desktopEnv = ref<GitIdentity | null>(null);
const serverCommit = ref('');
const identity = computed<GitIdentity>(() => {
  const commit = desktopEnv.value?.commit || serverCommit.value;
  if (!commit) return { commit: '' };
  return {
    commit,
    commitDate: desktopEnv.value?.commitDate || '',
    dirty: desktopEnv.value?.dirty,
  };
});

/** 提交号：源码模式工作区有未提交改动时标出来（与版本徽标同一套语义） */
const commitText = computed(() => {
  const commit = identity.value.commit;
  if (!commit) return '—';
  return identity.value.dirty ? `${commit} · 有未提交改动` : commit;
});

/** 日期：预构建包清单给的是打包时间（builtAt），git 检出给的是提交日期，别混为一谈 */
const dateLabel = computed(() => (desktopEnv.value?.prebuilt ? '构建时间' : '提交日期'));
const dateText = computed(() => identity.value.commitDate || '—');

/** 运行形态：这台机器上是哪种跑法（桌面三种形态 / 浏览器访问 / Android / 服务器部署） */
const runtimeForm = computed(() => {
  const env = desktopEnv.value;
  if (env) {
    if (env.packaged) return '桌面端 · 安装包';
    if (env.prebuilt) return '桌面端 · 预构建安装';
    return '桌面端 · 源码模式';
  }
  if (!capabilitiesLoaded.value) return '—';
  switch (capabilities.value.runtime) {
    case 'desktop':
      return '桌面端 · 浏览器访问';
    case 'android-local':
      return 'Android 应用';
    default:
      return '服务器部署';
  }
});

/**
 * 备注只留两句必要的：预构建安装不含 Git（应用内更新方式不同）、
 * 源码模式却读不到提交号（Git 不可用或不在检出目录——否则用户只看到一个光秃秃的版本号）。
 */
const versionNote = computed(() => {
  const env = desktopEnv.value;
  if (env?.prebuilt) return formatVersionHint({ prebuilt: true, commit: identity.value.commit });
  if (env?.packaged === false && !identity.value.commit) {
    return formatVersionHint({ sourceMode: true, commit: '' });
  }
  return '';
});

onMounted(async () => {
  await loadCapabilities();
  // 桌面端源码模式：主进程经 IPC 给提交身份
  const wd = (window as any).wikiDesktop;
  if (wd?.getDesktopEnv) {
    wd.getDesktopEnv()
      .then((env: GitIdentity | null) => {
        desktopEnv.value = env;
      })
      .catch(() => {
        /* 主进程未就绪时忽略，版本号照常显示 */
      });
  }
  // Docker 镜像 / 浏览器访问：服务端读 /app/GIT_SHA 或源码检出的 .git
  if (capabilities.value.features.serverUpdate) {
    api
      .get('/api/update/state')
      .then((res) => {
        serverCommit.value = String(res.data?.commit || '');
      })
      .catch(() => {
        /* 未登录或接口不可用时保持纯版本号 */
      });
  }
});
</script>
