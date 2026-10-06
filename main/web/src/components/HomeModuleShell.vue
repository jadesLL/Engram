<template>
  <!--
    整张卡就是拖拽把手：编辑态按在卡片任意空白处都能拖（手机桌面的手感）。
    缩放走右下角的把手（见文件末尾），键盘用户用页眉里的「拖动」按钮聚焦后按方向键。
  -->
  <section
    class="shell"
    :class="{ managing, dragging, target, locked: managing }"
    tabindex="-1"
    @pointerdown="onShellPointerDown"
  >
    <header class="shell-head">
      <!-- 编辑态的标题改成可点击重命名：比另开一个「重命名」按钮少一层入口 -->
      <button
        v-if="managing"
        class="shell-title as-button"
        type="button"
        :title="`重命名「${title}」`"
        @click="$emit('rename')"
      >
        <Icon :name="meta.icon" :size="13" />
        <span class="shell-title-text">{{ title }}</span>
        <Icon class="shell-title-pencil" name="pencil" :size="12" />
      </button>
      <h3 v-else class="shell-title" v-tooltip="meta.hint">
        <Icon :name="meta.icon" :size="13" />
        <span class="shell-title-text">{{ title }}</span>
      </h3>

      <div v-if="managing" class="shell-tools">
        <!-- 手柄同时是「键盘排序」的落点：Tab 到它，左右方向键换位（拖动是鼠标/手指的等价入口）。
             按键不在这里处理——HomeBoard 统一监听 keydown 并按 data-module-id 找回是哪个模块。 -->
        <button
          class="tool"
          type="button"
          :aria-label="`拖动「${title}」排序，或用左右方向键移动`"
          v-tooltip="'拖动排序（也可聚焦后按左右方向键）'"
          @pointerdown="$emit('drag-request', $event)"
        >
          <span class="grip" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
          <span class="tool-text">拖动</span>
        </button>
      </div>

      <slot name="actions" />
    </header>

    <div class="shell-body">
      <slot />
    </div>

    <!-- 编辑态底栏：宽度/高度快捷档 + 条数 + 删除，全都能键盘操作 -->
    <footer v-if="managing" class="shell-foot">
      <div class="spans" role="group" aria-label="模块宽度">
        <button
          v-for="option in widthOptions"
          :key="option.value"
          class="span-btn"
          type="button"
          :class="{ on: option.value === width }"
          :aria-pressed="option.value === width"
          v-tooltip="option.hint"
          @click="$emit('set-width', option.value)"
        >{{ option.label }}</button>
      </div>
      <div class="spans" role="group" aria-label="模块高度">
        <button
          v-for="heightOption in heightOptions"
          :key="heightOption"
          class="span-btn"
          type="button"
          :class="{ on: heightOption === height }"
          :aria-pressed="heightOption === height"
          v-tooltip="`占 ${heightOption} 行高`"
          @click="$emit('set-height', heightOption)"
        >{{ heightOption }}</button>
      </div>
      <!-- 条数档：列表类模块才给（速记 / 快捷入口这类没有「显示几条」这回事） -->
      <div v-if="limitSetting" class="stepper" role="group" aria-label="显示条数">
        <span class="stepper-label">显示</span>
        <button
          class="step-btn"
          type="button"
          :disabled="limitSetting.value <= limitSetting.min"
          aria-label="减少显示条数"
          @click="$emit('set-opt', 'limit', limitSetting.value - 1)"
        >−</button>
        <span class="stepper-value">{{ limitSetting.value }}</span>
        <button
          class="step-btn"
          type="button"
          :disabled="limitSetting.value >= limitSetting.max"
          aria-label="增加显示条数"
          @click="$emit('set-opt', 'limit', limitSetting.value + 1)"
        >+</button>
      </div>
      <slot name="settings" />
      <span class="foot-spacer" />
      <span class="foot-size" :class="{ over: crowded }">{{ width }}×{{ height }}</span>
      <button class="foot-btn danger" type="button" v-tooltip="'从首页删除这块'" aria-label="删除模块" @click="$emit('remove')">
        <Icon name="trash" :size="13" />
      </button>
    </footer>

    <!-- 缩放把手：拖它改宽高（编辑态才出现；右下角是「拉伸」的通用位置） -->
    <button
      v-if="managing"
      class="resize-handle"
      type="button"
      aria-label="拖动改变模块大小"
      v-tooltip="'拖动改大小（也可用 Shift+方向键）'"
      @pointerdown="$emit('resize-request', $event)"
    >
      <span class="rh-corner" aria-hidden="true" />
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import {
  HEIGHT_STEPS,
  moduleMeta,
  spanOptionsFor,
  type ModuleKind,
  type ModuleSpan,
} from '../lib/homeBoard.ts';
import { GRID_MAX_H, GRID_MAX_W, GRID_ROWS_VISIBLE } from '../lib/homeGrid.ts';

