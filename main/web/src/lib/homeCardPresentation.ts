/** 首页尺寸只决定展示密度，不修改业务数据或布局。 */
export interface HomeCardRow {
  text: string;
  detail?: string | number;
  amount?: number;
  path?: string;
  action?: 'chat' | 'capture';
}
export interface HomeCardSummary {
  value: string | number;
  label: string;
  rows?: HomeCardRow[];
  empty?: string;
  chart?: 'bars' | 'ring' | 'trend';
}
export function cardContentPlan(width: number, height: number, count: number, chart?: HomeCardSummary['chart']) {
  const narrow = width < 110;
  const tiny = height < 48;
  const ribbon = !tiny && height < 88 && width >= 130;
  const metricHeight = tiny ? 24 : narrow ? 38 : 45;
  const gap = tiny ? 2 : narrow ? 5 : 10;
  const remaining = Math.max(0, height - metricHeight - gap);
  const chartHeight = !ribbon && !tiny && chart && chart !== 'bars' && remaining >= 65
    ? Math.min(180, Math.floor(remaining * .4)) : 0;
  const rowHeight = narrow ? 32 : chart === 'bars' ? 37 : 35;
  const rows = tiny ? 0 : ribbon ? Math.min(count, Math.max(1, Math.floor((width - 65) / 100)))
    : Math.min(count, Math.max(0, Math.floor((remaining - chartHeight - (chartHeight ? gap : 0)) / rowHeight)));
  return { narrow, tiny, ribbon, rows, chartHeight, gap };
}
