import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 安卓 13+ 预测性返回（predictive back）的接线护栏。
 *
 * 背景：过去只有 `OnBackPressedCallback`——系统一按返回/侧滑就问网页「这一层要不要吃」。
 * Android 13（API 33）起系统改用 `OnBackInvokedDispatcher` 派发返回；只要 Manifest 打开
 * `android:enableOnBackInvokedCallback`，旧式回调就再也收不到事件。不补这条桥，手机上的
 * 返回键与侧滑要么没人处理、要么直接退回系统默认（退出应用）。
 *
 * 三个不变式（断一条就退回「侧滑不是返回」）：
 *   ① Manifest 打开开关，且不顺手改掉同一节点上的接口/键盘契约；
 *   ② API 33+ 注册 `OnBackInvokedCallback`（用 PRIORITY_OVERLAY，见下），33 以下保留旧式回调，
 *      两条路径互斥（同一时刻只挂一个，避免双触发）；
 *   ③ 两条路径共用同一个判定入口，网页契约 `__engramHandleBack` 只允许有一个探针。
 *
 * 为什么是 PRIORITY_OVERLAY：androidx 会把启用中的 OnBackPressedCallback 桥接到
 * OnBackInvokedDispatcher，注册的优先级是 PRIORITY_DEFAULT；同级下「后注册者」先被调用，
 * 运行期任何 addCallback 引起的重新注册都可能把返回抢走。OVERLAY 恒定优先，返回入口才确定。
 *
 * 版式与真机行为没法用单测跑，沿用同目录 mobileLayout.test.ts / mobileShellUx.test.ts 的写法：
 * 读源码断言关键声明。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** 测试跑在 main/web/src/lib 下，向上三层就是 worktree 的 main/ */
const mainRoot = path.resolve(here, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

const MANIFEST = 'mobile/android/app/src/main/AndroidManifest.xml';
const ACTIVITY = 'mobile/android/app/src/main/java/com/engram/app/MainActivity.java';
const APP_GRADLE = 'mobile/android/app/build.gradle';
const VARIABLES_GRADLE = 'mobile/android/variables.gradle';

test('Manifest 打开预测性返回开关', () => {
  const manifest = read(MANIFEST);
  assert.match(
    manifest,
    /<application[\s\S]{0,600}?android:enableOnBackInvokedCallback="true"/,
    'application 没打开 android:enableOnBackInvokedCallback：系统仍走旧式 onBackPressed，手势没有任何预测动画',
  );
  // 开关加在同一个 <application>/<activity> 上，别顺手动到键盘与导出契约
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/, 'adjustResize 被顺手改掉了：键盘弹起会顶飞底部元素');
});

