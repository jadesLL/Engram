import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKGROUND_SYNC_MINUTES,
  backgroundSyncView,
  missingPermissionLabels,
  permissionLabel,
  remainingMinutes,
} from './backgroundSync.ts';

/**
 * 安卓端「退到后台后还能再同步 10 分钟」的护栏（2026-11）。
 *
 * 用户口径：「允许手机端后台同步 10 分钟，退到后台后还有 10 分钟可以同步；软件需要什么权限都要主动申请，
 * 每次使用如果没权限都要申请。」
 *
 * 这条链断任何一环，用户看到的就是「切到别的 App 同步就停了」或「后台同步悄悄跑不满」：
 *   ① 原生宽限窗口 = 10 分钟（BackgroundSyncPolicy.GRACE_MS，通知文案与窗口同源）；
 *   ② 窗口期有前台服务（dataSync）+ 唤醒锁保活，否则进程会在十秒级被冻结；
 *   ③ 两枚权限（通知 / 电池优化）在 Manifest 声明、原生会主动申请、永久拒绝时跳设置页；
 *   ④ 设置页把状态与「申请权限」入口渲染出来，并且文案不再写旧口径（5 分钟）。
 *
 * 版式没法单测，沿用 settingsLayout.test.ts 的写法：读源码断言关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const mainRoot = path.resolve(here, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');
const readSrc = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

const POLICY = 'mobile/android/app/src/main/java/com/engram/app/BackgroundSyncPolicy.kt';
const SERVICE = 'mobile/android/app/src/main/java/com/engram/app/SyncGraceService.kt';
const PERMISSIONS = 'mobile/android/app/src/main/java/com/engram/app/BackgroundSyncPermissions.kt';
const SYNC_PERMISSIONS = 'mobile/android/app/src/main/java/com/engram/app/SyncPermissions.java';
const MANIFEST = 'mobile/android/app/src/main/AndroidManifest.xml';
const SERVER = 'mobile/android/app/src/main/java/com/engram/app/EngramLocalServer.kt';
const ACTIVITY = 'mobile/android/app/src/main/java/com/engram/app/MainActivity.java';

test('窗口：原生宽限是 10 分钟，通知文案与窗口同源', () => {
  const policy = read(POLICY);
  assert.match(policy, /const val GRACE_MS = 10 \* 60_000L/, '宽限窗口不是 10 分钟（需求口径）');
  assert.match(policy, /get\(\) = \(GRACE_MS \/ 60_000L\)\.toInt\(\)/, 'GRACE_MINUTES 必须从 GRACE_MS 派生，不能各写一个数');
  assert.equal(BACKGROUND_SYNC_MINUTES, 10, 'Web 侧的分钟数与原生同口径');
  const service = read(SERVICE);
  assert.match(service, /BackgroundSyncPolicy\.GRACE_MINUTES/, '前台服务通知文案要引用同一个分钟数');
});

test('保活：窗口期用 dataSync 前台服务 + 唤醒锁，结束即停', () => {
  const service = read(SERVICE);
  assert.match(service, /class SyncGraceService : Service\(\)/, '没有前台服务实现');
  assert.match(service, /FOREGROUND_SERVICE_TYPE_DATA_SYNC/, '前台服务没带 dataSync 类型（Android 14 起会崩）');
  assert.match(service, /PARTIAL_WAKE_LOCK/, '没有部分唤醒锁：熄屏后 10 分钟跑不完');
  assert.match(service, /lock\.acquire\(BackgroundSyncPolicy\.GRACE_MS/, '唤醒锁必须按宽限窗口自动超时，不能泄漏');
  assert.match(service, /START_NOT_STICKY/, '前台服务不能常驻重启');
  const manifest = read(MANIFEST);
  assert.match(manifest, /<service[^>]*SyncGraceService/, 'Manifest 没声明后台同步前台服务');
  assert.match(manifest, /foregroundServiceType="dataSync"/, '前台服务缺少 dataSync 类型声明');
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_DATA_SYNC/, '缺少 FOREGROUND_SERVICE_DATA_SYNC 权限');
  assert.match(manifest, /android\.permission\.WAKE_LOCK/, '缺少 WAKE_LOCK 权限');
});

test('权限：两枚运行时权限都在 Manifest 声明，且原生会主动申请', () => {
  const manifest = read(MANIFEST);
  for (const permission of [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  ]) {
    assert.ok(manifest.includes(permission), `Manifest 缺少 ${permission}`);
  }
  const permissions = read(PERMISSIONS);
  assert.match(permissions, /ACTION_REQUEST_NOTIFICATIONS/, '没有「申请通知」这条动作');
  assert.match(permissions, /ACTION_REQUEST_BATTERY/, '没有「申请电池优化」这条动作');
  assert.match(permissions, /ACTION_NOTIFICATION_SETTINGS/, '永久拒绝通知时要能跳设置页');
  const host = read(SYNC_PERMISSIONS);
  assert.match(host, /ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/, '没有弹系统「允许后台运行」对话框');
  assert.match(host, /isIgnoringBatteryOptimizations/, '没有判断电池优化是否已豁免');
});

test('接线：host 模式申请权限，本地接口给状态，回到前台每次都会再问', () => {
  const server = read(SERVER);
  assert.match(server, /get\("\/api\/sync\/background"\)/, '缺少后台同步状态接口');
  assert.match(server, /post\("\/api\/sync\/background\/permissions"\)/, '缺少「申请权限」接口');
  assert.match(server, /SyncGraceService\.start\(context\)/, '同步引擎的宽限回调没有拉起前台服务');
  assert.match(server, /fun onUserLeaveHint\(\)/, '缺 onUserLeaveHint 接线（Android 12+ 只能在前台启动前台服务）');
  assert.match(server, /fun wantsBackgroundSyncPermissions\(\)/, '缺少「要不要申请权限」的判定');
  const activity = read(ACTIVITY);
  assert.match(activity, /implements BackgroundSyncHost/, 'MainActivity 没有实现权限宿主');
  assert.match(activity, /autoRequestBackgroundSyncPermissions\(\)/, '回到前台没有自动申请权限');
  assert.match(activity, /backgroundSyncPermissionAsked = false/, '退到后台没重置「本次是否已申请」（要求每次使用都检查）');
});

test('界面：设置页渲染状态与申请入口，不再写 5 分钟旧口径', () => {
  const panel = readSrc('components/settings/SyncPanel.vue');
  assert.match(panel, /backgroundSyncView/, '设置页没有用后台同步视图模型');
  assert.match(panel, /requestBackgroundPermissions/, '设置页没有「申请权限」入口');
  assert.match(panel, /后台同步/, '设置页缺少后台同步卡片');
  assert.doesNotMatch(panel, /退到后台后最多再同步 5 分钟/, '还留着 5 分钟的旧文案');
});

test('文案：状态标签与缺失权限符合界面口径', () => {
  assert.equal(permissionLabel('notifications'), '通知');
  assert.equal(permissionLabel('battery'), '电池优化');
  assert.equal(remainingMinutes(0), 0);
  assert.equal(remainingMinutes(60_000), 1);
  assert.equal(remainingMinutes(60_001), 2);

  assert.equal(backgroundSyncView(null), null, '桌面 / Docker 没有这个字段 → 整块隐藏');
  assert.equal(backgroundSyncView({ supported: false }), null);

  const idle = backgroundSyncView({ supported: true, enabled: true, graceMinutes: 10, missing: [] });
  assert.ok(idle);
  assert.equal(idle.statusLabel, '已就绪 · 最多 10 分钟');
  assert.equal(idle.allGranted, true);
  assert.match(idle.hint, /最多 10 分钟/);

  const running = backgroundSyncView({ supported: true, enabled: true, active: true, remainingMs: 8 * 60_000 });
  assert.equal(running?.statusLabel, '后台同步中 · 还剩 8 分钟');

  const unbound = backgroundSyncView({ supported: true, enabled: false, missing: ['battery'] });
  assert.equal(unbound?.statusLabel, '绑定中枢后生效');

  const missing = backgroundSyncView({ supported: true, enabled: true, missing: ['notifications', 'battery'] });
  assert.deepEqual(missing?.missingLabels, ['通知', '电池优化']);
  assert.equal(missing?.allGranted, false);

  // 旧服务端没有 missing 时按 permissions 推导
  assert.deepEqual(
    missingPermissionLabels({ permissions: { notifications: false, battery: true } }),
    ['通知'],
  );
  assert.deepEqual(missingPermissionLabels({ permissions: { notifications: true, battery: true } }), []);
});
