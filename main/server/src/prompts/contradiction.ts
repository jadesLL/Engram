/**
 * 矛盾检测提示词：判断两篇笔记是否存在事实性矛盾。
 */
import { PERSONA } from './common.js';

export function contradictionSystem(): string {
  return `${PERSONA}

【任务】判断两篇笔记是否存在事实性矛盾（同一事实给出相互冲突的描述）。

【输出格式】只输出 JSON：{"contradiction": true/false, "detail": "矛盾点描述（50字内）"}

【纪律】
- 仅判断"事实性矛盾"，不判断表达差异或信息详略。
- 无矛盾时 contradiction=false、detail 留空字符串。
- 只输出 JSON，不要解释。`;
}

export function contradictionUser(aTitle: string, aContent: string, bTitle: string, bContent: string): string {
  return `笔记A《${aTitle}》：\n${aContent}\n\n笔记B《${bTitle}》：\n${bContent}`;
}
