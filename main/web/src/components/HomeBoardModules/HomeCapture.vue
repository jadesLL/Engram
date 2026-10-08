<template>
  <HomeActionComposer mode="capture" :title="title" :width="width" :height="height" :expanded="expanded" :submit="submit" :variant="variant" :ideas="ideas" @new="$emit('new')" @open="$emit('open')" @go="$emit('go', $event)" />
</template>
<script setup lang="ts">
import HomeActionComposer from './HomeActionComposer.vue';
defineProps<{ title: string; width: number; height: number; expanded: boolean; submit: (content: string) => Promise<boolean>; variant?: number; ideas: any[] }>();
defineEmits<{ (e: 'open' | 'new'): void; (e: 'go', path: string): void }>();
</script>
