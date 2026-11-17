import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  DOXENT_MARKER_FILE,
  doxentSkillRoot,
  doxentSkillState,
  doxentSkillUrl,
  installDoxentSkill,
  parseDoxentLoginBlock,
  parseDoxentLoginState,
  readDoxentSkillVersion,
  removeDoxentSkill,
} from './doxent.js';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doxent-test-'));
}

/** 真实 CLI 输出的形状：起止标记 + 页面类型 + markdown 链接 + 字符二维码 */
const LOGIN_OUTPUT = [
  'DOXENT CLI v1.0.4',
  '<!-- doxent-cli-remote-login:start -->',
  '页面类型：登录',
  '登录地址：[打开登录页面](https://cli.iflyink.com/login?sn=nsn_abc&pollKey=deadbeef)',
  'TUI 字符二维码：',
  '```',
  '████ ▄▄▄▄▄ ██',
  '```',
  '完成登录后请告诉我，我会继续确认 CLI 登录状态。',
  '<!-- doxent-cli-remote-login:end -->',
].join('\n');

const SETTINGS_OUTPUT = LOGIN_OUTPUT
  .replace('页面类型：登录', '页面类型：设置')
  .replace('打开登录页面', '打开设置页面')
  .replace('cli.iflyink.com/login', 'cli.iflyink.com/settings');

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return zip.generateAsync({ type: 'uint8array' });
}

/** 官方包的骨架：SKILL.md + 客户端脚本 + meta.json */
const PACKAGE_FILES: Record<string, string> = {
  'SKILL.md': ['---', 'name: doxent', 'display_name: 讯飞办公本', '---', '', '# doxent', ''].join('\n'),
  'meta.json': JSON.stringify({ version: '1.3.10' }, null, 2),
  'shared/scripts/doxent_api.py': '#!/usr/bin/env python3\nprint("doxent")\n',
  'note/MODULE.md': '# note\n',
};

/** 假 fetch：按调用次数返回同一份技能包，并记录调用次数 */
function fetchStub(payload: Uint8Array): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(payload, { status: 200, headers: { 'content-type': 'application/zip' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test('parseDoxentLoginBlock：从真实输出里取页面类型与链接（不碰二维码）', () => {
  assert.deepEqual(parseDoxentLoginBlock(LOGIN_OUTPUT), {
    pageType: '登录',
    url: 'https://cli.iflyink.com/login?sn=nsn_abc&pollKey=deadbeef',
  });
  const settings = parseDoxentLoginBlock(SETTINGS_OUTPUT);
  assert.equal(settings?.pageType, '设置');
  assert.equal(settings?.url, 'https://cli.iflyink.com/settings?sn=nsn_abc&pollKey=deadbeef');
});

test('parseDoxentLoginBlock：缺区块 / 缺类型 / 缺链接时返回 null（不能编造登录地址）', () => {
  assert.equal(parseDoxentLoginBlock('DOXENT CLI v1.0.4\n未登录'), null);
  assert.equal(parseDoxentLoginBlock('页面类型：登录\n没有链接'), null);
  assert.equal(parseDoxentLoginBlock('[打开登录页面](https://cli.iflyink.com/login?x=1)'), null);
});

test('parseDoxentLoginState：已登录 / 未登录 / 认不出来按未知', () => {
  assert.equal(parseDoxentLoginState('未登录'), 'logged-out');
  assert.equal(parseDoxentLoginState('已登录：张三（138****8888）'), 'logged-in');
  assert.equal(parseDoxentLoginState('服务启动中…'), 'unknown');
  assert.equal(parseDoxentLoginState(''), 'unknown');
});

test('技能目录与版本：<home>/skills/doxent 与 meta.json 的 version', () => {
  const home = tempHome();
  assert.equal(doxentSkillRoot(home), path.join(home, 'skills', 'doxent'));
  const root = doxentSkillRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ version: '1.3.10' }));
  assert.equal(readDoxentSkillVersion(root), '1.3.10');
  assert.equal(readDoxentSkillVersion(path.join(home, 'nope')), undefined);
});

