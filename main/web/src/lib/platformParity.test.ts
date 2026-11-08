import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 三端并行契约门禁（见 docs/PLATFORM-PARALLEL-DEV.md 第 6.1 节）。
 *
 * 这些断言全部是「读源码 + 正则」的静态检查，随 pnpm test 在 Docker verify 里跑：
 *  1. 版本号三处一致（desktop/package.json / web version.ts / docker-compose 镜像 tag）
 *  2. Android 版本号从 desktop/package.json 派生，不写死
 *  3. 三端内嵌 Web 都来自同一次 web 构建（桌面/Android/Docker 构建链）
 *  4. 能力位三处键集一致（web / server / Kotlin），漏改会让手机 fail-open
 *  5. 能力位语义（apkUpdate / agentAdmin / agentAccess / onlyOffice / serverUpdate / ddns / runtime / syncRoles）
 *  6. 原生桥契约：Web 用到的每个 __engram* 桥都能在 Android 源码找到实现
 *  7. 设置域手机可达（SETTINGS_DOMAINS ⊆ MOBILE_GROUPS ∪ {account}）
 *  8. 手机滞后清单无「当前版本目标」的待办
 *  9. 能力位键 / 运行形态都写进了平台规范文档
 *
 * 维护提示：解析依赖现有代码的书写形状（对象字面量缩进、Kotlin .put 写法）。
 * 如果重构改变了这些形状，请同步更新本文件的解析与 docs/PLATFORM-PARALLEL-DEV.md。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', '..');

function readMain(rel: string): string {
  return fs.readFileSync(path.join(mainRoot, rel), 'utf8');
}

function currentVersion(): string {
  const raw = JSON.parse(readMain('desktop/package.json')) as { version?: string };
  const version = raw.version;
  assert.ok(version, 'desktop/package.json 缺少 version');
  return version;
}

function pick(source: string, pattern: RegExp): string {
  const match = source.match(pattern);
  assert.ok(match, '未匹配到：' + pattern);
  return match[1] ?? '';
}

function section(source: string, pattern: RegExp): string {
  const match = source.match(pattern);
  assert.ok(match, '未匹配到：' + pattern);
  return match[0];
}

function braceBody(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, '找不到：' + marker);
  const open = source.indexOf('{', at);
  assert.ok(open > at, marker + ' 后没有 {');
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(marker + ' 括号不闭合');
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function featureSets(): { web: string[]; server: string[]; kotlin: string[] } {
  const capSrc = readMain('web/src/lib/capabilities.ts');
  const full = braceBody(capSrc, 'const fullCapabilities');
  const webBody = braceBody(full, 'features: {');
  const web = [...webBody.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);

  const serverSrc = readMain('server/src/routes/runtime.ts');
  const serverBody = braceBody(serverSrc, 'features: {');
  const server = [...serverBody.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*):\s*(?:true|false|officeConfigured\(\))/gm)].map((m) => m[1]);

  const kotlinSrc = readMain('mobile/android/app/src/main/java/com/engram/app/EngramLocalServer.kt');
  const marker = '.put("features", JSONObject()';
  const from = kotlinSrc.indexOf(marker);
  assert.ok(from >= 0, 'Kotlin 找不到 capabilities 的 features 段');
  const to = kotlinSrc.indexOf('get("/api/auth/status")', from);
  assert.ok(to > from, 'Kotlin features 段找不到结束位置');
  const kotlinBody = kotlinSrc.slice(from + marker.length, to);
  const kotlin = [...kotlinBody.matchAll(/\.put\("([a-zA-Z][a-zA-Z0-9]*)",/g)].map((m) => m[1]);

  return { web, server, kotlin };
}

test('版本号三处一致：desktop/package.json = web/src/version.ts = docker-compose 镜像 tag', () => {
  const version = currentVersion();
  const webVersion = pick(readMain('web/src/version.ts'), /APP_VERSION\s*=\s*'([^']+)'/);
  assert.equal(webVersion, version, 'web/src/version.ts 的 APP_VERSION 未跟版本号同步（发版必须同步 bump 三处）');
  const composeTag = pick(readMain('docker-compose.yml'), /^\s*image:\s*engram:(\S+)/m);
  assert.equal(composeTag, version, 'docker-compose.yml 的镜像 tag 未跟版本号同步（发版必须同步 bump 三处）');
});

