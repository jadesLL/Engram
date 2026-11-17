/**
 * 内置 Agent 首启引导（聊天抽屉底部「填 API Key 即可开始」）的显示判定。
 *
 * 服务端 `/api/assistant/status` 的 `modelConfigured` 合并了三处凭据来源（旧版 Engram 配置 /
 * `DEEPSEEK_API_KEY` 环境变量 / dsh 凭据文件）。只有它**明确为 false** 才显示引导：
 *  - 状态还没加载（null）或旧服务端不报这个字段时按「已配置」处理，避免抽屉一打开先闪一块设置卡；
 *  - 能力位两道门：`agent`（能用聊天）+ `agentConsole`（能写配置）。手机未绑定中枢时两者都 false，
 *    不会出现「填了也保存不了」的死入口。
 */
export interface AgentSetupStatus {
  modelConfigured?: boolean;
}

export interface AgentSetupFeatures {
  agent?: boolean;
  agentConsole?: boolean;
}

export function shouldShowAgentSetup(
  status: AgentSetupStatus | null | undefined,
  features: AgentSetupFeatures | null | undefined
): boolean {
  if (!status || status.modelConfigured !== false) return false;
  return features?.agent === true && features.agentConsole === true;
}

/** API Key 的最小规整：去掉首尾空白；全空白按未填处理 */
export function normalizeAgentApiKey(input: string): string {
  return (input || '').trim();
}
