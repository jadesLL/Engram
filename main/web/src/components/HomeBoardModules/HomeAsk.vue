<template>
  <HomeActionComposer mode="ask" :title="title" :width="width" :height="height" :expanded="expanded" :submit="send" @open="$emit('open')" @continue="app.toggleChat(true)" @submitted="$emit('close')" />
</template>
<script setup lang="ts">
import HomeActionComposer from './HomeActionComposer.vue';
import { useChatStore } from '../../stores/chat';
import { useAppStore } from '../../stores/app';
defineProps<{ title: string; width: number; height: number; expanded: boolean }>();
defineEmits<{ (e: 'open' | 'close'): void }>();
const chat = useChatStore(), app = useAppStore();
async function send(content: string): Promise<boolean> {
  // Open the drawer after acceptance, so its init cannot race the first send.
  const accepted = await chat.send(content, { route: '/' });
  if (accepted) app.toggleChat(true);
  else throw new Error(chat.error || '问题没有发出，请稍后重试。');
  return accepted;
}
</script>
