/**
 * 编辑顶栏：窄正文时把低频项收进「更多 ⋯」菜单，顶栏不随宽度变形。
 *
 * 起因（2026-11-19 用户报障 + 定稿）：内置 Agent 抽屉 dock、文件树展开或窗口变窄后，
 * 正文只剩 ~476px，顶栏右侧一排控件溢出胶囊（「已保存」被挤到外面、自动保存开关被
 * 卡片盖住）。第一版按宽度逐档收文案 / 换图标被用户否掉——顶栏不该随正文宽度缩放；
 * 定稿改成「控件尺寸不变，放不下就把低频项收进 ⋯ 菜单」。
 *
 * 分档（width = 顶栏自身宽度，已扣掉左右外边距）：
 *   inline   全部平铺（现状）
 *   compact  ⋯ + 引用位置 / 导出 / 已保存 平铺；
 *            正文宽度、自动保存、手动保存 收进菜单
 *   mini     ⋯ + 已保存 平铺；引用位置 / 导出 / 返回上一页 也收进菜单
 *   nano     只留已保存（连 ⋯ 都放不下；文件树 + 抽屉同时占住正文的极端情况）
 *
 * 基准宽度都来自 2026-11-19 实测（1280 / 1000 / 960 / 920 / 880 / 840 / 360 / 277）：
 *   平铺 468（引用位置 94 + 导出 86 + 宽度 62 + 保存态 47 + 自动保存 97 + 间距/内边距 82）
 *   compact 337（引用位置 94 + 导出 86 + 保存态 47 + ⋯ 38 + 间距/内边距 72）
 *   mini 137（保存态 47 + ⋯ 38 + 间距/内边距 52）
 *   nano 89（保存态 47 + 间距/内边距 42）
 * 窄屏档（≤768）引用位置只剩图标、(≤640) 自动保存只剩开关，⋯ 档里「导出」也只留图标，
 * 基准宽度另算（见常量注释）。返回键（带文案 ~130）与手动保存按钮（~63）只在位时才算进阈值。
 */
export type TopbarMenuMode = 'inline' | 'compact' | 'mini' | 'nano';

/** 平铺档：桌面实测 468px */
const INLINE_BASE = 492;
/** 平铺档（窄屏 ≤768）：实测 341px（引用位置只剩图标、自动保存只剩开关） */
const INLINE_NARROW_BASE = 350;
/** ⋯ 档：桌面实测 337px */
const COMPACT_BASE = 355;
/** ⋯ 档（窄屏）：实测 235px（引用位置、导出都只剩图标） */
const COMPACT_NARROW_BASE = 250;
/** 只剩保存态 + ⋯：桌面实测 137px */
const MINI_BASE = 150;
/** 只剩保存态 + ⋯（窄屏）：实测 131px（内边距更薄） */
const MINI_NARROW_BASE = 140;
/** 返回上一页带文案 */
const BACK_FULL = 130;
/** 关掉自动保存后出现的手动保存按钮（平铺档在位，⋯ 档起收进菜单） */
const SAVE_FULL = 63;

export interface TopbarMenuContext {
  /** ≤768 视口：引用位置、自动保存的文案由既有媒体查询收起 */
  narrow?: boolean;
  /** 面包屑旁有「返回上一页」 */
  hasBack?: boolean;
  /** 关掉自动保存后出现的「保存」按钮 */
  manualSave?: boolean;
}

/**
 * 顶栏可用宽度 → 展示档。width <= 0（还没量到）时保持 inline，避免首帧闪一下 ⋯。
 */
export function topbarMenuModeFor(width: number, ctx: TopbarMenuContext = {}): TopbarMenuMode {
  if (!Number.isFinite(width) || width <= 0) return 'inline';
  const { narrow = false, hasBack = false, manualSave = false } = ctx;
  const inlineBase =
    (narrow ? INLINE_NARROW_BASE : INLINE_BASE) +
    (hasBack ? BACK_FULL : 0) +
    (manualSave ? SAVE_FULL : 0);
  if (width >= inlineBase) return 'inline';
  const compactBase = (narrow ? COMPACT_NARROW_BASE : COMPACT_BASE) + (hasBack ? BACK_FULL : 0);
  if (width >= compactBase) return 'compact';
  if (width >= (narrow ? MINI_NARROW_BASE : MINI_BASE)) return 'mini';
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
