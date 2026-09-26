<template>
  <SettingsGroup class="settings-native" anchor="app-version" title="版本信息" hint="当前版本与提交身份" flush>
    <div class="setting-row">
      <div class="setting-copy">
        <strong>应用版本</strong>
        <span>{{ versionHint }}</span>
      </div>
      <code class="app-version">{{ versionLabel }}</code>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api';
import SettingsGroup from './SettingsGroup.vue';
import { APP_VERSION } from '../../version';
import { formatVersionHint, formatVersionLabel, type GitIdentity } from '../../lib/buildLabel';
import { useRuntimeCapabilities } from '../../lib/capabilities';

/**
 * 「本机应用 → 版本信息」分组。
 * 2026-09-28 从 AccountPanel 的「连接与版本」拆出（方案 A）：版本号属于"这台机器上跑的是哪一版"，
 * 放进「本机应用」；同一个分组里的「连接通道」留在「账户与访问」。
 *
 * 提交身份两个来源：桌面源码模式由主进程经 IPC 给出（含提交日期/脏标记），
 * Docker 镜像与浏览器访问由服务端 /api/update/state 给出（镜像内烤入 /app/GIT_SHA）。
 * 都拿不到时（安装包形态、无 git 的部署）退回纯版本号。
 */
const { capabilities, load: loadCapabilities } = useRuntimeCapabilities();

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
const versionLabel = computed(() => formatVersionLabel(APP_VERSION, identity.value));
// 说明文字区分源码模式/服务端构建/安装包三种情况；源码模式却读不到提交号时点明原因
// （Git 不可用），否则用户只看到一个光秃秃的版本号，既不知新旧也不知哪里坏了
// （2026-09-22 用户报「版本号只显示 1.2.7」即此，见 lib/buildLabel.ts）。
const versionHint = computed(() =>
  formatVersionHint({
    sourceMode: desktopEnv.value?.packaged === false,
    commit: identity.value.commit,
    fromServer: !desktopEnv.value?.commit && Boolean(serverCommit.value),
  }),
);

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