const props = withDefaults(
  defineProps<{
    kind: ModuleKind;
    /** 已生效标题（自定义标题或类型默认标题，由外层算好） */
    title: string;
    /** 宽度：6 列栅格上占几格（1–6，可以是拖出来的中间值） */
    width: number;
    /** 高度：占几行 */
    height: number;
    /** 该模块已生效的条数（列表类模块用；没有这项时为 undefined） */
    limit?: number;
    managing?: boolean;
    dragging?: boolean;
    /** 拖动高亮正落在这张卡上（松手后它就落这儿） */
    target?: boolean;
  }>(),
  { managing: false, dragging: false, target: false }
);

const emit = defineEmits<{
  (e: 'remove'): void;
  (e: 'set-width', width: number): void;
  (e: 'set-height', height: number): void;
  (e: 'rename'): void;
  (e: 'drag-request', event: PointerEvent): void;
  (e: 'resize-request', event: PointerEvent): void;
  (e: 'set-opt', key: string, value: string | number | boolean): void;
}>();

const meta = computed(() => moduleMeta(props.kind));

/**
 * 卡片上按下：编辑态时把「开始拖动」报给外层的看板组件。
 * 只在**空白处 / 页眉**按下才算拖，否则点标题改名、点底栏按钮、点内容里的链接都会被吞掉。
 */
function onShellPointerDown(event: PointerEvent) {
  if (!props.managing) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, a, input, textarea, select, .resize-handle')) return;
  emit('drag-request', event);
}

/**
 * 条数档位：只有列表类模块有这一项（最近更新 / 近期灵感 / 本周新增 / 近期待办）。
 * 上下限与 lib/homeBoard.ts 的归一化保持一致，界面不会给出存不下的值。
 */
const limitSetting = computed(() => {
  if (props.limit === undefined) return null;
  const max = props.kind === 'tasks' ? 20 : 12;
  return { value: Math.min(max, Math.max(1, props.limit)), min: 1, max };
});

/** 宽度档：6 列栅格上的 1/3 · 1/2 · 2/3 · 整行（拖动把手可以调到任意格，这里是快捷档） */
const widthOptions = computed(() => spanOptionsFor());
/** 高度档：常用几档；拖把手可以调到 1–12 行 */
const heightOptions = computed(() => HEIGHT_STEPS.filter((value) => value <= GRID_MAX_H));

/** 宽高都到极限时给个提示色：用户会看到「怎么拖都不动了」的边界 */
const crowded = computed(() => props.width >= GRID_MAX_W && props.height >= GRID_MAX_H);
void GRID_ROWS_VISIBLE;
</script>

<style scoped>
/*
 * 模块外壳：**首页上唯一的卡片外框**（描边 + 圆角 + 卡片底色 + 阴影）+ 抬头 + 内容 + 编辑态底栏。
 * 内容层（HomeBoardModules/*）不再自带外框，否则一页里会出现「有的有框有的没有」。
 * 大小由栅格决定（见 lib/homeGrid.ts）：.widget 上的 grid-column / grid-row 由数据直接写成，
 * 这里只管「填满自己的格子」并把超出部分收在内部滚动。
 */
.shell {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 13px 15px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card-bg);
  box-shadow: var(--shadow-card);
  cursor: grab;
  transition: opacity 150ms ease, box-shadow 150ms ease, transform 150ms ease, border-color 150ms ease;
}
.shell:hover { box-shadow: var(--shadow-card-hover, var(--shadow-card)); }
/* 非编辑态：卡片内容自己可点，别显示抓手 */
.shell:not(.managing) { cursor: default; }
.shell:not(.managing) .shell-body { flex: 1; min-height: 0; overflow: auto; }

