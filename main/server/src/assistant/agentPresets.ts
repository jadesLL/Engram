/**
 * 控制台「Agent 预设」的默认值口径。
 *
 * 聊天运行时（SDK）并不挂 web 层的 agent preset（见 agentPatch.ts 顶部说明），preset 只影响
 * 控制台 / 网页工作台的新任务。对 Engram 的用户来说，「标准模式」就是最合适的默认：不额外
 * 开工具编排、也不像极简模式那样砍掉文件与命令能力。所以用户没在控制台选过、DSH 也没标
 * isDefault 时，这里兜底成 standard，避免设置页显示「还没有可用的默认预设」。
 */

export interface PresetCandidate {
  id?: unknown;
  isDefault?: unknown;
}

/** 新任务默认预设：用户选过 > DSH 自带 isDefault > 标准模式 > 空串（没有标准模式时） */
export function pickDefaultPresetId(selected: unknown, presets: ReadonlyArray<PresetCandidate>): string {
  if (typeof selected === 'string' && selected.trim()) return selected.trim();
  const explicit = presets.find((item) => item?.isDefault === true && typeof item.id === 'string' && item.id);
  if (explicit) return String(explicit.id);
  const hasStandard = presets.some((item) => item?.id === 'standard');
  return hasStandard ? 'standard' : '';
}
