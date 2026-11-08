import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  CHAT_PATCH_FILE,
  HOME_PATCH_FILE,
  LEGACY_AGENT_PATCH_FILE,
  agentPatchEntryIds,
  chatPatchPath,
  chatPatchText,
  cleanupLegacyMcpPatches,
  writeChatPatch,
} = await import('./agentPatch.js');
const {
  LEGACY_SETTINGS_HEADER,
  agentSettingsPath,
  profilePatchPath,
} = await import('./agentSettings.js');

const homes: string[] = [];
after(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-patch-'));
  homes.push(home);
  return home;
}

/** 旧版本写在 home 层的 MCP 条目（形状照抄 dshConfig.engramPatchBlock） */
const LEGACY_HOME_BLOCK = [
  '# Engram 知识库 MCP（由 Engram 设置页「Agent 接入」维护，重新注册会整块替换）。',
  '# Engram 未启动时 DSH 照常启动，只是 mcp__engram__* 工具缺席。',
  '- insert:',
  '    - id: mcp-engram',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: engram',
  '        transport: streamable-http',
  '        url: http://127.0.0.1:18080/mcp',
  '        headers:',
  "          Authorization: 'Bearer tok'",
].join('\n');

test('chatPatchText：在 web profile 上叠 sdk stdio 应用、关掉 Web UI，并启用聊天会话的 host 工具', () => {
  const text = chatPatchText();
  const ids = agentPatchEntryIds(text);
  assert.deepEqual(ids, [
    'sdk-app-startup',
    'sdk-jsonrpc-server',
    'webserver',
    'web-runtime',
    'hmr',
    'session-title-llm',
    'tool-bash',
    'tool-pwsh',
    'tool-jobs',
    'tool-fs',
    'tool-fs-search',
    'tool-todo',
    'skill-filesystem',
    'tool-skill',
    'tool-web',
    'tool-result-pruner',
    'compaction-basic',
  ]);
  assert.match(text, /profile: web/);
  assert.match(text, /- id: webserver\n {2}disabled: true/);
  assert.match(text, /- id: web-runtime\n {2}disabled: true/);
  assert.match(text, /- id: session-title-llm\n {2}disabled: true/);
  // 知识库改走 CLI，聊天覆盖层不再写 MCP 条目
  assert.equal(text.includes('mcp-engram'), false);
  assert.equal(text.includes('dsh-mcp-client'), false);
  // 聊天会话由 SDK 创建、不挂 web 层的 agent preset：命令 / 文件 / skill / 联网 / 压缩
  // 必须在 host 层启用，否则 `engram` CLI 与 skill 都没有入口（v1.5.10 的聊天抽屉正是缺这一层）
  assert.match(text, /- id: tool-pwsh\n {2}disabled: !!js process\.platform !== 'win32'/);
  assert.match(text, /- id: tool-bash\n {2}disabled: !!js process\.platform === 'win32'/);
  for (const id of [
    'tool-jobs',
    'tool-fs',
    'tool-fs-search',
    'tool-todo',
    'skill-filesystem',
    'tool-skill',
    'tool-web',
    'tool-result-pruner',
    'compaction-basic',
  ]) {
    assert.match(text, new RegExp(`- id: ${id}\\n {2}disabled: false`));
  }
  assert.equal(text.endsWith('\n'), true);
});

test('writeChatPatch：写到 DSH_HOME 根目录，内容幂等', () => {
  const home = tempHome();
  const file = writeChatPatch(home);
  assert.equal(file, chatPatchPath(home));
  assert.equal(path.basename(file), CHAT_PATCH_FILE);
  const first = fs.readFileSync(file, 'utf8');
  writeChatPatch(home);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

test('writeChatPatch：顺带清理遗留 settings.yaml 与 profile patch 里的旧模型路由', () => {
  const home = tempHome();
  fs.writeFileSync(agentSettingsPath(home), LEGACY_SETTINGS_HEADER + '\nagent-default-model:\n  provider: old\n', 'utf8');
  const profilePatch = profilePatchPath(home);
  fs.mkdirSync(path.dirname(profilePatch), { recursive: true });
  fs.writeFileSync(profilePatch, '- id: agent-default-model\n  config:\n    provider: old\n- id: keep\n', 'utf8');

  writeChatPatch(home);
  assert.equal(fs.existsSync(agentSettingsPath(home)), false);
  const after = fs.readFileSync(profilePatch, 'utf8');
  assert.equal(after.includes('agent-default-model'), false);
  assert.equal(after.includes('- id: keep'), true);
});

test('cleanupLegacyMcpPatches：删掉旧版本的 MCP 覆盖层文件', () => {
  const home = tempHome();
  const legacy = path.join(home, LEGACY_AGENT_PATCH_FILE);
  fs.writeFileSync(legacy, '- insert:\n    - id: mcp-engram\n', 'utf8');
  assert.deepEqual(cleanupLegacyMcpPatches(home), { removedAgentPatch: true, cleanedHomePatch: false });
  assert.equal(fs.existsSync(legacy), false);
  // 幂等：再跑一次什么都不做
  assert.deepEqual(cleanupLegacyMcpPatches(home), { removedAgentPatch: false, cleanedHomePatch: false });
});

test('cleanupLegacyMcpPatches：只删 home patch 里的 mcp-engram 方块，用户的手写条目与注释保留', () => {
  const home = tempHome();
  const patch = path.join(home, HOME_PATCH_FILE);
  fs.writeFileSync(
    patch,
    [
      '# Machine-local DSH user patch layer.',
      '- id: user-own-plugin',
      '  config:',
      '    keep: true',
      '',
      LEGACY_HOME_BLOCK,
      '',
      '- id: another-user-entry',
    ].join('\n'),
    'utf8',
  );

  assert.deepEqual(cleanupLegacyMcpPatches(home), { removedAgentPatch: false, cleanedHomePatch: true });
  const text = fs.readFileSync(patch, 'utf8');
  assert.equal(text.includes('mcp-engram'), false);
  assert.equal(text.includes('dsh-mcp-client'), false);
  assert.equal(text.includes('Bearer tok'), false);
  assert.match(text, /- id: user-own-plugin/);
  assert.match(text, /- id: another-user-entry/);
  assert.match(text, /# Machine-local DSH user patch layer\./);
});

test('cleanupLegacyMcpPatches：删完只剩文件头注释时整个文件删掉', () => {
  const home = tempHome();
  const patch = path.join(home, HOME_PATCH_FILE);
  fs.writeFileSync(patch, ['# Engram 写过的文件头', '', LEGACY_HOME_BLOCK].join('\n'), 'utf8');
  assert.deepEqual(cleanupLegacyMcpPatches(home), { removedAgentPatch: false, cleanedHomePatch: true });
  assert.equal(fs.existsSync(patch), false);
});
