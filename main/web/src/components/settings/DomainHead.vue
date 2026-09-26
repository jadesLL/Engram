<template>
  <header v-if="domain" class="domain-head">
    <div>
      <h3>{{ domain.label }}</h3>
      <p>{{ domain.desc }}</p>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { SettingsDomain } from '../../lib/settingsDomains';

/**
 * 大类页头：一级分类名 + 「这一套管什么」的一句话说明。
 * 文案来自 lib/settingsDomains.ts（改分类只改一处），设置页七处页头共用本组件，
 * 避免七段重复模板与数据走偏。
 */
defineProps<{ domain?: SettingsDomain }>();
</script>
