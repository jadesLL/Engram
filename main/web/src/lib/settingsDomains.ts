/**
 * 设置页信息架构（纯数据 + 纯函数，便于单测）。
 *
 * 2026-09 把原来 6 个粒度不齐的分类合并成 4 个大类（账户与外观 / 连接与同步 /
 * Agent 接入 / 数据与存储）；2026-09-28 用户反馈「很割裂、很多不对」，按方案 A
 * 「一事一类」重做为 7 个**单职责**大类——每个大类只回答一个问题，混装桶全部拆开：
 *  - 「账户与外观」拆成「账户与访问」（账户 / 连接通道）＋「界面与检索」（外观 / 搜索同义词）：
 *    应用版本号不再夹在外观里（它去「本机应用」）；
 *  - 「连接与同步」拆成「多端同步」（同步群组 / DDNS 直连域名）、「版本与更新」
 *    （服务器更新 / 桌面端更新 / 更新源配置）、「本机应用」（桌面端应用 / 版本信息 / 卸载 Engram）；
 *  - 「数据与存储」里的「搜索同义词」移到「界面与检索」，「卸载 Engram」移到「本机应用」，
 *    剩下的数据类分组归入「知识库数据」；
 *  - 「Agent 接入」改名「Agent 与自动化」，「梦境思考」改名「自动整理（梦境思考）」并紧跟
 *    「内置 Agent」，「查看工具」改名「工具与手册」明确其只读参考身份。
 *
 * **导航顺序 = 页面渲染顺序**（SettingsView.vue 里各大类的分组必须按本文件登记顺序渲染）。
 * 2026-09-27 用户报的「导航里第 2 项、页面上第 4 块」（梦境思考插在两个 Agent 分组中间）
 * 就是这条被破坏的结果：点击锚点跳到最后一块、滚动高亮顺序也乱。settingsDomains.test.ts
 * 会锁住「锚点唯一」「锚点必然有 DOM」「导航顺序与页面顺序一致」三条。
 *
 * 大类下的每个分组都是二级导航锚点：点击滚动到该分组、滚动时反向高亮。
 * 锚点 id 必须与渲染出的 DOM id 一一对应（SettingsGroup 的 anchor 或包裹元素的 id）。
 */

export type SettingsDomainId =
  | 'account'
  | 'interface'
  | 'data'
  | 'sync'
  | 'update'
  | 'app'
  | 'agent';

/** 分组依赖的能力开关（缺省表示始终可见）。
 *  `desktop` = 桌面端运行时（服务端回报 runtime==='desktop'，含用浏览器打开桌面本地服务的情形）：
 *  比只看 window.wikiDesktop 准——本地服务被浏览器打开时后者为假，但本机确实有安装目录 / 开机自启 / 快捷方式可管。
 *  运行期才能判断的显隐（DDNS 只在担任中枢时、卸载只在源码安装形态）不进这里，
 *  由渲染该分组的组件经 lib/settingsNavVisibility.ts 登记。 */
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
  /** 大类页头的一句话说明（「这类管什么」） */
  desc: string;
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
    label: '账户与访问',
    desc: '登录凭据，以及这台设备怎么连上服务端。',
    icon: 'user',
    groups: [
      { id: 'account-credentials', label: '账户', icon: 'user' },
      { id: 'account-connection', label: '连接通道', icon: 'globe' },
    ],
  },
  {
    id: 'interface',
    label: '界面与检索',
    desc: '界面长什么样、搜索怎么召回，都是「我这端」的偏好。',
    icon: 'sun',
    groups: [
      { id: 'account-appearance', label: '外观', icon: 'sun' },
      { id: 'data-synonyms', label: '搜索同义词', icon: 'search' },
    ],
  },
  {
    id: 'data',
    label: '知识库数据',
    desc: '知识数据放在哪、怎么备份、怎么清理，以及不可撤销的数据操作。',
    icon: 'archive',
    groups: [
      { id: 'data-location', label: '存储位置', icon: 'folder' },
      { id: 'data-backup', label: '备份与恢复', icon: 'archive' },
      { id: 'storage-trash', label: '回收站', icon: 'trash' },
      { id: 'storage-assets', label: '图片资产', icon: 'image' },
      { id: 'data-danger', label: '危险操作', icon: 'alert', danger: true },
    ],
  },
  {
    id: 'sync',
    label: '多端同步',
    desc: '把多台设备组成一个同步群组：只要求中枢设备可被其他设备访问。',
    icon: 'refresh',
    groups: [
      { id: 'panel-sync', label: '同步群组', icon: 'refresh' },
      { id: 'sync-ddns', label: 'DDNS 直连域名', icon: 'link' },
    ],
  },
  {
    id: 'update',
    label: '版本与更新',
    desc: '服务端与桌面端各自的版本更新通道。',
    icon: 'download',
    groups: [
      // 桌面端更新在浏览器访问时只作展示（组件里有说明），因此与服务器更新同一能力位，
      // 不能挂 desktop：挂了会让「页面上有、导航里没有」，顺序对不上。
      { id: 'panel-update-server', label: '服务器更新', icon: 'download', need: 'serverUpdate' },
      { id: 'panel-update-desktop', label: '桌面端更新', icon: 'monitor', need: 'serverUpdate' },
      { id: 'panel-update-source', label: '更新源配置', icon: 'globe', need: 'serverUpdate' },
    ],
  },
  {
    id: 'app',
    label: '本机应用',
    desc: '这台机器上的 Engram 应用本身：怎么启动、什么版本、怎么卸载。',
    icon: 'monitor',
    groups: [
      { id: 'panel-app', label: '桌面端应用', icon: 'monitor', need: 'desktop' },
      { id: 'app-version', label: '版本信息', icon: 'activity' },
      { id: 'app-uninstall', label: '卸载 Engram', icon: 'alert', danger: true },
    ],
  },
  {
    id: 'agent',
    label: 'Agent 与自动化',
    desc: '内置 Agent、定时自动整理，以及把知识库接入外部 Agent。',
    icon: 'ai',
    groups: [
      { id: 'agent-builtin', label: '内置 Agent', icon: 'ai', need: 'agent' },
      { id: 'agent-dream', label: '自动整理（梦境思考）', icon: 'moon', need: 'agent' },
      { id: 'agent-target', label: '外部接入', icon: 'plug', need: 'agent' },
      { id: 'agent-tools', label: '工具与手册', icon: 'wrench', need: 'agent' },
    ],
  },
];

