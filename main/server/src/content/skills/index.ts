import type { SkillDoc } from './types.js';
import { SKILL as docxMeetingToMd } from './docxMeetingToMd.js';
import { SKILL as kbIngestDiscipline } from './kbIngestDiscipline.js';

/**
 * 内置 skill 注册表（单一来源）。
 * 顺序即 skill_list 的展示顺序；新增 skill 时在此登记，并同步：
 *   - web/src/lib/mcpTools.ts（Agent 接入界面的工具清单）
 *   - main/docs/AI-CONTENT-OPERATIONS.md、README.md
 */
export const SKILLS: SkillDoc[] = [docxMeetingToMd, kbIngestDiscipline];

/** 按名取 skill；不存在返回 undefined（调用方负责给出可用清单） */
export function findSkill(name: string): SkillDoc | undefined {
  const target = String(name || '').trim().toLowerCase();
  return SKILLS.find((skill) => skill.name.toLowerCase() === target);
}
