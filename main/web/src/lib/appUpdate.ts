/**
 * 安卓端应用内更新（OTA）的纯逻辑与文案：状态快照归一化、字节格式化、状态行/按钮文案。
 *
 * 为什么单独一份：手机端只能靠安装包升级（不能像桌面端那样增量拉源码重建），所以它的
 * 状态机与文案跟桌面/服务端三形态都不一样；抽成纯函数后可以在 web 单测里锁住
 * 「下载中显示百分比、就绪提示去安装、没配更新源要说清去哪配」这些关键文案，
 * 组件（设置面板、绿色更新图标）只负责渲染。
 *
 * 状态来源：App 内 Kotlin 本地服务的 `/api/app-update/state`（见 mobile/.../AppUpdater.kt）。
 */

export type AppUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

/** 私有库凭据方式：访问令牌 / 用户名密码（与服务器/桌面端「更新源配置」同一套口径） */
export type AppUpdateAuthType = 'token' | 'password';

export interface AppUpdateInfo {
  runtime: string;
  /** 本机 APK 的 versionName */
  currentVersion: string;
  /** 调试包（versionName 带后缀）：正式包会与它并存成两个 App，不给自动安装 */
  debugBuild: boolean;
  latestVersion: string | null;
  releaseTag: string;
  releaseNotes: string;
  hasUpdate: boolean;
  phase: AppUpdatePhase;
  percent: number | null;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
  /** 是否已配置更新源（仓库地址） */
  configured: boolean;
  repoUrl: string;
  /** 生效的地址来自多端同步的中枢（服务器/桌面端「更新源配置」那一份），本机没手填 */
  fromHub: boolean;
  /** 本机是否手填过地址（手填优先于中枢下发的） */
  hasLocalSource: boolean;
  /** 私有库凭据方式（公开仓库留空凭据即可） */
  authType: AppUpdateAuthType;
  /** 用户名密码方式的用户名：不是秘密，随状态回传；令牌与密码不回显，只给「已保存」标记 */
  username: string;
  /** 已保存访问令牌（留空提交 = 不修改） */
  tokenSaved: boolean;
  /** 已保存用户名密码的密码（留空提交 = 不修改） */
  passwordSaved: boolean;
  autoUpdate: boolean;
  checkedAt: string;
  /** 安装包已下载完整、可以点「立即安装」 */
  ready: boolean;
  apkName: string;
  /** 系统是否已允许「安装未知应用」 */
  canInstall: boolean;
  notificationsEnabled: boolean;
  installLaunched: boolean;
  /**
   * 用户点过安装、正卡在系统「安装未知应用」授权页：允许后返回会自动继续调起安装器
   * （见 mobile/.../AppUpdater.kt 的 resumePendingInstall）。
   */
  awaitingInstallPermission: boolean;
}

export function emptyAppUpdateInfo(): AppUpdateInfo {
  return {
    runtime: 'android',
    currentVersion: '',
    debugBuild: false,
    latestVersion: null,
    releaseTag: '',
    releaseNotes: '',
    hasUpdate: false,
    phase: 'idle',
    percent: null,
    downloadedBytes: 0,
    totalBytes: 0,
    error: '',
    configured: false,
    repoUrl: '',
    fromHub: false,
    hasLocalSource: false,
    authType: 'token',
    username: '',
    tokenSaved: false,
    passwordSaved: false,
    autoUpdate: true,
    checkedAt: '',
    ready: false,
    apkName: '',
    canInstall: true,
    notificationsEnabled: true,
    installLaunched: false,
    awaitingInstallPermission: false,
  };
}

const PHASES: AppUpdatePhase[] = ['idle', 'checking', 'downloading', 'ready', 'error'];

/** 服务端返回体 → 前端状态；缺字段一律按「没有」处理，界面不显示 undefined */
export function normalizeAppUpdateInfo(raw: any): AppUpdateInfo {
  const base = emptyAppUpdateInfo();
  if (!raw || typeof raw !== 'object') return base;
  const phase = PHASES.includes(raw.phase) ? (raw.phase as AppUpdatePhase) : 'idle';
  const percent = Number.isFinite(Number(raw.percent)) ? Number(raw.percent) : null;
  return {
    runtime: String(raw.runtime || base.runtime),
    currentVersion: String(raw.currentVersion || ''),
    debugBuild: Boolean(raw.debugBuild),
    latestVersion: raw.latestVersion ? String(raw.latestVersion) : null,
    releaseTag: String(raw.releaseTag || ''),
    releaseNotes: String(raw.releaseNotes || ''),
    hasUpdate: Boolean(raw.hasUpdate),
    phase,
    percent,
    downloadedBytes: Number(raw.downloadedBytes || 0),
    totalBytes: Number(raw.totalBytes || 0),
    error: String(raw.error || ''),
    configured: Boolean(raw.configured),
    repoUrl: String(raw.repoUrl || ''),
    fromHub: Boolean(raw.fromHub),
    hasLocalSource: Boolean(raw.hasLocalSource),
    // 只认 'password' 一种写法，其余（含旧版本服务端没这个字段）按访问令牌
    authType: raw.authType === 'password' ? 'password' : 'token',
    username: String(raw.username || ''),
    tokenSaved: Boolean(raw.tokenSaved),
    passwordSaved: Boolean(raw.passwordSaved),
    autoUpdate: raw.autoUpdate !== false,
    checkedAt: String(raw.checkedAt || ''),
    ready: Boolean(raw.ready),
    apkName: String(raw.apkName || ''),
    canInstall: raw.canInstall !== false,
    notificationsEnabled: raw.notificationsEnabled !== false,
    installLaunched: Boolean(raw.installLaunched),
    awaitingInstallPermission: Boolean(raw.awaitingInstallPermission),
  };
}

