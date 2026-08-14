/**
 * 共享的提炼/整理错误翻译工具。
 *
 * 将后端返回的原始 LLM 错误字符串翻译成用户可读的中文提示，
 * 供 Sidebar、JobsPanel、RefinementHistoryPanel 等多处复用。
 */

/** 截断长文本，超长时追加省略号；压缩空白 */
export function shortText(value: unknown, limit = 130): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 将后端原始错误字符串翻译成可读提示。
 *
 * 覆盖场景：
 * - 401 / 认证 → 密钥无效或余额不足
 * - 400 / AccessDenied / 余额 → 账户余额不足或模型未开通
 * - 解析 / 截断 → 模型输出不完整
 * - 超时 / 网络 → 服务不可达
 * - 取消 → 用户中止
 */
export function humanError(error: string): string {
  if (/401|authentication|api key|密钥/i.test(error)) {
    return '模型服务拒绝了请求，通常表示 API 密钥无效、已过期或没有访问权限。';
  }
  if (/400|access.*denied|unpurchased|未购买|余额|insufficient|quota|额度/i.test(error)) {
    return '模型服务访问受限，可能是账户余额不足或模型未开通，请检查 API 账户状态。';
  }
  if (/parse|解析|json|截断|max_tokens/i.test(error)) {
    return '模型返回的内容不完整或格式无法解析，本阶段未能形成有效结果。';
  }
  if (/cancel|取消|aborted/i.test(error)) return '本次提炼在该阶段被取消。';
  if (/timeout|network|connect|连接|网络/i.test(error)) {
    return '模型服务暂时无法连接或响应超时，本阶段没有完成。';
  }
  return `该阶段执行失败：${shortText(error, 180)}`;
}
