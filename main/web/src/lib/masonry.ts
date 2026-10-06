/**
 * 瀑布流布局（2026-10-06 方案 E）：按顺序把卡片放进合适的位置，卡片**跨几条车道**由格数决定。
 *
 * 为什么不用 `column-count`：
 *  - 多列布局的填充顺序是「先填满第一列再填第二列」，用户拖出来的先后顺序会被打乱；
 *  - 它也没法让某张卡跨列（首页整行的「看板快照」「Agent 摘要」就需要）。
 * 所以这里用绝对定位自己排：顺序 = 数组顺序，宽度 = 格数 × 车道宽，高度用 ResizeObserver 跟住。
 *
 * 与其它两套机制的关系：
 *  - 窄屏降级：车道数由可用宽度算出来（见 masonryCalc 的 laneCount），只剩一条时退回普通文档流；
 *  - 拖拽：拖动期间不改布局（卡片留在原位、落点线照画），拖完由 watch 重排；
 *  - 减动效：`prefers-reduced-motion` 时不播位移过渡（样式侧处理）。
 */
import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue';
import { GAP, laneCount, maxSpan, placeCards } from './masonryCalc.ts';

/** 每个元素进入时最多等多少帧（正常 1–2 帧就量到高度了） */
const MAX_ENTER_FRAMES = 3;

export interface MasonryOptions {
  /** 布局根（.board-grid） */
  container: Ref<HTMLElement | undefined>;
  /** 数据数组：长度或每项格数变化即重排 */
  items: Ref<ArrayLike<{ span: number }>>;
  /** 用户选的整页列数（宽不够时自动少开车道） */
  columns: Ref<number>;
  /** 编辑态：编辑时卡片要能撑开底栏，重排照旧 */
  editing: Ref<boolean>;
}

export function useMasonryLayout(options: MasonryOptions) {
  let observer: ResizeObserver | null = null;
  let frame = 0;
  let tracking = false;
  const seen = new Set<Element>();

  function layout() {
    const host = options.container.value;
    if (!host) return;
    const items = Array.from(host.children) as HTMLElement[];
    if (!items.length) {
      host.style.height = '';
      return;
    }

    const spans = items.map((_el, index) => {
      const raw = Number(options.items.value?.[index]?.span);
      return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 1;
    });
    const width = host.clientWidth;
    // 车道数：「页面需要的最大格数」与「宽能排下几条」取小的那个
    const lanes = laneCount(width, Math.min(options.columns.value, maxSpan(spans)));
    host.dataset.masonryLanes = String(lanes);

    // 一条车道：普通文档流（手机 / 极窄正文不需要瀑布流）
    if (lanes <= 1) {
      for (const el of items) {
        el.style.position = '';
        el.style.left = '';
        el.style.top = '';
        el.style.width = '';
        el.style.transform = '';
      }
      host.style.height = '';
      host.dataset.masonrySingle = '1';
      return;
    }
    host.dataset.masonrySingle = '0';

    const laneWidth = (width - GAP * (lanes - 1)) / lanes;
    const clamped = spans.map((span) => Math.max(1, Math.min(lanes, span)));

    // 先定宽再量高：顺序不能反（宽度会改变换行后的高度）
    for (const el of items) {
      el.style.position = 'absolute';
      el.style.left = '0px';
    }
    items.forEach((el, index) => {
      const span = clamped[index];
      el.style.width = `${span * laneWidth + (span - 1) * GAP}px`;
    });

    // 量完高度交给纯计算排布（碰撞检测补空档，见 masonryCalc.placeCards）
    const heights = items.map((el) => el.offsetHeight);
    const rects = placeCards(clamped, heights, width, lanes, GAP);
    items.forEach((el, index) => {
      const rect = rects[index];
      el.style.top = `${rect.y}px`;
      el.style.transform = `translateX(${rect.x}px)`;
    });

    let bottom = 0;
    for (const rect of rects) bottom = Math.max(bottom, rect.y + rect.height);
    host.style.height = `${bottom ? bottom + GAP : 0}px`;
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  }

  /** 每张卡都跟住自己的高度：内容异步到达（列表接口、看板）会改变高度，布局要跟着重排 */
  function track() {
    const host = options.container.value;
    if (!host || tracking) return;
    tracking = true;
    observer = new ResizeObserver(() => schedule());
    observer.observe(host);
    const wire = () => {
      for (const el of Array.from(host.children)) {
        if (seen.has(el)) continue;
        seen.add(el);
        observer?.observe(el);
      }
    };
    wire();
    // 子元素是 v-for 渲染的：容器尺寸变化时补挂一次（新加 / 删除卡片都会走这里）
    new MutationObserver(wire).observe(host, { childList: true });
    schedule();
  }

  onMounted(() => {
    track();
    // 入场：先量一次真实高度，避免初始 top 全是 0
    nextTick(() => {
      let tries = 0;
      const tick = () => {
        layout();
        if (tries++ < MAX_ENTER_FRAMES) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  });

  // 顺序 / 格数 / 列数 / 编辑态变化都重排
  watch(
    () => options.items.value?.length ?? 0,
    () => nextTick(schedule)
  );
  watch(
    () => Array.from(options.items.value || []).map((item) => item.span).join(','),
    () => nextTick(schedule)
  );
  watch(() => options.columns.value, () => nextTick(schedule));
  watch(() => options.editing.value, () => nextTick(schedule));

  return { relayout: schedule };
}
