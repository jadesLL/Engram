/**
 * 设置页信息架构（纯数据 + 纯函数，便于单测）。
 *
 * 2026-09 改版把原来 6 个粒度不齐的分类合并成 4 个大类：
 *  - 「多端同步」与「软件更新」并成「连接与同步」；
 *  - 「存储空间」（回收站 / 图片资产）并入「数据与存储」；
 *  - 「账户与外观」内部拆成账户 / 外观 / 连接与版本三个分组。
 *
 * 大类下的每个分组都是二级导航锚点：点击滚动到该分组、滚动时反向高亮。
 * 锚点 id 必须与渲染出的 DOM id 一一对应（SettingsGroup 的 anchor 或包裹元素的 id），
 * 且全局唯一——settingsDomains.test.ts 会锁住这两条。
 */

export type SettingsDomainId = 'account' | 'connect' | 'agent' | 'data';

/** 分组依赖的能力开关（缺省表示始终可见） */
export type SettingsDomainNeed = 'agent' | 'serverUpdate';

export interface SettingsGroupNav {
  /** 锚点 id：与 SettingsGroup 的 anchor / 包裹元素的 id 一致 */
  id: string;
  label: string;
  need?: SettingsDomainNeed;
}

export interface SettingsDomain {
  id: SettingsDomainId;
  label: string;
  /** Icon.vue 中的图标名 */
  icon: string;
  groups: SettingsGroupNav[];
}

export interface SettingsFeatures {
  agent: boolean;
  serverUpdate: boolean;
}

export const SETTINGS_DOMAINS: SettingsDomain[] = [
  {
    id: 'account',
    label: '账户与外观',
    icon: 'settings',
    groups: [
      { id: 'account-credentials', label: '账户' },
      { id: 'account-appearance', label: '外观' },
      { id: 'account-connection', label: '连接与版本' },
    ],
  },
  {
    id: 'connect',
    label: '连接与同步',
    icon: 'external',
    groups: [
      { id: 'panel-sync', label: '多端同步' },
      { id: 'panel-update', label: '软件更新', need: 'serverUpdate' },
    ],
  },
  {
    id: 'agent',
    label: 'Agent 接入',
    icon: 'ai',
    groups: [
      { id: 'agent-builtin', label: '内置 Agent', need: 'agent' },
      { id: 'agent-target', label: '接入目标', need: 'agent' },
      { id: 'agent-tools', label: '查看工具', need: 'agent' },
    ],
  },
  {
    id: 'data',
    label: '数据与存储',
    icon: 'archive',
    groups: [
      { id: 'data-location', label: '存储位置' },
      { id: 'data-backup', label: '备份与恢复' },
      { id: 'data-synonyms', label: '搜索同义词' },
      { id: 'storage-trash', label: '回收站' },
      { id: 'storage-assets', label: '图片资产' },
      { id: 'data-danger', label: '危险操作' },
    ],
  },
];

/**
 * 旧分类 id → 新大类 + 锚点：`?section=update` 之类的外部链接（README、书签、
 * 首页状态条跳转）不因为改版失效。
 */
export const LEGACY_SETTINGS_SECTIONS: Record<string, { domain: SettingsDomainId; anchor?: string }> = {
  account: { domain: 'account' },
  agent: { domain: 'agent' },
  sync: { domain: 'connect', anchor: 'panel-sync' },
  update: { domain: 'connect', anchor: 'panel-update' },
  storage: { domain: 'data', anchor: 'storage-trash' },
  data: { domain: 'data' },
};

/** 按运行时能力过滤：不可用的功能域连同它的分组一起从导航里消失 */
export function visibleSettingsDomains(features: SettingsFeatures): SettingsDomain[] {
  return SETTINGS_DOMAINS
    .map((domain) => ({
      ...domain,
      groups: domain.groups.filter((group) => {
        if (group.need === 'agent') return features.agent;
        if (group.need === 'serverUpdate') return features.serverUpdate;
        return true;
      }),
    }))
    .filter((domain) => domain.groups.length > 0);
}

/**
 * 把 `?section=` / `?anchor=` 解析成「落在大类的哪个分组」。
 * section 既接受新的大类 id，也接受旧分类 id；锚点不存在（或不属于该大类）时退回该大类第一项。
 */
export function resolveSettingsTarget(
  section: string,
  anchor: string,
  domains: SettingsDomain[],
): { domain: SettingsDomainId; anchor: string } {
  const fallbackDomain = domains[0];
  const legacy = LEGACY_SETTINGS_SECTIONS[section];
  const byDomainId = domains.find((domain) => domain.id === section);
  const target = byDomainId
    ?? (legacy ? domains.find((domain) => domain.id === legacy.domain) : undefined)
    ?? fallbackDomain;
  if (!target) return { domain: 'account', anchor: '' };
  const wanted = anchor || legacy?.anchor || '';
  const matched = target.groups.some((group) => group.id === wanted) ? wanted : '';
  return { domain: target.id, anchor: matched || target.groups[0]?.id || '' };
}
