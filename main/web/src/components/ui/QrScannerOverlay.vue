<template>
  <Teleport to="body">
    <div v-if="open" class="qr-scanner" role="dialog" aria-modal="true" :aria-label="title">
      <div class="qr-scanner-card">
        <div class="qr-scanner-view">
          <!-- 取景框：video 铺满，reticle 只是视觉引导（不参与识别） -->
          <video ref="videoRef" class="qr-scanner-video" playsinline muted autoplay />
          <div class="qr-scanner-reticle" aria-hidden="true" />
          <canvas ref="canvasRef" class="qr-scanner-canvas" aria-hidden="true" />
          <p v-if="errorText" class="qr-scanner-error">{{ errorText }}</p>
        </div>
        <div class="qr-scanner-text">
          <strong>{{ title }}</strong>
          <span>{{ hint }}</span>
        </div>
        <div class="qr-scanner-actions">
          <button class="btn" type="button" :disabled="!ready" @click="switchCamera">换摄像头</button>
          <button class="btn primary" type="button" @click="close">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 扫码浮层：手机对着中枢屏幕上的二维码扫一下就完成「不用手抄地址与令牌」。
 *
 * 只负责取景与交互，识别逻辑在 lib/qrScan.ts（`<video>` 抽帧 → jsqr 解码）。
 * 安卓端由 Capacitor 的 WebViewClient 在取流时向系统申请相机权限（首次会弹系统权限框），
 * 浏览器端由系统弹框；拿不到权限时把原因写在取景框里，而不是让用户对着黑屏发呆。
 * 返回键（安卓侧滑/返回）会先关掉这一层，见 registerBackHandler。
 */
import { onUnmounted, ref, watch } from 'vue';
import { cameraErrorMessage, cameraScanSupport, startCameraScan, type QrCameraSession } from '../../lib/qrScan';
import { registerBackHandler } from '../../lib/androidBack';

const props = withDefaults(defineProps<{
  open: boolean;
  title?: string;
  hint?: string;
}>(), {
  title: '扫码绑定',
  hint: '把中枢屏幕上的二维码放进取景框，识别后会自动填好中枢地址与绑定令牌',
});

const emit = defineEmits<{ (event: 'result', text: string): void; (event: 'close'): void }>();

const videoRef = ref<HTMLVideoElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const errorText = ref('');
const ready = ref(false);
let session: QrCameraSession | null = null;
let unregisterBack: (() => void) | null = null;

/** 取到结果就收工：先关摄像头再交给上层（避免上层弹提示时相机还亮着） */
function handleResult(text: string): void {
  stopSession();
  emit('result', text);
}

async function startSession(): Promise<void> {
  const support = cameraScanSupport();
  if (!support.supported) {
    errorText.value = support.reason;
    return;
  }
  errorText.value = '';
  ready.value = false;
  // 等一帧让 <video> 挂上 DOM（Teleport 内的元素在 open 变 true 后才渲染）
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  const video = videoRef.value;
  const canvas = canvasRef.value;
  if (!video || !canvas) return;
  try {
    session = await startCameraScan({
      video,
      canvas,
      onResult: handleResult,
      onError: (message) => { errorText.value = message; },
    });
    ready.value = true;
  } catch (error) {
    errorText.value = cameraErrorMessage(error);
  }
}

function stopSession(): void {
  session?.stop();
  session = null;
  ready.value = false;
}

function close(): void {
  stopSession();
  emit('close');
}

async function switchCamera(): Promise<void> {
  if (!session) return;
  try {
    await session.switchCamera();
    ready.value = true;
  } catch (error) {
    errorText.value = cameraErrorMessage(error);
  }
}

watch(() => props.open, (open) => {
  if (open) {
    unregisterBack = registerBackHandler(() => {
      close();
      return true;
    });
    void startSession();
  } else {
    unregisterBack?.();
    unregisterBack = null;
    stopSession();
  }
}, { immediate: true });

onUnmounted(() => {
  unregisterBack?.();
  unregisterBack = null;
  stopSession();
});
</script>

<style scoped>
.qr-scanner {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay, 100);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 居中的扫码卡片同样要避开安卓系统栏：小屏 + 大字体会把卡片顶进状态栏（桌面端 --safe-* 为 0） */
  padding: calc(20px + var(--safe-top)) calc(20px + var(--safe-right))
    calc(20px + var(--safe-bottom)) calc(20px + var(--safe-left));
  background: rgb(0 0 0 / 55%);
}

.qr-scanner-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, 100%);
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card-bg, var(--bg));
  box-shadow: var(--shadow-dialog);
}

.qr-scanner-view {
  position: relative;
  aspect-ratio: 4 / 3;
  width: 100%;
  overflow: hidden;
  border-radius: 8px;
  background: #000;
}

.qr-scanner-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 取景框：中间一块引导区（识别是全画面找码，不要求用户对准这块方框） */
.qr-scanner-reticle {
  position: absolute;
  inset: 18%;
  border: 2px solid rgb(255 255 255 / 80%);
  border-radius: 10px;
  box-shadow: 0 0 0 2000px rgb(0 0 0 / 18%);
  pointer-events: none;
}

/* 抽帧用的画布：不显示，只作为 jsqr 的像素来源 */
.qr-scanner-canvas {
  display: none;
}

.qr-scanner-error {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 18px;
  color: #fff;
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
  background: rgb(0 0 0 / 72%);
}

.qr-scanner-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.qr-scanner-text strong {
  font-size: 14px;
  color: var(--text);
}

.qr-scanner-text span {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.qr-scanner-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