/** 当前方式在本机是否已存过凭据（面板据此显示「已保存」占位与「清除」按钮） */
export function appUpdateCredentialSaved(info: AppUpdateInfo): boolean {
  return info.authType === 'password' ? info.passwordSaved : info.tokenSaved;
}

/**
 * 保存前的凭据校验（与 Kotlin 端 AppUpdatePolicy.credentialProblem 同一套判定）：
 * 用户名密码方式必须凑齐用户名与密码——缺一项就发不出 Basic 头，私有库会静默退化成匿名访问
 * （表现为 401/404，而不是「凭据没填全」）；访问令牌方式允许留空，公开仓库不需要凭据。
 * 返回 null 表示没问题，否则是给用户看的一句话。
 */
export function appUpdateCredentialProblem(
  authType: AppUpdateAuthType,
  username: string,
  passwordInput: string,
  hasSavedPassword: boolean,
): string | null {
  if (authType !== 'password') return null;
  if (!username.trim()) return '选了「用户名密码」就得填用户名';
  if (!passwordInput && !hasSavedPassword) return '选了「用户名密码」还得填密码';
  return null;
}

/** 字节数 → 人话（下载进度里显示「已下载 12 MB / 48 MB」） */
export function formatBytes(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** 状态行文案：一眼看出「在做什么 / 该做什么 / 卡在哪」 */
export function appUpdateStatusText(info: AppUpdateInfo): string {
  if (!info.configured) return '还没配更新源：本机填一个仓库地址，或让同步中枢配好更新源（会随多端同步下发到手机）。';
  if (info.phase === 'checking') return '正在检查远端仓库的最新版本…';
  if (info.phase === 'downloading') {
    const version = info.latestVersion ? `v${info.latestVersion} ` : '';
    if (info.percent !== null) {
      const size = info.totalBytes > 0 ? `（${formatBytes(info.downloadedBytes)} / ${formatBytes(info.totalBytes)}）` : '';
      return `正在后台下载 ${version}安装包 ${info.percent}%${size}…`;
    }
    return `正在后台下载 ${version}安装包（已下载 ${formatBytes(info.downloadedBytes)}）…`;
  }
  if (info.phase === 'error') return `更新失败：${info.error || '未知原因'}`;
  if (info.ready) {
    if (info.awaitingInstallPermission) {
      return '正在等系统的「安装未知应用」授权：在系统页面允许 Engram 安装应用，返回后会自动接着装。';
    }
    // 权限没开也照样让用户点「立即安装」——点下去会自动拉起系统授权页，不用自己去翻设置
    if (!info.canInstall) return `v${info.latestVersion || ''} 安装包已就绪：点「立即安装」会自动打开系统授权页，允许后自动继续。`;
    return `v${info.latestVersion || ''} 安装包已下载完成，点「立即安装」调起系统安装器。`;
  }
  if (info.hasUpdate) return `有新版本 v${info.latestVersion}（当前 v${info.currentVersion}）。`;
  if (info.checkedAt) return '已是最新版本。';
  return '还没有检查过更新；开启自动更新后会在回前台时自动检查。';
}

/** 主按钮文案：检查 / 下载 / 安装，三态各一句话（下载中不可点，进度在状态行） */
export function appUpdateActionLabel(info: AppUpdateInfo): string {
  if (info.ready) return '立即安装';
  if (info.phase === 'downloading') {
    return info.percent !== null ? `下载中 ${info.percent}%` : '下载中…';
  }
  if (info.hasUpdate) return '下载安装包';
  return '检查更新';
}

/**
 * 阻塞提示：调试包、未授权「安装未知应用」。返回空串表示没有阻塞。
 * 调试包不参与自动安装是有意为之——debug 包的 applicationId 带 .debug 后缀，
 * 装正式包会变成两个 App 并存，不如让用户知道原因。
 * 「安装未知应用」不再算阻塞：点「立即安装」会自动拉起系统授权页（旧版要求用户
 * 自己去找「去开启安装权限」按钮，用户报障找不到入口）。
 */
export function appUpdateBlockedHint(info: AppUpdateInfo): string {
  if (info.debugBuild) return '当前是调试包（版本号带后缀）：装正式版会与它并存成两个 App，请手动安装发布版 APK。';
  if (info.ready && !info.canInstall) return '系统还没允许 Engram 安装应用：点「立即安装」会自动打开系统授权页，允许后返回会自动继续。';
  return '';
}

/** 是否需要「允许通知」按钮（Android 13+ 未授权时才提示，用于下载完成提醒） */
export function needsNotificationPermission(info: AppUpdateInfo): boolean {
  return info.ready && !info.notificationsEnabled;
}

/** 上次检查时间 → 「刚刚 / 3 分钟前 / 09-29 21:03」 */
export function appUpdateCheckedLabel(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '还没有检查过';
  const diff = now - at;
  if (diff < 60_000) return '刚刚检查过';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前检查过`;
  return `${new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 检查过`;
}

/** Release 正文只作为纯文本取前几条（与 UpdateNotice 同一口径，不渲染远端 Markdown） */
export function releaseHighlights(notes: string, limit = 5): string[] {
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:#{1,6}\s|```|---+$|\|\s*[-:]+|<)/.test(line))
    .map((line) => line.replace(/^[-*+]\s+|^\d+[.)]\s+/, '').replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '').trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => line.slice(0, 160));
}
