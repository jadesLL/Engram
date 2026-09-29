import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appUpdateActionLabel,
  appUpdateBlockedHint,
  appUpdateCheckedLabel,
  appUpdateStatusText,
  emptyAppUpdateInfo,
  formatBytes,
  needsNotificationPermission,
  normalizeAppUpdateInfo,
  releaseHighlights,
  type AppUpdateInfo,
} from './appUpdate.ts';

/**
 * 手机端 OTA 的状态与文案口径（web 侧）：
 * 这些文字直接显示给用户看「在下载 / 该点安装 / 卡在哪」，判错会让人以为更新已经完成
 * 或者找不到该去哪配更新源，所以逐条锁住。
 */

const info = (patch: Partial<AppUpdateInfo> = {}): AppUpdateInfo => ({ ...emptyAppUpdateInfo(), ...patch });

test('normalizeAppUpdateInfo 把服务端返回体收敛成完整状态', () => {
  const parsed = normalizeAppUpdateInfo({
    currentVersion: '1.3.2',
    latestVersion: '1.3.3',
    hasUpdate: true,
    phase: 'downloading',
    percent: '42',
    downloadedBytes: 1024,
    totalBytes: 4096,
    configured: true,
    repoUrl: 'https://gitea.example.com/example/Engram',
    autoUpdate: true,
    ready: false,
    canInstall: false,
  });
  assert.equal(parsed.currentVersion, '1.3.2');
  assert.equal(parsed.latestVersion, '1.3.3');
  assert.equal(parsed.phase, 'downloading');
  assert.equal(parsed.percent, 42);
  assert.equal(parsed.canInstall, false);
  // 缺字段按「没有」处理，界面不会渲染出 undefined
  assert.equal(parsed.releaseTag, '');
  assert.equal(parsed.error, '');
  assert.equal(parsed.tokenSaved, false);
  // 未知 phase 收敛到 idle（引擎只会有这五种）
  assert.equal(normalizeAppUpdateInfo({ phase: 'weird' }).phase, 'idle');
  assert.equal(normalizeAppUpdateInfo(null).runtime, 'android');
});

test('归一化保留「地址来自同步中枢」与「本机手填过」两个来源标记', () => {
  const fromHub = normalizeAppUpdateInfo({
    configured: true,
    repoUrl: 'https://gitea.example.com/example/Engram',
    fromHub: true,
    hasLocalSource: false,
  });
  assert.equal(fromHub.fromHub, true);
  assert.equal(fromHub.hasLocalSource, false);

  const local = normalizeAppUpdateInfo({ configured: true, fromHub: false, hasLocalSource: true });
  assert.equal(local.fromHub, false);
  assert.equal(local.hasLocalSource, true);
});

test('formatBytes 人话单位', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(48 * 1024 * 1024), '48 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GB');
});

test('状态行文案覆盖「未配置 / 下载中 / 待安装 / 失败 / 已是最新」', () => {
  assert.match(appUpdateStatusText(info()), /还没配更新源/);
  assert.match(appUpdateStatusText(info({ configured: true, phase: 'checking' })), /正在检查/);
  const downloading = appUpdateStatusText(info({
    configured: true,
    phase: 'downloading',
    latestVersion: '1.3.3',
    percent: 42,
    downloadedBytes: 20 * 1024 * 1024,
    totalBytes: 48 * 1024 * 1024,
  }));
  assert.match(downloading, /v1\.3\.3/);
  assert.match(downloading, /42%/);
  assert.match(downloading, /20 MB \/ 48 MB/);
  // 总量未知（服务端没给 Content-Length）时退化成「已下载多少」
  assert.match(
    appUpdateStatusText(info({ configured: true, phase: 'downloading', downloadedBytes: 1024 * 1024, totalBytes: 0 })),
    /已下载 1 MB/,
  );
  assert.match(appUpdateStatusText(info({ configured: true, phase: 'error', error: '网络不可达' })), /网络不可达/);
  assert.match(appUpdateStatusText(info({ configured: true, ready: true, latestVersion: '1.3.3' })), /点「立即安装」/);
  assert.match(appUpdateStatusText(info({ configured: true, hasUpdate: true, latestVersion: '1.3.3', currentVersion: '1.3.2' })), /有新版本 v1\.3\.3/);
  assert.match(appUpdateStatusText(info({ configured: true, checkedAt: '2026-09-29T14:00:00.000Z' })), /已是最新/);
});

test('主按钮三态：检查 / 下载安装包 / 立即安装', () => {
  assert.equal(appUpdateActionLabel(info({ configured: true })), '检查更新');
  assert.equal(appUpdateActionLabel(info({ configured: true, hasUpdate: true, latestVersion: '1.3.3' })), '下载安装包');
  assert.equal(appUpdateActionLabel(info({ configured: true, ready: true, latestVersion: '1.3.3' })), '立即安装');
  assert.equal(appUpdateActionLabel(info({ configured: true, phase: 'downloading', percent: 7 })), '下载中 7%');
  assert.equal(appUpdateActionLabel(info({ configured: true, phase: 'downloading' })), '下载中…');
});

test('阻塞提示：调试包与「安装未知应用」权限', () => {
  assert.equal(appUpdateBlockedHint(info()), '');
  assert.match(appUpdateBlockedHint(info({ debugBuild: true })), /调试包/);
  assert.match(appUpdateBlockedHint(info({ ready: true, canInstall: false })), /去开启安装权限/);
  // 没下载完时不提权限（先下完再说）
  assert.equal(appUpdateBlockedHint(info({ ready: false, canInstall: false })), '');
});

test('通知权限只在「已下载完成 + 未授权」时提示申请', () => {
  assert.equal(needsNotificationPermission(info({ ready: true, notificationsEnabled: false })), true);
  assert.equal(needsNotificationPermission(info({ ready: true, notificationsEnabled: true })), false);
  assert.equal(needsNotificationPermission(info({ ready: false, notificationsEnabled: false })), false);
});

test('检查时间人话：刚刚 / 几分钟前 / 具体时间', () => {
  const now = Date.parse('2026-09-29T12:00:00.000Z');
  assert.equal(appUpdateCheckedLabel('', now), '还没有检查过');
  assert.equal(appUpdateCheckedLabel('2026-09-29T11:59:30.000Z', now), '刚刚检查过');
  assert.equal(appUpdateCheckedLabel('2026-09-29T11:30:00.000Z', now), '30 分钟前检查过');
  assert.match(appUpdateCheckedLabel('2026-09-28T09:00:00.000Z', now), /9\/28/);
});

test('releaseHighlights 只取纯文本前几条，不渲染 Markdown/HTML', () => {
  const notes = [
    '# v1.3.3',
    '',
    '- 安卓端支持应用内在线更新',
    '2. 下载完成后一键调起系统安装器',
    '',
    '普通段落一句',
  ].join('\n');
  assert.deepEqual(releaseHighlights(notes, 5), ['安卓端支持应用内在线更新', '下载完成后一键调起系统安装器', '普通段落一句']);
  // 链接与强调标记都剥掉，只留纯文本；条目数按 limit 截断
  assert.deepEqual(releaseHighlights('## v1.3.4\n- [链接](https://x/y) **加粗** 内容'), ['链接 加粗 内容']);
  assert.equal(releaseHighlights('- a\n- b\n- c', 2).length, 2);
});