/* 编辑态：虚线框 + 浅底色，边界看得见才敢拖 */
.shell.managing {
  border-style: dashed;
  border-color: var(--border-strong, var(--border));
  background: color-mix(in srgb, var(--bg-secondary) 60%, var(--card-bg));
  padding: 11px 12px 9px;
}
.shell.managing:hover { border-color: var(--accent); }

/* 被拖起来的那一块：半透明跟着指针，原位保持占位 */
.shell.dragging {
  opacity: 0.55;
  box-shadow: var(--shadow-card);
  transform: scale(0.99);
  cursor: grabbing;
}

/* 编辑态下模块内容不可点：拖动与点开页面不能共用一根手指 */
.shell.locked .shell-body { pointer-events: none; }
.shell.locked .shell-body :deep(button) { cursor: default; }

.shell-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.shell-title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--text-faint);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.shell-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shell-title.as-button {
  padding: 3px 7px;
  margin-left: -7px;
  border-radius: 7px;
  transition: background 150ms ease, color 150ms ease;
}
.shell-title.as-button:hover { background: var(--sidebar-hover); color: var(--text-secondary); }
.shell-title.as-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.shell-title-pencil { opacity: 0.7; }

.shell-tools { display: flex; align-items: center; gap: 4px; }

.tool {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: grab;
  /* 手指按在手柄上时不要触发页面滚动：拖动靠 pointermove，交给浏览器滚就断了 */
  touch-action: none;
}
.tool:hover { border-color: var(--accent); color: var(--text); }
.tool:active { cursor: grabbing; }

/* 六点手柄：纯装饰，用两列三点画出来（不引图标资源） */
.grip {
  display: grid;
  grid-template-columns: repeat(2, 2px);
  gap: 2px;
  width: 6px;
}
.grip i { display: block; width: 2px; height: 2px; border-radius: 50%; background: currentColor; opacity: 0.75; }
.tool-text { letter-spacing: 0; }

.shell-body { min-width: 0; }

.shell-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
}
.foot-spacer { flex: 1; }

/* 当前尺寸（几列 × 几行）：拖把手时数字会跟着变，边界一眼可见 */
.foot-size {
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--bg-tertiary, var(--bg));
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.foot-size.over { background: var(--accent-soft); color: var(--accent); }

/* 缩放把手：右下角的斜纹角，拖它改宽高 */
.resize-handle {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 3px;
  border-radius: 6px;
  cursor: nwse-resize;
  color: var(--text-faint);
  transition: background 150ms ease, color 150ms ease;
  /* 手指按下时不要触发页面滚动：拖动靠 pointermove */
  touch-action: none;
}
.resize-handle:hover { background: var(--accent-soft); color: var(--accent); }
.resize-handle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.rh-corner {
  width: 9px;
  height: 9px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  border-bottom-right-radius: 3px;
}

.spans {
  display: flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
}
.span-btn {
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--text-faint);
  font-size: 11px;
  transition: background 150ms ease, color 150ms ease;
}
.span-btn:hover { color: var(--text-secondary); }
.span-btn.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.span-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* 条数档：显示 N 条的加减步进器 */
.stepper {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
}
.stepper-label { font-size: 11px; color: var(--text-faint); }
.stepper-value { min-width: 14px; text-align: center; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.step-btn {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1;
  transition: background 150ms ease, color 150ms ease;
}
.step-btn:hover:not(:disabled) { background: var(--sidebar-hover); color: var(--text); }
.step-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.step-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.foot-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text-secondary);
  transition: border-color 150ms ease, color 150ms ease, background 150ms ease;
}
.foot-btn:hover { border-color: var(--accent); color: var(--accent); }
.foot-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.foot-btn.danger:hover { border-color: var(--danger); color: var(--danger); background: var(--danger-soft); }

/* 落点线：拖到哪儿就画在那一侧的边缘（贴着自己的左右边，不越出 .board 的裁剪区） */
.drop-line {
  position: absolute;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  pointer-events: none;
}
.drop-line.before { left: 0; }
.drop-line.after { right: 0; }
</style>