test('Android 版本号从 desktop/package.json 派生，不写死', () => {
  const gradle = readMain('mobile/android/app/build.gradle');
  assert.match(gradle, /desktopPackageJson\s*=\s*file\('\.\.\/\.\.\/\.\.\/desktop\/package\.json'\)/, 'build.gradle 不再引用 desktop/package.json');
  assert.match(gradle, /versionCode\s+appVersionCode/, 'versionCode 没有从 appVersionCode 派生');
  assert.match(gradle, /versionName\s+appVersionName/, 'versionName 没有从 appVersionName 派生');
  assert.doesNotMatch(gradle, /versionName\s+'\d+\.\d+\.\d+'/, 'Android 写死了 versionName，会与发版版本号脱节');
});

test('三端内嵌 Web 构建链：桌面/Android/Docker 都来自同一次 web 构建', () => {
  assert.match(readMain('mobile/scripts/prepare-mobile-web.cjs'), /path\.resolve\(mobileRoot, '\.\.\/web\/dist'\)/, 'Android 不再复制 main/web/dist');
  assert.match(readMain('desktop/scripts/prepare-desktop.js'), /path\.join\(mainRoot, 'web', 'dist'\)/, '桌面端不再复制 main/web/dist');
  assert.match(readMain('Dockerfile'), /pnpm --filter @engram\/web build/, 'Docker 镜像不再构建 @engram/web');
  const desktopPkg = JSON.parse(readMain('desktop/package.json')) as { build?: { files?: string[] } };
  assert.ok(desktopPkg.build?.files?.includes('web/dist/**'), 'desktop/package.json 的 build.files 未包含 web/dist/**');
  const capacitor = JSON.parse(readMain('mobile/capacitor.config.json')) as { webDir?: string };
  assert.equal(capacitor.webDir, 'web-dist', 'Capacitor webDir 不是 web-dist（手机就不会用同一份 Web 构建）');
});

test('能力位三处键集一致（web / server / Kotlin）', () => {
  const { web, server, kotlin } = featureSets();
  assert.equal(web.length, 12, 'web 端能力位数量变了（预期 12）：新增/删除能力位时必须同步三处与文档矩阵');
  assert.deepEqual(sorted(server), sorted(web), 'server runtime.ts 的能力位键集与 web capabilities.ts 不一致');
  assert.deepEqual(sorted(kotlin), sorted(web), 'EngramLocalServer.kt 的能力位键集与 web capabilities.ts 不一致（漏改会让手机 fail-open）');
});

test('能力位语义：手机专属/桌面专属能力位取值正确', () => {
  const capSrc = readMain('web/src/lib/capabilities.ts');
  const serverSrc = readMain('server/src/routes/runtime.ts');
  const kotlinSrc = readMain('mobile/android/app/src/main/java/com/engram/app/EngramLocalServer.kt');

  assert.match(capSrc, /type RuntimeKind = 'server' \| 'desktop' \| 'android-local'/, '前端 RuntimeKind 三态定义缺失');
  assert.match(capSrc, /apkUpdate:\s*false/, 'web 端 apkUpdate 默认值应为 false');
  assert.match(serverSrc, /apkUpdate:\s*false/, 'server 端应显式返回 apkUpdate=false（能力位键集占位）');
  assert.match(serverSrc, /agentAdmin:\s*true/, 'server/desktop 端 agentAdmin 应为 true');
  assert.match(serverSrc, /runtime:\s*desktop \? 'desktop' : 'server'/, 'server 端 runtime 取值不再区分 desktop/server');

  assert.match(kotlinSrc, /\.put\("runtime", "android-local"\)/, 'Android runtime 不再是 android-local');
  assert.match(kotlinSrc, /\.put\("apkUpdate", true\)/, 'Android 端 apkUpdate 应为 true');
  assert.match(kotlinSrc, /\.put\("agentAdmin", false\)/, 'Android 端 agentAdmin 必须为 false（管理面不下发成员令牌）');
  assert.match(kotlinSrc, /\.put\("agentAccess", false\)/, 'Android 端 agentAccess 必须为 false（手机不跑 CLI）');
  assert.match(kotlinSrc, /\.put\("onlyOffice", false\)/, 'Android 端 onlyOffice 必须为 false');
  assert.match(kotlinSrc, /\.put\("serverUpdate", false\)/, 'Android 端 serverUpdate 必须为 false');
  assert.match(kotlinSrc, /\.put\("ddns", false\)/, 'Android 端 ddns 必须为 false');
  assert.match(kotlinSrc, /\.put\("syncRoles", JSONArray\(\)\.put\("none"\)\.put\("member"\)\)/, 'Android 端 syncRoles 只能是 none/member');
});

