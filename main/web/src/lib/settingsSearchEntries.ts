import type { SettingsDomain, SettingsDomainId } from './settingsDomains';

/**
 * 设置页搜索索引（纯数据 + 纯函数，便于单测）。
 *
 * 设置项分散在 20 多个面板组件里，行级内容没有统一注册表；为了搜索「备份」「端口」「模型 Key」
 * 这类具体设置项，这里维护一份人工登记的索引：只登记「用户会搜的名字」，锚点必须指向
 * settingsDomains 里已登记的分组（测试会锁这条，避免搜索跳到点不动的死锚点）。
 *
 * 规则：
 *  - 每条必须落在真实的 domain + group 上，group 就是跳转落点（分组卡会高亮一下）；
 *  - keywords 写别名 / 旧叫法（「梦境思考」「智能体」），不写描述性长句；
 *  - 分组本身也会作为可搜项（见 buildSettingsSearchIndex），这里只补行级设置项。
 */
export interface SettingsSearchEntry {
  /** 结果标题（用户看到的设置项名） */
  title: string;
  /** 跳转落点的分组锚点（必须存在于 settingsDomains） */
  group: string;
  domain: SettingsDomainId;
  /** 额外检索词：别名、旧叫法、英文名 */
  keywords?: string;
}

/** 行级设置项索引（按大类顺序排列，便于人工核对） */
export const SETTINGS_ROW_ENTRIES: readonly SettingsSearchEntry[] = [
  // 账户与访问
  { title: '修改密码', group: 'account-credentials', domain: 'account', keywords: 'password 登录密码 密码' },
  { title: '退出登录', group: 'account-credentials', domain: 'account', keywords: 'logout 登出 会话' },
  { title: '连接通道', group: 'account-connection', domain: 'account', keywords: '直连 隧道 IPv6 IPv4 局域网' },

  // 界面与检索
  { title: '主题', group: 'account-appearance', domain: 'interface', keywords: 'theme 深色 浅色 跟随系统 外观' },
  { title: '悬停提示严格避让', group: 'account-appearance', domain: 'interface', keywords: 'tooltip 提示 悬浮' },
  { title: '显示 AI 工作区', group: 'account-appearance', domain: 'interface', keywords: 'aiworks 侧栏 日志 索引' },
  { title: '触觉反馈', group: 'account-appearance', domain: 'interface', keywords: '振动 轻振 haptics 手机' },
  { title: '搜索同义词', group: 'data-synonyms', domain: 'interface', keywords: '同义 近义 召回 搜索' },

  // 知识库数据
  { title: '存储位置', group: 'data-location', domain: 'data', keywords: '数据目录 仓库 路径' },
  { title: '本地服务端口', group: 'data-location', domain: 'data', keywords: 'port 端口 18180' },
  { title: '整库备份', group: 'data-backup', domain: 'data', keywords: '导出 下载 zip 备份' },
  { title: '从备份恢复', group: 'data-backup', domain: 'data', keywords: '恢复 还原 导入 zip' },
  { title: '回收站', group: 'storage-trash', domain: 'data', keywords: '删除 恢复 清空 trash' },
  { title: '图片资产', group: 'storage-assets', domain: 'data', keywords: '图片 占用 清理 附件' },
  { title: '清空操作日志与关系库', group: 'data-danger', domain: 'data', keywords: '日志 关系库 AIWorks 清空' },
  { title: '一键清除知识数据', group: 'data-danger', domain: 'data', keywords: '清库 删除全部 危险' },

  // 多端同步
  { title: '同步群组', group: 'panel-sync', domain: 'sync', keywords: '中枢 成员 绑定 二维码 邀请' },
  { title: '同步内容', group: 'sync-content', domain: 'sync', keywords: '同步范围 设置 会话 资料' },
  { title: '局域网优先', group: 'sync-lan', domain: 'sync', keywords: 'lan 局域网 直连' },
  { title: '双栈连接', group: 'sync-dualstack', domain: 'sync', keywords: 'ipv6 ipv4 双栈 回退' },
  { title: 'DDNS 直连域名', group: 'sync-ddns', domain: 'sync', keywords: 'ddns 域名 动态解析' },

  // 版本与更新
  { title: '服务器更新', group: 'panel-update-server', domain: 'update', keywords: 'docker 镜像 更新 通道' },
  { title: '桌面端更新', group: 'panel-update-desktop', domain: 'update', keywords: 'windows 源码 增量 版本' },
  { title: '更新源配置', group: 'panel-update-source', domain: 'update', keywords: 'gitea 源 地址 镜像仓库' },
  { title: '安卓端更新', group: 'panel-update-android', domain: 'update', keywords: 'apk ota 手机 安装包' },

  // 本机应用
  { title: '开机自启', group: 'panel-app', domain: 'app', keywords: '启动 托盘 登录 windows' },
  { title: '桌面快捷方式', group: 'panel-app', domain: 'app', keywords: '快捷方式 图标 重建' },
  { title: '版本信息', group: 'app-version', domain: 'app', keywords: '版本号 提交 commit' },
  { title: '卸载 Engram', group: 'app-uninstall', domain: 'app', keywords: '卸载 删除 安装目录' },

  // Agent 与自动化
  { title: '内置 Agent', group: 'agent-builtin', domain: 'agent', keywords: 'dsh 聊天 抽屉 工作目录 权限' },
  { title: '内置 Agent 控制台', group: 'agent-console', domain: 'agent', keywords: '模型 api key 插件 预设 console' },
  { title: '视频理解模型', group: 'panel-video', domain: 'agent', keywords: '视频 b站 抖音 提炼 多模态' },
  { title: '自动整理（梦境思考）', group: 'agent-dream', domain: 'agent', keywords: '梦境 dream 定时 整理 纠错' },
  { title: '任务看板提炼', group: 'agent-board', domain: 'agent', keywords: '看板 提炼 间隔' },
  { title: '外部接入', group: 'agent-target', domain: 'agent', keywords: 'claude code codex 接入 cli skill' },
  { title: '工具与手册', group: 'agent-tools', domain: 'agent', keywords: '命令 engram cli 手册 指南' },
];

