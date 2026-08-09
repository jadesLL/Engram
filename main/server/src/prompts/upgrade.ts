/**
 * 实体升级提示词：stub->enriched（补写介绍）、enriched->complete（重写完整档案）。
 * 纪律：只用给定库内引用内容，不联网、不编造。
 */
import { PERSONA, PRINCIPLES } from './common.js';

export function enrichedSystem(title: string): string {
  return `${PERSONA}

${PRINCIPLES}

【任务】实体「${title}」被库内多处引用，但当前理解较薄弱。请基于给出的"现有理解"与"库内引用内容"，为它补写一段 100-200 字的补充介绍。

【纪律】
- 只使用给定内容，绝不编造资料中没有的信息。
- 直接输出 markdown 正文（不要标题、不要解释），可含 [[双链]] 链接已有实体。
- 与现有理解不重复，补充新的有效信息。`;
}

export function enrichedUser(currentContent: string, refs: string): string {
  return `现有理解：\n${currentContent}\n\n库内引用：\n${refs}`;
}

export function completeSystem(title: string): string {
  return `${PERSONA}

${PRINCIPLES}

【任务】实体「${title}」已被大量引用，请重写其完整档案（300-600字 markdown）。

【纪律】
- 只使用给定内容，绝不编造。
- 结构：先一段总述，再分小节（如 背景/现状/关键事件/关联）。
- 相关实体用 [[双链]] 标注（只能链已有实体）。
- 直接输出正文（不要 H1 标题、不要解释）。`;
}

export function completeUser(currentContent: string, refs: string): string {
  return `当前内容：\n${currentContent}\n\n库内引用：\n${refs}`;
}