/**
 * 旧分类 id → 新大类 + 锚点：`?section=update` 之类的外部链接（README、书签、
 * 首页状态条跳转）不因为改版失效。键是历史上出现过的一级分类 id。
 */
export const LEGACY_SETTINGS_SECTIONS: Record<string, { domain: SettingsDomainId; anchor?: string }> = {
  // 2026-09 那版的 4 个大类
  account: { domain: 'account' },
  connect: { domain: 'sync', anchor: 'panel-sync' },
  agent: { domain: 'agent' },
  data: { domain: 'data' },
  // 2026-09 之前的 6 个分类
  sync: { domain: 'sync', anchor: 'panel-sync' },
  update: { domain: 'update', anchor: 'panel-update-server' },
  storage: { domain: 'data', anchor: 'storage-trash' },
  // 应用内旧入口：桌面端更新 / 桌面端应用都曾挂在「连接与同步」下
  'update-desktop': { domain: 'update', anchor: 'panel-update-desktop' },
  'desktop-app': { domain: 'app', anchor: 'panel-app' },
};

/** 锚点 id → 分组图标（SettingsGroup 卡片头部用；未配置时返回空串，调用方不渲染图标） */
export function settingsGroupIcon(anchor: string): string {
  for (const domain of SETTINGS_DOMAINS) {
    const hit = domain.groups.find((group) => group.id === anchor);
    if (hit) return hit.icon || '';
  }
  return '';
}

/**
 * 按运行时能力过滤：不可用的功能域连同它的分组一起从导航里消失。
 * `hidden` 是运行期才确定的隐藏锚点（见 lib/settingsNavVisibility.ts）——同样要过滤掉，
 * 否则点了没有任何反应。
 */
export function visibleSettingsDomains(
  features: SettingsFeatures,
  hidden: ReadonlySet<string> = new Set(),
): SettingsDomain[] {
  return SETTINGS_DOMAINS
    .map((domain) => ({
      ...domain,
      groups: domain.groups.filter((group) => {
        if (hidden.has(group.id)) return false;
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

/** 锚点落在哪个大类（「已经在设置页时跳转到某个分组」用：不能再靠调用方猜大类） */
export function domainOfAnchor(anchor: string, domains: SettingsDomain[]): SettingsDomainId | null {
  for (const domain of domains) {
    if (domain.groups.some((group) => group.id === anchor)) return domain.id;
  }
  return null;
}
