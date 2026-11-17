/**
 * 办公本接入的类型配置（多端同步的 preference `doxent_config`）。
 *
 * 目前只实装讯飞（Doxent）；品牌列表是服务端与前端共同的白名单。把它单独放在这个无副作用的
 * 模块里，路由 / 同步 / 单测都能用，且不会为了读一个配置把 Python、技能安装链拉进来。
 */

export const DOXENT_CONFIG_KEY = 'doxent_config';

/** 品牌白名单：新增品牌时这里、前端 NOTEBOOK_TYPES、以及对应的服务端接入一起加 */
export const DOXENT_PROVIDERS = ['iflytek'] as const;

export type DoxentProvider = (typeof DOXENT_PROVIDERS)[number];

export interface DoxentConfig {
  provider: DoxentProvider;
}

export const DEFAULT_DOXENT_CONFIG: DoxentConfig = { provider: 'iflytek' };

function isProvider(value: unknown): value is DoxentProvider {
  return typeof value === 'string' && (DOXENT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * 读取口径：缺省 / 写坏 / 未知品牌一律退回默认（讯飞）。
 * 读配置不能因为历史脏数据让整个设置页报错。
 */
export function parseDoxentConfig(value: unknown): DoxentConfig {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return DEFAULT_DOXENT_CONFIG;
    try {
      parsed = JSON.parse(value);
    } catch {
      return DEFAULT_DOXENT_CONFIG;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_DOXENT_CONFIG;
  const provider = (parsed as { provider?: unknown }).provider;
  return isProvider(provider) ? { provider } : DEFAULT_DOXENT_CONFIG;
}

/**
 * 写入口径：只接受显式且在白名单里的品牌；缺字段 / 未知品牌返回 null（由路由回 400）。
 * 不能用 parseDoxentConfig 兼任校验，否则 `{provider:"unknown"}` 会被静默改成讯飞。
 */
export function normalizeDoxentConfigInput(value: unknown): DoxentConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const provider = (value as { provider?: unknown }).provider;
  return isProvider(provider) ? { provider } : null;
}

/** 稳定序列化（写入 settings / 比较是否变化） */
export function serializeDoxentConfig(config: DoxentConfig): string {
  return JSON.stringify({ provider: config.provider });
}
