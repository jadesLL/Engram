/**
 * 「内置 Agent 控制台」的状态口径（纯函数，便于单测）。
 *
 * 2026-10 起控制台不再内嵌 dsh 网页，而是 Engram 原生整页
 * （views/AgentConsoleView.vue）；这里只负责「状态怎么讲给用户听」，
 * 不碰 DOM 也不发请求。服务端 JSON 的归一化在 lib/agentConsoleUi.ts。
 */

/** 状态函数只需要这两项（旧版状态接口与新 BFF /api/agent-console/status 都兼容） */
export interface ConsoleStatusLike {
  running: boolean;
  error: string;
}

/** 内置 Agent 卡片顶部摘要：dsh 版本 + profile，取不到显示「未知」 */
export function agentRuntimeSummary(status: { agentVersion?: unknown; profile?: unknown } | null | undefined): string {
  const version = String(status?.agentVersion ?? '').trim() || '未知';
  const profile = String(status?.profile ?? '').trim() || '未知';
  return `dsh ${version} · profile ${profile}`;
}

/** 控制台状态的短标签 + 色调（徽标 / 状态点） */
export function consoleStateLabel(status: Pick<ConsoleStatusLike, 'running' | 'error'> | null | undefined): {
  text: string;
  tone: 'ok' | 'warn' | 'muted';
} {
  if (!status) return { text: '未读取', tone: 'muted' };
  if (status.running) return { text: '运行中', tone: 'ok' };
  if (status.error) return { text: '启动失败', tone: 'warn' };
  return { text: '未启动', tone: 'muted' };
}

/** 生成时间：本地时区 YYYY-MM-DD HH:mm；坏输入返回空串 */
export function formatStartedAt(value: number | null | undefined): string {
  if (!value) return '';
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
