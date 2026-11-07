/**
 * 模型输入能力（模态）声明。
 *
 * DSH 里两类模型配置各用一套字段名：
 *  - 官方模型目录（llm-deepseek）用 inputModalities；
 *  - pi-ai 自定义提供商的模型用 input（缺省表示未声明，由提供商默认能力兜底）。
 *
 * Engram 设置页只暴露「文本」「图片」两种最常用的能力位：文本是所有对话模型的基本盘，
 * 图片决定聊天输入框能不能挂图片/截图。其余（音频、视频等）暂不进入设置页，遇到也过滤掉。
 */

export const MODEL_INPUT_MODALITIES = ['text', 'image'] as const;

export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

/** 官方 DeepSeek 模型目录的默认输入能力：文本 + 图片 */
export const DEFAULT_OFFICIAL_INPUT_MODALITIES: string[] = ['text', 'image'];

/**
 * 归一化输入能力列表：只保留 text / image，去重（按首次出现顺序）。
 *
 * 非数组、空数组或过滤后什么都不剩，一律退回 fallback（调用方决定兜底值：
 * 官方目录传 ['text']，新建官方模型传 DEFAULT_OFFICIAL_INPUT_MODALITIES）。
 * 返回新数组，调用方可以放心改。
 */
export function normalizeInputModalities(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const modality = item.trim();
    if (!(MODEL_INPUT_MODALITIES as readonly string[]).includes(modality)) continue;
    if (out.includes(modality)) continue;
    out.push(modality);
  }
  return out.length > 0 ? out : [...fallback];
}
