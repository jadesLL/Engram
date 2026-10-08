/**
 * 首页卡片的「尺寸档位 → 内容档位」映射（2026-10-07 按尺寸重排内容）。
 *
 * 核心思路：跨档换布局，不再靠把字号越缩越小来凑合小卡片。
 * 档位由**栅格格数**决定（用户在尺寸菜单里看到的 w × h），与像素无关：
 *  - tile     1×1      纯磁贴：图标 + 核心数值（状态类 = 圆点 + 结论）+ 一行短标签，无标题栏
 *  - bar      h=1,w≥2  横条：左边数值、右边「一条最重要的信息」
 *  - column   w=1,h≥2  竖条：数值 + 精简列表（只有标题，行拉伸铺满）
 *  - standard w≥2,h≥2  标准卡：标题栏（外壳负责）+ 数值行 + 列表 / 图表，行均分铺满
 * 宽卡（w≥4）与 standard 同布局，行更宽而已。
 *
 * 像素级的行数 / 图表高度预算由 cardContentPlan 按实际渲染尺寸计算，
 * 行本身用 flex:1 拉伸铺满——行数少时行变高，不留底部空白。
 * 尺寸只决定展示密度，不修改业务数据或布局。
 */
export interface HomeCardRow {
  text: string;
  detail?: string | number;
  amount?: number;
  path?: string;
  action?: 'chat' | 'capture';
}

/** 状态结论的色调：ok = 正常（绿点），warn = 需要注意（橙点），muted = 未配置 / 无数据（灰点） */
export type HomeCardStatusTone = 'ok' | 'warn' | 'muted';

export interface HomeCardSummary {
  value: string | number;
  label: string;
  rows?: HomeCardRow[];
  empty?: string;
  chart?: 'bars' | 'ring' | 'trend';
  /**
   * 状态结论（同步 / 系统类）：小圆点 + 一句话，磁贴与横条档优先显示它。
   * 设计规则「数字大、状态小」：状态永远 15–19px 正文色，不用大字彩色。
   */
  status?: { tone: HomeCardStatusTone; text: string };
  /** 数值后的小胶囊角标（如待办的「2 逾期」） */
  badge?: { tone: 'danger' | 'ok'; text: string };
  /** 动作型卡片（漫游 / 速记 / 快捷入口）：value 是动作文案，主色小字显示，不放大 */
  action?: boolean;
}

export type HomeCardTier = 'tile' | 'bar' | 'column' | 'standard';

/**
 * 栅格格数 → 内容档位（w/h 是 GRID_COLS 列栅格上的列数 / 行数，不是像素）。
 * 12 列栅格下：1×1 ≈ 75px，2×1 ≈ 164px，1×2 ≈ 75×164。
 */
export function cardTier(w: number, h: number): HomeCardTier {
  if (w <= 1 && h <= 1) return 'tile';
  if (h <= 1) return 'bar';
  if (w <= 1) return 'column';
  return 'standard';
}

export interface CardContentPlan {
  /** 列表显示几行（行高 = 剩余空间 ÷ 行数，行永远拉伸铺满） */
  rows: number;
  /** 图表（环 / 趋势）高度；bars 是行内条形不占这块预算 */
  chartHeight: number;
  gap: number;
  /** 窄卡（竖条档或像素宽度不足）：行只显示标题、数值换小一号 */
  narrow: boolean;
}

/**
 * 标准 / 竖条档的高度预算：数值行 + 图表 + N 行，全部塞进 height 里。
 * 行高取「放得下且不挤」的最小值（标准 34 / 条形行 38 / 窄卡 30），
 * 实际渲染时行用 flex:1 均分剩余高度，所以这里算的是**行数上限**，不是行高。
 */
export function cardContentPlan(width: number, height: number, count: number, chart?: HomeCardSummary['chart']): CardContentPlan {
  const narrow = width < 120;
  const metricHeight = narrow ? 44 : 46;
  const gap = 10;
  const remaining = Math.max(0, height - metricHeight - gap);
  const chartHeight = !narrow && chart && chart !== 'bars' && remaining >= 70
    ? Math.min(180, Math.floor(remaining * 0.4))
    : 0;
  const rowHeight = narrow ? 30 : chart === 'bars' ? 38 : 34;
  const rows = Math.min(
    Math.max(0, count),
    Math.max(0, Math.floor((remaining - chartHeight - (chartHeight ? gap : 0)) / rowHeight))
  );
  return { rows, chartHeight, gap, narrow };
}
