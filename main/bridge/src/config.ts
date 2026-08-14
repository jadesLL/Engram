/**
 * 桥接服务配置。所有值来自环境变量，ExampleProject 的 MCP 端点与各 IM 开放平台凭证。
 *
 * 不在 import 时抛错（便于无凭证环境做 typecheck/test）：原始值以字符串持有，
 * 必需项由 assertConfigured() 在启动时一次性校验。
 */

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(env('PORT', '8090')),
  host: env('HOST', '0.0.0.0'),

  /** ExampleProject MCP 端点，如 http://example-wiki:8080/mcp */
  exampleprojectMcpUrl: env('WIKILLM_MCP_URL'),
  /** MCP Bearer token，形如 lwiki_...，在 ExampleProject Settings 里生成 */
  exampleprojectMcpToken: env('WIKILLM_MCP_TOKEN'),

  feishu: {
    appId: env('FEISHU_APP_ID'),
    appSecret: env('FEISHU_APP_SECRET'),
    /** 事件订阅加密密钥，配置后事件体 AES 加密、签名必校验 */
    encryptKey: env('FEISHU_ENCRYPT_KEY'),
    /** 事件订阅校验 token，配置后校验 header.token */
    verifyToken: env('FEISHU_VERIFY_TOKEN'),
    /** 飞书开放平台域名，私有化部署可替换 */
    apiBase: env('FEISHU_API_BASE', 'https://open.feishu.cn'),
  },

  /** 单用户会话保留的最大轮数（用户问 + 答各算一轮的一半） */
  sessionMaxRounds: Number(env('SESSION_MAX_ROUNDS', '6')),
  /** 单次 think 调用超时，毫秒 */
  thinkTimeoutMs: Number(env('THINK_TIMEOUT_MS', '120000')),
  /** 出站通知转发的目标飞书 open_id（阶段三；未配置时 /notify 只返回文本不发送） */
  notifyOpenId: env('NOTIFY_OPEN_ID'),
} as const;

export type Config = typeof config;

/** 启动时校验必需项，缺失即抛错让进程退出。 */
export function assertConfigured(): void {
  const missing: string[] = [];
  if (!config.exampleprojectMcpUrl) missing.push('WIKILLM_MCP_URL');
  if (!config.exampleprojectMcpToken) missing.push('WIKILLM_MCP_TOKEN');
  if (missing.length > 0) {
    throw new Error(`缺少必需环境变量: ${missing.join(', ')}`);
  }
}
