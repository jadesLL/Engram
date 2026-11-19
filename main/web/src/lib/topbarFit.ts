/**
 * 编辑顶栏密度：按「顶栏自身的可用宽度」收文案，不按窗口宽度。
 *
 * 起因（2026-11-19 用户报障）：窗口 ~920px、内置 Agent 抽屉 dock、文件树收起时，
 * 正文只剩 ~476px，顶栏把「已保存」挤到悬浮胶囊外面，自动保存开关整颗压在抽屉底下。
 * 窗口媒体查询在这里失明（viewport 仍是 920px），只能按顶栏量到的宽度分档。
 *
 * 分档只收「文案」，按钮本身（图标 / 开关 / 下拉箭头）都还在：
 *   full     引用位置 / 导出 / 正文宽度 / 已保存 / 自动保存 全部带文案
 *   compact  引用位置收成图标、自动保存只留开关、返回上一页只留图标（都会带 tooltip）
 *   mini     再把「导出」收成图标 + 下拉箭头
 *   micro    再把「正文宽度」整颗收起（手机从「格式」面板调，桌面从阅读视图调）
 *   nano     文件树与抽屉同时占位、正文只剩一窄条时，只留保存态（其余入口收起，换来不溢出）
 *
 * 阈值来自 2026-11-19 在 1280 / 1000 / 960 / 920 / 880 / 840 / 360 / 277（安卓外屏）等档
 * 实测的控件宽度（含 6 处间距 60 与左右内边距 22）：
 *   全量 468（引用位置 94 + 导出 86 + 宽度 62 + 保存态 47 + 自动保存 97 + 间距/内边距 82）
 *   精简 347（引用位置 30 + 导出 86 + 宽度 62 + 保存态 47 + 开关 40 + 间距/内边距 82）
 *   图标 315（导出 54）
 *   极窄 243（宽度收起）
 *   只剩保存态 89（实测 47 + 两处间距 20 + 内边距 22）
 * 每档都留 10–30px 余量（阈值不是「刚好放下」的那一像素）；返回键与手动保存按钮另算
 * （会随状态出现/消失）。
 */
export type TopbarDensity = 'full' | 'compact' | 'mini' | 'micro' | 'nano';

/** 全量档：实测 468px，阈值再留 ~32px（也让 960px 窗口在抽屉 dock 时落到精简档、标题留得住） */
const FULL_BASE = 500;
/** 精简档：实测 347px，阈值拉到 380px，840px 窗口（最小 dock 宽度）落到图标档 */
const COMPACT_BASE = 380;
/** 图标档：实测 315px，阈值 340px（360px 手机 / 840px 窗口 dock 都还有余量） */
const MINI_BASE = 340;
/** 极窄档：实测 243px，阈值 255px（安卓外屏 277px 的顶栏 257px 仍留在这一档） */
const MICRO_BASE = 255;

/** 返回上一页：全量档带文案，精简档起只剩图标 */
const BACK_FULL = 130;
const BACK_TIGHT = 55;
/** 关掉自动保存后出现的「保存」按钮：精简档起只剩图标 */
const SAVE_FULL = 63;
const SAVE_TIGHT = 30;

export interface TopbarFitContext {
  /** 面包屑旁有「返回上一页」 */
  hasBack?: boolean;
  /** 关掉自动保存后出现的「保存」按钮 */
  manualSave?: boolean;
}

/**
 * 顶栏可用宽度 → 密度档。
 * width <= 0（还没量到）时保持 full，避免首帧闪一下精简态。
 */
export function topbarDensityFor(width: number, ctx: TopbarFitContext = {}): TopbarDensity {
  if (!Number.isFinite(width) || width <= 0) return 'full';
  const { hasBack = false, manualSave = false } = ctx;
  if (width >= FULL_BASE + (hasBack ? BACK_FULL : 0) + (manualSave ? SAVE_FULL : 0)) return 'full';
  const tightExtra = (hasBack ? BACK_TIGHT : 0) + (manualSave ? SAVE_TIGHT : 0);
  if (width >= COMPACT_BASE + tightExtra) return 'compact';
  if (width >= MINI_BASE + tightExtra) return 'mini';
  if (width >= MICRO_BASE + tightExtra) return 'micro';
  return 'nano';
}

/**
 * 编辑视图宽度 → 顶栏宽度：扣掉悬浮条的左右外边距。
 * 桌面档 18px×2（见 EditorView 的 .editor-topbar）；窄屏档 CSS 覆盖成 10px×2。
 */
export function topbarWidthFor(editorWidth: number, narrow: boolean): number {
  if (!Number.isFinite(editorWidth) || editorWidth <= 0) return 0;
  return Math.max(0, Math.round(editorWidth - (narrow ? 20 : 36)));
}
