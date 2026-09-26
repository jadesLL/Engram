<template>
  <SettingsGroup class="settings-native" anchor="account-appearance" title="外观" hint="界面显示方式" :default-open="true" flush>
    <div class="setting-row">
      <div class="setting-copy">
        <strong>主题</strong>
        <span>选择浅色、深色或跟随系统。</span>
      </div>
      <div class="segmented" role="radiogroup" aria-label="主题">
        <button
          v-for="opt in themeOptions"
          :key="opt.value"
          type="button"
          role="radio"
          :aria-checked="app.theme === opt.value"
          :class="{ active: app.theme === opt.value }"
          @click="app.setTheme(opt.value as any)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div class="setting-row">
      <div class="setting-copy">
        <strong>悬停提示严格避让</strong>
        <span>提示只贴在被说明对象的四周（不外移、不画引导线）。开启后逐边比较，优先选不压住内容的一边，必要时换边或收窄气泡；关闭后优先贴首选方向显示，允许轻微遮挡。</span>
      </div>
      <label class="switch-control">
        <input type="checkbox" :checked="tipStrict" @change="toggleTipStrict" />
        <span aria-hidden="true"></span>
        <em>{{ tipStrict ? '已开启' : '已关闭' }}</em>
      </label>
    </div>

    <div class="setting-row">
      <div class="setting-copy">
        <strong>显示 AI 工作区</strong>
        <span>侧栏里的「AI 工作区」是服务端自动生成的操作日志、全库索引与关系库，日常不需要看，默认隐藏。打开后它出现在侧栏底部（只读）。</span>
      </div>
      <label class="switch-control">
        <input type="checkbox" :checked="app.showAiWorkspace" @change="toggleAiWorkspace" />
        <span aria-hidden="true"></span>
        <em>{{ app.showAiWorkspace ? '已显示' : '已隐藏' }}</em>
      </label>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import SettingsGroup from './SettingsGroup.vue';
import { useAppStore } from '../../stores/app';
import { notify } from '../../lib/notify';
import { getTooltipStrict, setTooltipStrict } from '../../lib/tooltip';

/**
 * 「界面与检索 → 外观」分组。
 * 2026-09-28 从 AccountPanel 拆出（方案 A「一事一类」）：外观属于「界面与检索」，
 * 与账户凭据不再同页；拆出后 AccountPanel 只剩账户与连接通道。
 */
const app = useAppStore();

// 悬停提示避让强度（全局偏好，存 localStorage；提示引擎每次显示时读取）
const tipStrict = ref(getTooltipStrict());
function toggleTipStrict(event: Event): void {
  const on = (event.target as HTMLInputElement).checked;
  tipStrict.value = on;
  setTooltipStrict(on);
  notify.success(on ? '悬停提示：严格避让（不遮挡内容）' : '悬停提示：就近优先');
}

/** 侧栏「AI 工作区」显示开关：默认隐藏，打开后写服务端设置（多端一致，失败回滚） */
async function toggleAiWorkspace(event: Event): Promise<void> {
  const on = (event.target as HTMLInputElement).checked;
  try {
    await app.setShowAiWorkspace(on);
    notify.success(on ? 'AI 工作区：已显示在侧栏底部' : 'AI 工作区：已隐藏');
  } catch {
    notify.error('保存失败，请重试');
  }
}

const themeOptions = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];
</script>
