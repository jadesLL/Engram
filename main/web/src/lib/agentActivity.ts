import type { ChatSubagent, ChatToolCall } from '../stores/chat';
// 运行时要复用工具参数摘要；web 包的单测由 node 直接跑 .ts（无打包器），相对导入必须带真实扩展名
import { toolCallSummary } from './chatTimeline.ts';

/**
 * 内置 Agent「正在干什么」的文案：聊天抽屉的贴底状态条与最小化后的全局状态胶囊共用。
 *
 * 抽出来的原因：满窗形态下导航会让 Agent 最小化（抽屉随之卸载），右下角的状态胶囊要接着
 * 报同一句话；两处各写一份必然走样。这里只做纯字符串计算，不依赖 Vue，便于单测。
 */

/** 执行记录 / 状态条共用的工具中文名（与 ChatDrawer 的图标表同一套键） */
export const TOOL_LABELS: Record<string, string> = {
  search: '检索知识库',
  read_page: '读取页面',
  list_pages: '列出页面',
  list_raw_files: '列出原始资料',
  read_raw_file: '读取原始资料',
  write_page: '写入页面',
  page_evidence: '查看来源证据',
  related_pages: '查看关联页面',
  save_chat: '沉淀对话',
  kb_guide: '获取作业指南',
  skill_list: '列出作业技能',
  skill_guide: '获取作业技能',
  rename_page: '重命名页面',
  move_page: '移动页面',
  delete_page: '删除页面（回收站）',
  entity_name_check: '登记公司全名核验',
  entity_name_answer: '回填用户答复',
  entity_name_propose: '回填工商全名',
  list_entity_names: '读名称核验清单',
  entity_name_audit: '盘点公司页名称',
  // 提问：问题弹在对话最下侧，图标/状态条据此说明「它在等你点选」
  ask_user: '向你提问（对话底部弹窗）',
  // 委派类工具：正常会被子代理卡接管（不再单独成行），这里兜住没起成子会话的那次调用
  subagent: '派子代理',
  subagent_fork: '派子代理（继承对话）',
  workflow: '跑工作流',
  ralph: '跑 Ralph 循环',
  task: '派子代理',
};

/** MCP 前缀剥掉：mcp__engram__search → search */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__engram__/, '');
}

/** 工具中文名：没登记的工具直接显示原名 */
export function toolLabel(name: string): string {
  const bare = bareToolName(name);
  return TOOL_LABELS[bare] || bare;
}

/** 子代理卡片标题：模型给的短标签优先，退回派发工具卡上的描述，最后退回子会话号 */
export function subagentDisplayLabel(subagent: ChatSubagent, toolCalls: ChatToolCall[]): string {
  if (subagent.label) return subagent.label;
  const parent = subagent.parentCallId
    ? toolCalls.find((call) => call.id === subagent.parentCallId)
    : undefined;
  if (parent) {
    const summary = toolCallSummary(parent.args, 40);
    if (summary) return summary;
  }
  return `子会话 ${subagent.childSessionId.slice(0, 8)}`;
}

/**
 * 状态条 / 状态胶囊右侧那句「正在干什么」：子代理 → 工具 → 服务端状态文本 → 思考 → 生成回复。
 * 逐级退回，都为空时至少还有「正在回复」+ 秒表，用户永远看得出这一轮还活着。
 */
export function agentActivityText(input: {
  /** 本轮派出的、还在跑的子代理 */
  subagents: ChatSubagent[];
  /** 当前会话的工具调用（倒着找最后一条执行中的） */
  toolCalls: ChatToolCall[];
  /** 服务端推来的状态文本 */
  statusText: string;
  /** 最后一条是不是还在长的思考段 */
  thinking: boolean;
}): string {
  const running = input.subagents;
  if (running.length === 1) {
    return `子代理「${subagentDisplayLabel(running[0], input.toolCalls)}」运行中`;
  }
  if (running.length > 1) return `${running.length} 个子代理运行中`;

  const call = [...input.toolCalls].reverse().find((item) => item.status === 'running');
  if (call) {
    const summary = toolCallSummary(call.args, 24);
    return `执行 ${toolLabel(call.name)}${summary ? ` · ${summary}` : ''}`;
  }
  if (input.statusText) return input.statusText;
  if (input.thinking) return '正在思考';
  return '正在生成回复';
}