test('原生桥契约：Web 使用的每个 __engram* 桥都能在 Android 源码找到实现', () => {
  const webFiles = walk(path.join(mainRoot, 'web', 'src')).filter((file) => !file.endsWith('.test.ts'));
  const bridgeNames = new Set<string>();
  for (const file of webFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/__engram[A-Za-z0-9]+/g)) bridgeNames.add(match[0]);
  }
  assert.ok(bridgeNames.size >= 6, 'Web 端检测到的原生桥数量异常（预期至少 6 个）：' + sorted(bridgeNames).join(', '));
  const androidFiles = walk(path.join(mainRoot, 'mobile', 'android', 'app', 'src', 'main')).filter((file) => /\.(java|kt)$/.test(file));
  const androidText = androidFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const name of sorted(bridgeNames)) {
    assert.ok(androidText.includes(name), 'Web 使用了原生桥 ' + name + '，但 Android 源码里没有实现（缺桥会导致死按钮/异常）');
  }
});

test('设置域手机可达：SETTINGS_DOMAINS 每个大类都在手机 MOBILE_GROUPS 中（account 由账户卡特判）', () => {
  const domainsSrc = readMain('web/src/lib/settingsDomains.ts');
  const domainIds = [...domainsSrc.matchAll(/^\s{4}id: '([a-z]+)',$/gm)].map((m) => m[1]);
  assert.ok(domainIds.length >= 7, '设置大类数量异常：' + domainIds.length);
  const settingsView = readMain('web/src/views/SettingsView.vue');
  const mobileBlock = section(settingsView, /const MOBILE_GROUPS[\s\S]*?\];/);
  const mobileIds = [...mobileBlock.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  const reachable = new Set([...mobileIds, 'account']);
  for (const id of domainIds) {
    assert.ok(reachable.has(id), '设置大类 ' + id + ' 不在手机 MOBILE_GROUPS 里（手机永久不可达：补手机分组，或在 SettingsView 里明确例外）');
  }
  assert.deepEqual(sorted(reachable), sorted(new Set(domainIds)), '手机设置分组与 SETTINGS_DOMAINS 不一致（多出或缺少大类）');
});

test('手机滞后清单存在；当前版本的待办必须在本版本发版前清零', () => {
  const ledger = readMain('docs/MOBILE-SYNC-LEDGER.md');
  assert.match(ledger, /手机端同步滞后清单|MOBILE-SYNC-LEDGER/, '滞后清单缺失或标题不符');
  const rows = ledger
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()));
  const header = rows.find((row) => row.includes('状态') && row.includes('目标版本'));
  assert.ok(header, '滞后清单缺少表头（必须含 状态 / 目标版本 列）');
  const statusIndex = header.indexOf('状态');
  const targetIndex = header.indexOf('目标版本');
  const version = currentVersion();
  for (const row of rows) {
    if (row[statusIndex] === '待办' && (row[targetIndex] === version || row[targetIndex] === 'v' + version)) {
      assert.fail('滞后清单中有目标版本为 v' + version + ' 的待办：发版前必须补齐手机适配，或改为「不适用」并写原因');
    }
  }
});

test('平台差异已写入文档：能力位键/运行形态必须出现在 PLATFORM-PARALLEL-DEV.md', () => {
  const doc = readMain('docs/PLATFORM-PARALLEL-DEV.md');
  assert.match(doc, /三端并行开发规范/, '平台规范文档标题缺失');
  assert.match(doc, /平台影响/, '平台规范文档缺少「平台影响」声明约定');
  const { web } = featureSets();
  for (const key of web) {
    assert.ok(doc.includes(key), '能力位 ' + key + ' 未写入 docs/PLATFORM-PARALLEL-DEV.md 的能力位矩阵');
  }
  for (const runtime of ['android-local', 'desktop', 'server']) {
    assert.ok(doc.includes(runtime), '运行形态 ' + runtime + ' 未写入平台规范文档');
  }
});