test('API 33+ 注册 OnBackInvokedCallback，且用 PRIORITY_OVERLAY 抢占', () => {
  const activity = read(ACTIVITY);
  assert.match(
    activity,
    /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU/,
    '没有 API 33 分支：低版本设备会解析不存在的类（NoClassDefFoundError）',
  );
  assert.match(
    activity,
    /getOnBackInvokedDispatcher\(\)\.registerOnBackInvokedCallback\(/,
    '没注册 OnBackInvokedCallback：打开开关后返回键与侧滑会完全没人处理',
  );
  assert.match(
    activity,
    /OnBackInvokedDispatcher\.PRIORITY_OVERLAY/,
    '没用 PRIORITY_OVERLAY：androidx 桥接回调与后续 addCallback 都在 PRIORITY_DEFAULT，同级后注册者会抢走返回',
  );
  assert.doesNotMatch(
    activity,
    /OnBackInvokedDispatcher\.PRIORITY_DEFAULT/,
    '还留着 OnBackInvokedDispatcher.PRIORITY_DEFAULT：与 androidx 桥接回调同级，谁最新谁生效，返回入口不确定',
  );
});

test('33 以下保留 OnBackPressedCallback，两条路径互斥且共用同一判定', () => {
  const activity = read(ACTIVITY);
  assert.match(activity, /new OnBackPressedCallback\(true\)/, 'minSdk 23：必须保留旧式回调兜底，否则 33 以下返回没反应');

  // 33+ 分支注册完立即 return，旧回调只能落在它后面——同一时刻只挂一个
  const registerIndex = activity.indexOf('registerOnBackInvokedCallback(');
  const returnIndex = activity.indexOf('return;', registerIndex);
  const legacyIndex = activity.indexOf('new OnBackPressedCallback(true)');
  assert.ok(
    registerIndex > 0 && returnIndex > registerIndex && legacyIndex > returnIndex,
    '两条注册路径没有互斥：33+ 分支没 return 就继续挂了旧回调，可能同一次返回触发两次',
  );

  assert.match(
    activity,
    /getOnBackInvokedDispatcher\(\)\.unregisterOnBackInvokedCallback\(/,
    'onDestroy 没注销预测性返回回调：Activity 重建后会叠出第二个返回入口',
  );

  // 两条路径必须落到同一个判定实现上
  assert.match(activity, /this::handleSystemBack/, '33+ 的 OnBackInvokedCallback 没接到 handleSystemBack');
  assert.match(
    activity,
    /new OnBackPressedCallback\(true\)[\s\S]{0,200}?handleSystemBack\(\);/,
    '33 以下的旧回调没接到 handleSystemBack：两条路径的判定会各写一套',
  );
  assert.match(activity, /BackPolicy\.decide\(/, '判定没走 BackPolicy.decide：网页/历史/退后台三分支丢了');
});

test('网页返回契约只有一个探针', () => {
  const activity = read(ACTIVITY);
  const lines = activity.split('\n').filter((line) => line.includes('__engramHandleBack'));
  assert.equal(lines.length, 1, `__engramHandleBack 只允许出现在一行里（唯一契约站点），实际 ${lines.length} 行`);

  // 契约必须是 evaluateJavascript 的直接实参（字符串在下一行，所以要回看调用点而不是匹配整行）
  const at = activity.indexOf('__engramHandleBack');
  const call = activity.lastIndexOf('evaluateJavascript(', at);
  assert.ok(call >= 0 && at - call < 160, '__engramHandleBack 的探针没挂在 evaluateJavascript 调用里');
  assert.doesNotMatch(activity.slice(call, at), /;/, '契约不在 evaluateJavascript 的实参里（调用前已经结束了一条语句）');

  // 那一行里出现两次是三元表达式本身（是否存在 + 调用）；再多就是又加了第二处探针
  const tokenCount = activity.split('__engramHandleBack').length - 1;
  assert.equal(tokenCount, 2, `契约表达式应只出现两次（判断 + 调用），实际 ${tokenCount} 次：多出来的是第二处探针`);
});

test('minSdk 23 不冲突：compileSdk 够新，33 以下靠分支兜底', () => {
  const appGradle = read(APP_GRADLE);
  assert.match(appGradle, /minSdkVersion rootProject\.ext\.minSdkVersion/, 'app/build.gradle 没从 variables.gradle 取 minSdk');
  assert.match(appGradle, /compileSdk rootProject\.ext\.compileSdkVersion/, 'app/build.gradle 没从 variables.gradle 取 compileSdk');

  const variables = read(VARIABLES_GRADLE);
  const minSdkMatch = variables.match(/minSdkVersion\s*=\s*(\d+)/);
  const compileSdkMatch = variables.match(/compileSdkVersion\s*=\s*(\d+)/);
  assert.ok(minSdkMatch, 'variables.gradle 找不到 minSdkVersion');
  assert.ok(compileSdkMatch, 'variables.gradle 找不到 compileSdkVersion');
  const minSdk = Number(minSdkMatch[1]);
  const compileSdk = Number(compileSdkMatch[1]);

  assert.equal(minSdk, 23, `minSdk 变成 ${minSdk} 了：预测性返回的 SDK 分支与 33 以下兜底要同步重算`);
  assert.ok(compileSdk >= 33, `compileSdk ${compileSdk} < 33：android:enableOnBackInvokedCallback 与 OnBackInvoked* 根本编译不过`);

  // 33 才有的类型只在 SDK 分支里读写：onDestroy 里 SDK 判断必须排在字段读取之前（短路求值）
  const activity = read(ACTIVITY);
  const destroy = activity.slice(activity.indexOf('public void onDestroy()'));
  assert.match(
    destroy,
    /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.TIRAMISU && backInvokedCallback != null/,
    'onDestroy 先读字段再判 SDK：API 33 以下会在类链接期解析 OnBackInvokedCallback 而崩',
  );
});
