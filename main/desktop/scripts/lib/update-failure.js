// 自动更新失败暂停的纯逻辑（无 Electron 依赖）：单测见 desktop/scripts/tests/update-failure.test.js。
//
// 为什么要这一层：自动更新默认开启，发现新版本就后台下载并静默安装。下载被杀软拦下、发布
// 缺少 sha256、安装被系统策略拒绝时，主进程原本会按退避节奏无限重试同一个版本——用户每隔
// 几分钟就被「正在更新」静默链打扰一次，而失败原因只有主动翻设置页才看得到。
//
// 规则（用户 2026-11-08 明确要求）：某个目标版本的自动更新失败一次后，本版本不再自动重试，
// 把失败原因持久化并主动提示用户；手动检查/下载不受限制，发布新版本（版本号不同）或用户
// 手动重试后恢复。记录存在 config.json 的 autoUpdateFailure 字段，形态 { version, at, reason }。
const MAX_REASON = 400;

/** 版本号归一化：v1.5.9 / 1.5.9 / 1.5.9-beta 都归一到数字段，避免同一版本因写法不同绕过暂停 */
function normalizeVersion(raw) {
  const m = String(raw ?? '').match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : null;
}

/** 读回来的失败记录做一次清洗：损坏/旧格式一律按「没有记录」处理，绝不让脏数据拦住自动更新 */
function normalizeFailure(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const version = normalizeVersion(raw.version);
  if (!version) return null;
  const at = Number(raw.at);
  return {
    version,
    at: Number.isFinite(at) && at > 0 ? at : 0,
    reason: String(raw.reason ?? '').trim().slice(0, MAX_REASON),
  };
}

/** 记录的失败版本是否就是本次要自动更新的目标版本（只有同版本才暂停自动更新） */
function appliesTo(failure, latestVersion) {
  const record = normalizeFailure(failure);
  const target = normalizeVersion(latestVersion);
  return Boolean(record && target && record.version === target);
}

/**
 * 写一条失败记录。没有可用版本号（例如检查请求本身失败、根本还不知道目标版本）时返回 null：
 * 网络抖动不是「某个版本更新失败」，不该把自动更新停掉。
 */
function recordFailure(prev, version, reason, now = Date.now()) {
  const target = normalizeVersion(version);
  if (!target) return null;
  const previous = normalizeFailure(prev);
  const text = String(reason ?? '').trim().slice(0, MAX_REASON);
  return {
    version: target,
    at: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    reason: text || (previous && previous.version === target ? previous.reason : ''),
  };
}

/** 给界面/系统通知用的一句话（不含版本号前缀，调用方自己拼 v<版本>） */
function describeFailure(failure) {
  const record = normalizeFailure(failure);
  if (!record) return '';
  return `自动更新到 v${record.version} 失败${record.reason ? `：${record.reason}` : ''}。已暂停该版本的自动更新，不会再自动重试；可在「设置 → 版本与更新」手动更新或重试。`;
}

module.exports = {
  MAX_REASON,
  normalizeVersion,
  normalizeFailure,
  appliesTo,
  recordFailure,
  describeFailure,
};
