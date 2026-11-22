import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 手机「分享 → Engram → 收集箱」入口的静态护栏（2026-11）。
 *
 * 用户要求「手机端允许绝大部分软件分享给本软件，然后放到收集箱里面」。这条链路横跨
 * Manifest（分享目标注册）、MainActivity（Intent 解析/落盘）和 Web（落袋回执 + 打开收集箱），
 * 单端改动很容易悄悄收窄覆盖面，所以按源码锁关键声明：
 *   ① Manifest 同时注册带 MIME 与不带 MIME 的 SEND / SEND_MULTIPLE；
 *   ② MainActivity 收文字（含 ClipData 多段）、content:// 与 file://，并按 MIME 补扩展名；
 *   ③ Web 收到落袋通知后打开 /inbox 并刷新列表。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const mainRoot = path.resolve(here, '..', '..', '..');
const readMain = (rel: string) => fs.readFileSync(path.join(mainRoot, rel), 'utf8');

const manifest = readMain('mobile/android/app/src/main/AndroidManifest.xml');
const mainActivity = readMain('mobile/android/app/src/main/java/com/engram/app/MainActivity.java');
const inboxFiles = readMain('mobile/android/app/src/main/java/com/engram/app/InboxFiles.kt');
const shareInbox = readMain('web/src/lib/shareInbox.ts');

const intentFilters = [...manifest.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g)]
  .map((match) => match[1]);

test('① Manifest 注册所有 MIME 的分享目标，也接住不带 MIME 的分享 Intent', () => {
  const send = intentFilters.filter((filter) => /android.intent.action.SEND"/.test(filter));
  assert.ok(send.length >= 2, '缺少 ACTION_SEND 分享目标：其他应用的分享面板里不会出现 Engram');
  assert.ok(
    send.some((filter) => /android:mimeType="\*\/\*"/.test(filter)),
    '缺少 */* 的 SEND 过滤器：图片/视频/文档等带 MIME 的分享进不来',
  );
  assert.ok(
    send.some((filter) => !/<data\b/.test(filter)),
    '缺少不带 data 的 SEND 过滤器：少数旧应用/定制 ROM 的分享 Intent 不带 MIME type，会匹配不到',
  );
  assert.ok(
    intentFilters.some((filter) => /android.intent.action.SEND_MULTIPLE"/.test(filter)),
    '缺少 ACTION_SEND_MULTIPLE：相册多选分享进不来',
  );
});

test('② MainActivity 收文字、content:// 与 file://，并按 MIME 补扩展名', () => {
  const share = mainActivity.match(/private void handleIncomingShare\(Intent intent\)[\s\S]*?\n    \}/);
  assert.ok(share, '找不到 handleIncomingShare');
  const body = share[0];
  assert.match(body, /Intent\.ACTION_SEND_MULTIPLE\.equals\(action\)/, '没处理 SEND_MULTIPLE');
  assert.match(body, /Intent\.EXTRA_HTML_TEXT/, '没有 HTML 分享兜底');
  assert.match(body, /Intent\.EXTRA_TITLE/, '标题只取 EXTRA_SUBJECT：部分浏览器只填 EXTRA_TITLE');
  assert.match(body, /getItemAt\(i\)\.getText\(\)/, '没有读 ClipData 里的文字：只放 ClipData 的分享会丢内容');
  assert.match(body, /"file"\.equalsIgnoreCase\(scheme\)/, 'file:// 分享被直接拒绝：旧应用分享不进来');
  assert.match(body, /InboxFiles\.INSTANCE\.withExtension\(/, '无扩展名的分享文件没有按 MIME 补扩展名');
  assert.match(
    body,
    /specificMime\(resolverMime\)/,
    'URI 的 MIME 优先于分享方 type：FileProvider 对无扩展名文件会报 application/octet-stream，扩展名就补不上了',
  );
  assert.match(body, /server\.importSharedText\(/, '文字没有落到收集箱');
  assert.match(body, /server\.importSharedFile\(/, '文件没有落到收集箱');
});

test('③ InboxFiles 提供 MIME → 扩展名兜底，且不改已有扩展名', () => {
  assert.match(inboxFiles, /fun withExtension\(name: String, mime: String\?\): String/);
  assert.match(inboxFiles, /MIME_EXTENSIONS/);
  const body = inboxFiles.match(/fun withExtension[\s\S]*?\n    \}/);
  assert.ok(body, '找不到 withExtension 实现');
  assert.match(body[0], /if \(clean\.contains\('\.'\)\) return clean/, '已有扩展名被按 MIME 改写');
});

test('④ 网页收到落袋通知后打开收集箱并刷新列表', () => {
  assert.match(shareInbox, /window\.__engramShareInbox\s*=\s*delivery\.receive/, '没有挂载落袋接收函数');
  assert.match(shareInbox, /path:\s*'\/inbox'/, '落袋后没有打开收集箱');
  assert.match(shareInbox, /inbox\.load\(\)/, '落袋后没有刷新收集箱列表');
});