/** 搜索结果：附带面包屑与分组标签，供界面直接渲染 */
export interface SettingsSearchHit extends SettingsSearchEntry {
  /** 面包屑：大类 · 分组 */
  path: string;
  /** 是否分组本身（分组命中排在行命中之后） */
  isGroup: boolean;
}

/**
 * 把「分组」与「行级设置项」合并成搜索索引。
 * 分组条目来自 settingsDomains（永远与导航一致），行级条目来自上面的登记表。
 */
export function buildSettingsSearchIndex(domains: readonly SettingsDomain[]): SettingsSearchHit[] {
  const hits: SettingsSearchHit[] = [];
  for (const domain of domains) {
    for (const group of domain.groups) {
      hits.push({
        title: group.label,
        group: group.id,
        domain: domain.id,
        keywords: '',
        path: domain.label + ' · ' + group.label,
        isGroup: true,
      });
    }
  }
  const groups = new Map(
    domains.flatMap((domain) => domain.groups.map((group) => [group.id, { domain, group }] as const)),
  );
  /* 行条目与分组同名时（例如「同步群组」既是分组又是行）只保留分组条目：
     搜索结果里不该出现两条一模一样的标题，跳转落点也完全相同。 */
  const seen = new Set(hits.map((hit) => hit.domain + '|' + hit.title));
  for (const entry of SETTINGS_ROW_ENTRIES) {
    const hit = groups.get(entry.group);
    if (!hit) continue; // 运行端看不见的分组（能力位过滤后）不参与搜索
    const key = entry.domain + '|' + entry.title;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ ...entry, path: hit.domain.label + ' · ' + hit.group.label, isGroup: false });
  }
  return hits;
}

/**
 * 检索：子串匹配标题 / 别名 / 面包屑；标题命中排前面，分组条目排在行条目后面。
 * 空查询返回空数组（调用方自己决定展示「常用入口」）。
 */
export function searchSettings(query: string, index: SettingsSearchHit[]): SettingsSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return index
    .map((hit) => {
      const title = hit.title.toLowerCase();
      const haystack = (hit.title + ' ' + (hit.keywords || '') + ' ' + hit.path).toLowerCase();
      if (!haystack.includes(q)) return null;
      const titleScore = title.includes(q) ? 0 : 1;
      const groupScore = hit.isGroup ? 1 : 0;
      return { hit, score: titleScore * 2 + groupScore };
    })
    .filter((item): item is { hit: SettingsSearchHit; score: number } => item !== null)
    .sort((a, b) => a.score - b.score || a.hit.title.length - b.hit.title.length)
    .map((item) => item.hit)
    .slice(0, 24);
}
