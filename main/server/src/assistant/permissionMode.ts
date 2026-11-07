/**
 * 内置 Agent 的权限模式（dsh 的 DSH_PERMISSION_MODE）。
 *
 * 取值与 dsh 的沙箱模式一一对应：
 *  - read-only：只读，不能修改任何文件；
 *  - workspace-write：只能改内置 Agent 的工作目录，越界操作被拒绝；
 *  - danger-full-access：完全访问，不限制文件修改，也不要求审批（默认）。
 *
 * 默认选「完全访问」：内置 Agent 跑在独立空壳工作目录里（不是知识库目录），知识库只经 MCP
 * 工具访问，逐次弹审批只会打断长任务。用户可在 设置 → Agent 与自动化 里改成更保守的模式。
 * 配置存在 Engram 自己的 agent_config（见 config.ts），启动 dsh 时再注入环境变量。
 */

export const AGENT_PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

/** 默认权限：完全访问（不限制文件修改，也不要求审批） */
export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'danger-full-access';

export interface AgentPermissionOption {
  value: AgentPermissionMode;
  label: string;
  description: string;
}

/** 设置页展示用的权限选项（默认项放最前，前端按顺序渲染） */
export const AGENT_PERMISSION_OPTIONS: AgentPermissionOption[] = [
  {
    value: 'danger-full-access',
    label: '完全访问',
    description: '不限制文件修改，也不要求审批（默认）',
  },
  {
    value: 'workspace-write',
    label: '工作区写入',
    description: '只能修改内置 Agent 工作目录，越界操作会被拒绝',
  },
  {
    value: 'read-only',
    label: '只读',
    description: '不能修改任何文件',
  },
];

/**
 * 归一化权限模式：不认识的配置值一律退回默认。
 *
 * 旧配置、手改 setting、未来删掉的模式都可能出现脏值；退回默认比让运行时卡在
 * 一个 dsh 不认识的环境变量值上安全。
 */
export function normalizeAgentPermissionMode(value: unknown): AgentPermissionMode {
  return typeof value === 'string' && (AGENT_PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as AgentPermissionMode)
    : DEFAULT_AGENT_PERMISSION_MODE;
}

/** 返回选项副本（调用方改不到共享常量，避免一个路由改了影响全局） */
export function agentPermissionOptions(): AgentPermissionOption[] {
  return AGENT_PERMISSION_OPTIONS.map((option) => ({ ...option }));
}
