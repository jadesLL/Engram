<template>
  <div class="qr-code" :style="{ width: `${size}px`, height: `${size}px` }">
    <canvas ref="canvasRef" class="qr-code-canvas" role="img" :aria-label="alt" />
    <p v-if="error" class="qr-code-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 二维码（自绘 canvas）。
 *
 * 用 canvas 而不是 <img src="data:...">：二维码要在浅色/深色主题、不同缩放与高分屏下都清晰，
 * 直接按 devicePixelRatio 铺像素最省事，也不必为一张临时图挂 blob URL。
 * 内容放不下时（超长链接）不画半张码，就地说明——扫不出来的二维码比一句错误提示更糟。
 */
import { onMounted, ref, watch } from 'vue';
import { encodeQrTextAuto, qrModule } from '../../lib/qrEncode';

const props = withDefaults(defineProps<{
  /** 二维码承载的文本（邀请链接） */
  text: string;
  /** 显示边长（CSS 像素） */
  size?: number;
  /** 无障碍名称 */
  alt?: string;
}>(), { size: 200, alt: '二维码' });

const canvasRef = ref<HTMLCanvasElement | null>(null);
const error = ref('');

/** 静区：规范要求四周至少留 4 个模块的浅色，少了会被很多扫码器直接忽略 */
const QUIET_MODULES = 4;

function draw(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const text = String(props.text || '');
  if (!text) {
    error.value = '';
    return;
  }
  let matrix;
  try {
    matrix = encodeQrTextAuto(text).matrix;
  } catch (e) {
    error.value = e instanceof Error ? e.message : '二维码生成失败';
    return;
  }
  error.value = '';
  const totalModules = matrix.size + QUIET_MODULES * 2;
  // 每个模块至少 1 像素：屏幕上的二维码至少要有 1 个 CSS 像素的模块才能真正扫出来
  const scale = Math.max(1, Math.floor(props.size / totalModules));
  const side = totalModules * scale;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(side * dpr);
  canvas.height = Math.round(side * dpr);
  canvas.style.width = `${side}px`;
  canvas.style.height = `${side}px`;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  // 底色固定为白色（不跟随深色主题）：很多扫码器按「深色模块 + 浅色底」阈值化，
  // 深色主题下把底色画成卡片色反而会降低识别率
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, side, side);
  context.fillStyle = '#000000';
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (!qrModule(matrix, x, y)) continue;
      context.fillRect((x + QUIET_MODULES) * scale, (y + QUIET_MODULES) * scale, scale, scale);
    }
  }
}

onMounted(draw);
watch(() => [props.text, props.size], draw);
</script>

<style scoped>
.qr-code {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
  padding: 8px;
  box-sizing: content-box;
  flex: none;
}

.qr-code-canvas {
  display: block;
  image-rendering: pixelated;
}

.qr-code-error {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--danger, #d64545);
  text-align: center;
}
</style>