test('installDoxentSkill：解包 + 写标记 + 幂等（第二次不再下载）', async () => {
  const home = tempHome();
  const payload = await zipOf(PACKAGE_FILES);
  const stub = fetchStub(payload);

  const first = await installDoxentSkill({ home, url: 'https://example.test/skill.zip', fetchImpl: stub.fetchImpl });
  assert.equal(first.installed, true);
  assert.equal(first.managed, true);
  assert.equal(first.version, '1.3.10');
  assert.equal(fs.existsSync(path.join(first.root, 'shared', 'scripts', 'doxent_api.py')), true);
  const marker = JSON.parse(fs.readFileSync(path.join(first.root, DOXENT_MARKER_FILE), 'utf8'));
  assert.equal(marker.source, 'https://example.test/skill.zip');
  assert.equal(marker.version, '1.3.10');

  const second = await installDoxentSkill({ home, url: 'https://example.test/skill.zip', fetchImpl: stub.fetchImpl });
  assert.equal(second.installed, true);
  assert.equal(stub.calls(), 1, '已装且不强制重装时不该再下载');
});

test('installDoxentSkill：接管手工装的官方技能（补标记、不下载）', async () => {
  const home = tempHome();
  const root = doxentSkillRoot(home);
  fs.mkdirSync(path.join(root, 'shared', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: doxent\n---\n');
  fs.writeFileSync(path.join(root, 'shared', 'scripts', 'doxent_api.py'), 'print(1)\n');
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ version: '1.2.0' }));

  const stub = fetchStub(await zipOf(PACKAGE_FILES));
  const state = await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  assert.equal(state.managed, true, '手工装的官方包要被接管，后续才能升级/解绑');
  assert.equal(state.version, '1.2.0');
  assert.equal(stub.calls(), 0);
});

test('installDoxentSkill：同名目录不是官方技能时拒绝覆盖', async () => {
  const home = tempHome();
  const root = doxentSkillRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: my-own-skill\n---\n');
  fs.writeFileSync(path.join(root, 'notes.md'), '用户自己的内容');

  const stub = fetchStub(await zipOf(PACKAGE_FILES));
  await assert.rejects(
    () => installDoxentSkill({ home, fetchImpl: stub.fetchImpl }),
    /拒绝覆盖/,
  );
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '用户自己的内容');
});

test('installDoxentSkill：zip 里的 .. 路径不会写到技能目录之外', async () => {
  const home = tempHome();
  const payload = await zipOf({ ...PACKAGE_FILES, '../escaped.txt': 'escape' });
  const stub = fetchStub(payload);
  const state = await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  const escaped = path.join(path.dirname(state.root), 'escaped.txt');
  assert.equal(fs.existsSync(escaped), false, '解压穿越必须被挡掉');
});

test('installDoxentSkill：包内容不完整时报错（不留下半装目录）', async () => {
  const home = tempHome();
  const payload = await zipOf({ 'SKILL.md': '---\nname: doxent\n---\n' });
  const stub = fetchStub(payload);
  await assert.rejects(() => installDoxentSkill({ home, fetchImpl: stub.fetchImpl }), /内容不完整/);
  assert.equal(fs.existsSync(doxentSkillRoot(home)), false);
});

test('removeDoxentSkill：只删 Engram 管理的目录', async () => {
  const home = tempHome();
  const payload = await zipOf(PACKAGE_FILES);
  const stub = fetchStub(payload);
  const state = await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  assert.equal(removeDoxentSkill(home), true);
  assert.equal(fs.existsSync(state.root), false);

  // 手工目录（无标记）不删
  const manual = doxentSkillRoot(home);
  fs.mkdirSync(manual, { recursive: true });
  fs.writeFileSync(path.join(manual, 'SKILL.md'), '---\nname: doxent\n---\n');
  assert.equal(removeDoxentSkill(home), false);
  assert.equal(fs.existsSync(manual), true);
});

test('doxentStatus 的目录状态：没装 / 装了 / 未管理三种口径', async () => {
  const home = tempHome();
  assert.equal(doxentSkillState(home).installed, false);
  const stub = fetchStub(await zipOf(PACKAGE_FILES));
  await installDoxentSkill({ home, fetchImpl: stub.fetchImpl });
  const installed = doxentSkillState(home);
  assert.deepEqual(
    { installed: installed.installed, managed: installed.managed, version: installed.version },
    { installed: true, managed: true, version: '1.3.10' },
  );
});

test('doxentSkillUrl：ENGRAM_DOXENT_SKILL_URL 覆盖默认官方地址', () => {
  assert.equal(doxentSkillUrl({}), 'https://download.iflyink.com/apk/doxent_skills.zip');
  assert.equal(doxentSkillUrl({ ENGRAM_DOXENT_SKILL_URL: 'https://mirror.test/doxent.zip' }), 'https://mirror.test/doxent.zip');
});
