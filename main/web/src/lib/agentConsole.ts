/**
 * 「内置 Agent 控制台」的状态口径（纯函数，便于单测）。
 *
 * 控制台就是 DeepSeek Harness 原生的网页界面（插件页 + 设置 → 模型 / 内置插件），
 * 由服务端在本机拉起并通过同源反向代理 /agent-console/ 嵌进设置页。
 * 这里只负责「状态怎么讲给用户听」，不碰 DOM 也不发请求。
 */

export interface ConsoleStatus {
  running: boolean;
  /** 控制台对外 origin（服务端按请求地址生成） */
  origin: string;
  /** 同源 iframe 路径（带一次性 token） */
  iframePath: string;
  startedAt: number | null;
  error: string;
  dshVersion: string | null;
}

/** 内置 Agent 卡片顶部摘要：dsh 版本 + profile，取不到显示「未知」 */
export function agentRuntimeSummary(status: { agentVersion?: unknown; profile?: unknown } | null | undefined): string {
  const version = String(status?.agentVersion ?? '').trim() || '未知';
  const profile = String(status?.profile ?? '').trim() || '未知';
  return `dsh ${version} · profile ${profile}`;
}

/** 控制台状态的短标签 + 色调（徽标 / 状态点） */
export function consoleStateLabel(status: Pick<ConsoleStatus, 'running' | 'error'> | null | undefined): {
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

/** 归一化服务端返回（字段缺失时按未运行降级，不让面板白屏） */
export function normalizeConsoleStatus(raw: unknown): ConsoleStatus {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    running: source.running === true,
    origin: String(source.origin ?? ''),
    iframePath: String(source.iframePath ?? ''),
    startedAt: typeof source.startedAt === 'number' ? source.startedAt : null,
    error: String(source.error ?? ''),
    dshVersion: source.dshVersion == null ? null : String(source.dshVersion),
  };
}
