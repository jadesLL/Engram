/**
 * 设置页信息架构（纯数据 + 纯函数，便于单测）。
 *
 * 2026-09 改版把原来 6 个粒度不齐的分类合并成 4 个大类：
 *  - 「多端同步」与「软件更新」并成「连接与同步」；
 *  - 「存储空间」（回收站 / 图片资产）并入「数据与存储」；
 *  - 「账户与外观」内部拆成账户 / 外观 / 连接与版本三个分组。
 *
 * 2026-09-24 二次细分（用户反馈「卸载软件、设置开机自启放进更新分组不太合适」）：
 *  - 「桌面端更新」回归版本语义：自动更新 / 检查更新 / 下载安装 / 源码增量更新；
 *  - 开机自启、桌面快捷方式独立成「桌面端应用」（panel-app）——说的是"这台机器上怎么跑 Engram"，
 *    与"是不是最新版本"不是一回事；
 *  - 卸载 Engram 移入「数据与存储 → 危险操作」（data-danger），与清库 / 清日志并列：
 *    都是不可撤销、做错了没法回退的操作，统一放整页最后一组。
 *
 * 2026-09-27：「梦境思考」（agent-dream）进「Agent 接入」——它跑的是内置 Agent，放在
 * 「内置 Agent」后面、与「接入目标」（外部 harness）分开，语义是"让内置 Agent 按计划自动干活"。
 *
 * 大类下的每个分组都是二级导航锚点：点击滚动到该分组、滚动时反向高亮。
 * 锚点 id 必须与渲染出的 DOM id 一一对应（SettingsGroup 的 anchor 或包裹元素的 id），
 * 且全局唯一——settingsDomains.test.ts 会锁住这两条。
 */

export type SettingsDomainId = 'account' | 'connect' | 'agent' | 'data';

/** 分组依赖的能力开关（缺省表示始终可见）。
 *  `desktop` = 桌面端运行时（服务端回报 runtime==='desktop'，含用浏览器打开桌面本地服务的情形）：
 *  比只看 window.wikiDesktop 准——本地服务被浏览器打开时后者为假，但本机确实有安装目录 / 开机自启 / 快捷方式可管 */
export type SettingsDomainNeed = 'agent' | 'serverUpdate' | 'desktop';

export interface SettingsGroupNav {
  /** 锚点 id：与 SettingsGroup 的 anchor / 包裹元素的 id 一致 */
  id: string;
  label: string;
  /** 分组卡片头部的识别图标（Icon.vue 中的图标名） */
  icon?: string;
  /** 危险分组：导航锚点与分组卡片常驻警示色 */
  danger?: boolean;
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
  /** 桌面端运行时；缺省按「不是桌面端」处理——只有显式 true 才放行桌面端专属分组，避免登记了却渲染不出来的死锚点 */
  desktop?: boolean;
}

export const SETTINGS_DOMAINS: SettingsDomain[] = [
  {
    id: 'account',
    label: '账户与外观',
    icon: 'settings',
    groups: [
      { id: 'account-credentials', label: '账户', icon: 'user' },
      { id: 'account-appearance', label: '外观', icon: 'sun' },
      { id: 'account-connection', label: '连接与版本', icon: 'globe' },
    ],
  },
  {
    id: 'connect',
    label: '连接与同步',
    icon: 'external',
    groups: [
      { id: 'panel-sync', label: '多端同步', icon: 'refresh' },
      { id: 'panel-update-server', label: '服务器更新', icon: 'download', need: 'serverUpdate' },
      { id: 'panel-update-desktop', label: '桌面端更新', icon: 'monitor', need: 'serverUpdate' },
      { id: 'panel-app', label: '桌面端应用', icon: 'monitor', need: 'desktop' },
      { id: 'panel-update-source', label: '更新源配置', icon: 'globe', need: 'serverUpdate' },
    ],
  },
  {
    id: 'agent',
    label: 'Agent 接入',
    icon: 'ai',
    groups: [
      { id: 'agent-builtin', label: '内置 Agent', icon: 'ai', need: 'agent' },
      { id: 'agent-dream', label: '梦境思考', icon: 'moon', need: 'agent' },
      { id: 'agent-target', label: '接入目标', icon: 'plug', need: 'agent' },
      { id: 'agent-tools', label: '查看工具', icon: 'wrench', need: 'agent' },
    ],
  },
  {
    id: 'data',
    label: '数据与存储',
    icon: 'archive',
    groups: [
      { id: 'data-location', label: '存储位置', icon: 'folder' },
      { id: 'data-backup', label: '备份与恢复', icon: 'archive' },
      { id: 'data-synonyms', label: '搜索同义词', icon: 'search' },
      { id: 'storage-trash', label: '回收站', icon: 'trash' },
      { id: 'storage-assets', label: '图片资产', icon: 'image' },
      { id: 'data-danger', label: '危险操作', icon: 'alert', danger: true },
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
  update: { domain: 'connect', anchor: 'panel-update-server' },
  storage: { domain: 'data', anchor: 'storage-trash' },
  data: { domain: 'data' },
};

/** 锚点 id → 分组图标（SettingsGroup 卡片头部用；未配置时返回空串，调用方不渲染图标） */
export function settingsGroupIcon(anchor: string): string {
  for (const domain of SETTINGS_DOMAINS) {
    const hit = domain.groups.find((group) => group.id === anchor);
    if (hit) return hit.icon || '';
  }
  return '';
}

/** 按运行时能力过滤：不可用的功能域连同它的分组一起从导航里消失 */
export function visibleSettingsDomains(features: SettingsFeatures): SettingsDomain[] {
  return SETTINGS_DOMAINS
    .map((domain) => ({
      ...domain,
      groups: domain.groups.filter((group) => {
        if (group.need === 'agent') return features.agent;
        if (group.need === 'serverUpdate') return features.serverUpdate;
        if (group.need === 'desktop') return Boolean(features.desktop);
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
