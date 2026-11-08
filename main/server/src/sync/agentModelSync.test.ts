import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 内置 Agent 模型配置同步（sync/agentModelSync.ts）。
 *
 * 锁住四件事：
 *  1) 镜像：本机 dsh 配置 → 偏好 agent_model_config，digest 抑制重复上传；
 *  2) 应用：收到远端偏好后并集合并写回本机两个文件，本机独有内容只回推一次（收敛）；
 *  3) 回声抑制：应用后把合并结果写回偏好并更新 digest，对端再合并就与本地一致；
 *  4) 写失败：payload 暂存 agent_model_sync_pending，下一次重试成功。
 *
 * 测试只操作 os.tmpdir() 下的临时 DSH_HOME，不碰真实用户数据目录。
 */

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-model-sync-'));
process.env.DATA_DIR = temp;

let db: any;
let setSetting: typeof import('../lib/db.js').setSetting;
let getSetting: typeof import('../lib/db.js').getSetting;
let sync: typeof import('./agentModelSync.js');
let preferences: typeof import('./preferences.js');
let agentModelConfig: typeof import('../lib/agentModelConfig.js');
let home = '';

const PATCH = [
  '# dsh profile patch（测试用）',
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      local-only:',
  '        displayName: 本机独有提供商',
  '        apiKeyEnv: LOCAL_ONLY_API_KEY',
  '        baseURL: https://local.example/v1',
  '        models:',
  '        - id: local-model',
  '      dashscope:',
  '        displayName: 阿里云百炼（DashScope）',
  '        apiKeyEnv: DASHSCOPE_API_KEY',
  '        api: openai-completions',
  '        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1',
  '        models:',
  '        - id: qwen3.8-omni-flash',
].join('\n') + '\n';

const CREDENTIALS = [
  'version: 1',
  'records:',
  '  some/record:',
  '    kind: oauth',
  'refs:',
  '  {',
  "    DASHSCOPE_API_KEY: 'sk-local-dashscope',",
  "    LOCAL_ONLY_API_KEY: 'sk-local-only',",
  '  }',
].join('\n') + '\n';

function patchPath(): string {
  return path.join(home, 'profiles', 'web', 'cordis.patch.yml');
}

function credentialsPath(): string {
  return path.join(home, '.credentials.yaml');
}

function seedHome(): void {
  fs.mkdirSync(path.dirname(patchPath()), { recursive: true });
  fs.writeFileSync(patchPath(), PATCH, 'utf8');
  fs.writeFileSync(credentialsPath(), CREDENTIALS, 'utf8');
}

function oplogCount(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM sync_oplog WHERE kind = 'preference' AND target = 'agent_model_config'")
    .get() as { c: number };
  return Number(row.c);
}

function remoteConfigJson(): string {
  const config = agentModelConfig.normalizeAgentModelConfig({
    version: 1,
    official: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: '',
      models: [{ id: 'deepseek-chat', inputModalities: ['text'] }],
    },
    providers: {
      commandcode: {
        displayName: 'CommandCode',
        api: 'openai-completions',
        baseURL: 'https://cc.example/v1',
        apiKeyEnv: 'COMMANDCODE_API_KEY',
        models: [{ id: 'deepseek/chat', name: 'Chat', input: ['text'] }],
      },
      dashscope: {
        displayName: '远端 DashScope',
        api: 'openai-completions',
        baseURL: 'https://dashscope.example/v1',
        apiKeyEnv: 'DASHSCOPE_API_KEY',
        models: [{ id: 'qwen3.8-omni-flash' }],
      },
    },
    default: { provider: 'dashscope', model: 'qwen3.8-omni-flash' },
    keys: { DASHSCOPE_API_KEY: 'sk-remote-dashscope', COMMANDCODE_API_KEY: 'sk-remote-commandcode' },
  });
  assert.ok(config);
  return agentModelConfig.stableStringify(config);
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待超时：' + what);
}

before(async () => {
  const dbModule = await import('../lib/db.js');
  db = dbModule.db;
  setSetting = dbModule.setSetting;
  getSetting = dbModule.getSetting;
  dbModule.migrate();
  const categories = await import('./categories.js');
  categories.saveSyncCategories({ settings: true });
  sync = await import('./agentModelSync.js');
  preferences = await import('./preferences.js');
  agentModelConfig = await import('../lib/agentModelConfig.js');
  const { bundledDshHome } = await import('../assistant/config.js');
  home = bundledDshHome();
  // 与启动时一致：挂合并监听器（覆盖所有 mergePreference 调用点），随后停掉轮询避免测试收尾挂定时器
  sync.initializeAgentModelSync();
  sync.stopAgentModelSync();
});

after(() => {
  sync.stopAgentModelSync();
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
});

test('镜像：本机配置写入偏好 + 入队，digest 不变时不再写', () => {
  seedHome();
  const before = oplogCount();
  const changed = sync.mirrorAgentModelConfig();
  assert.equal(changed, true);
  const preference = preferences.preferenceValue('agent_model_config');
  assert.ok(preference, '镜像后应有偏好值');
  const parsed = agentModelConfig.parseAgentModelConfig(preference!.value);
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed!.providers).sort(), ['dashscope', 'local-only']);
  assert.equal(parsed!.keys.DASHSCOPE_API_KEY, 'sk-local-dashscope');
  assert.ok(getSetting('agent_model_sync_digest'), '应记录 digest');
  assert.equal(oplogCount(), before + 1, '变化时入队一次');

  // digest 没变：再次镜像不写偏好、不入队（否则打开面板会反复 stamp）
  const unchanged = sync.mirrorAgentModelConfig();
  assert.equal(unchanged, false);
  assert.equal(oplogCount(), before + 1);
});

test('镜像：本机新增配置（digest 变化）会再次入队；空配置不上传', () => {
  const before = oplogCount();
  fs.writeFileSync(patchPath(), PATCH + [
    '      another:',
    '        baseURL: https://another.example/v1',
    '        models:',
    '        - id: another-model',
    '',
  ].join('\n'), 'utf8');
  assert.equal(sync.mirrorAgentModelConfig(), true);
  assert.equal(oplogCount(), before + 1);

  // 没有模型配置的空 home：不写偏好（空配置不上传）
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-model-empty-'));
  try {
    assert.equal(sync.mirrorAgentModelConfig(emptyHome), false);
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('应用远端偏好：并集合并写文件、写回合并值、本机独有内容只回推一次', async () => {
  // 上方镜像已把本机配置写进偏好；这里模拟收到远端更新
  const remoteUpdatedAt = Date.now() + 1_000_000;
  const remoteValue = remoteConfigJson();
  const before = oplogCount();
  const merged = preferences.mergePreference('agent_model_config', {
    value: remoteValue,
    updatedAt: remoteUpdatedAt,
    nodeId: 'remote-node',
  });
  assert.equal(merged, true, '远端 updatedAt 更新时应合并成功');

  await waitFor('远端提供商写入本机 dsh patch', () =>
    fs.readFileSync(patchPath(), 'utf8').includes('commandcode:'));
  const patchText = fs.readFileSync(patchPath(), 'utf8');
  // 本机独有内容保留
  assert.ok(patchText.includes('local-only:'));
  assert.ok(patchText.includes('本机独有提供商'));
  // 同 id 远端胜
  assert.ok(patchText.includes('远端 DashScope'));
  assert.ok(patchText.includes('https://dashscope.example/v1'));
  // 官方配置与默认模型落盘
  const credentialsText = fs.readFileSync(credentialsPath(), 'utf8');
  assert.ok(credentialsText.includes("COMMANDCODE_API_KEY: 'sk-remote-commandcode'"));
  assert.ok(credentialsText.includes('records:'), '凭据文件其它段落保留');

  // 合并结果写回偏好 + 更新 meta + digest
  const preference = preferences.preferenceValue('agent_model_config');
  assert.ok(preference);
  const parsed = agentModelConfig.parseAgentModelConfig(preference!.value);
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed!.providers).sort(), ['another', 'commandcode', 'dashscope', 'local-only']);
  assert.equal(parsed!.keys.DASHSCOPE_API_KEY, 'sk-remote-dashscope');
  assert.ok(preference!.updatedAt > remoteUpdatedAt, '本机回推的 updatedAt 要比远端新');
  assert.equal(preference!.nodeId, (await import('./store.js')).currentNodeId());
  const digest = agentModelConfig.agentModelConfigDigest(parsed!);
  assert.equal(getSetting('agent_model_sync_digest'), digest, 'digest 记录合并结果');
  assert.equal(oplogCount(), before + 1, '本机独有内容：收敛时回推一次');

  // 对端收到合并值后再合并：与本地一致，不再回推（回声抑制）
  const convergeAt = preference!.updatedAt + 1000;
  assert.equal(preferences.mergePreference('agent_model_config', {
    value: agentModelConfig.stableStringify(parsed!),
    updatedAt: convergeAt,
    nodeId: 'remote-node',
  }), true);
  await waitFor('合并值应用结束（digest 一致）', () =>
    getSetting('agent_model_sync_digest') === digest);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(oplogCount(), before + 1, '合并结果与远端一致时不再回推');
});

test('写文件失败：payload 暂存 pending，修好后重试成功', async () => {
  // 把 dsh 目录换成普通文件，制造「写不进去」的环境（读也读不到，按空本地配置处理）
  fs.rmSync(home, { recursive: true, force: true });
  fs.writeFileSync(home, 'blocked', 'utf8');
  try {
    const value = remoteConfigJson();
    const remoteUpdatedAt = Date.now() + 2_000_000;
    assert.equal(preferences.mergePreference('agent_model_config', {
      value,
      updatedAt: remoteUpdatedAt,
      nodeId: 'remote-node-2',
    }), true);
    await waitFor('写入失败后暂存 pending', () => Boolean(getSetting('agent_model_sync_pending')));
    const pending = agentModelConfig.parseAgentModelConfig(getSetting('agent_model_sync_pending'));
    assert.ok(pending, 'pending 存的是远端 payload');
    assert.ok(pending!.providers.commandcode, 'pending 内容完整');
  } finally {
    fs.rmSync(home, { force: true });
    fs.mkdirSync(home, { recursive: true });
  }

  await sync.retryPendingAgentModelConfig();
  assert.equal(getSetting('agent_model_sync_pending'), '', '重试成功后清空 pending');
  await waitFor('重试把远端配置写进本机', () =>
    fs.readFileSync(patchPath(), 'utf8').includes('commandcode:'));
  assert.ok(fs.readFileSync(credentialsPath(), 'utf8').includes("COMMANDCODE_API_KEY: 'sk-remote-commandcode'"));
  // 重试成功后偏好里是合并结果（本地为空 → 就是远端那份），digest 同步更新
  const preference = preferences.preferenceValue('agent_model_config');
  assert.ok(preference);
  const parsed = agentModelConfig.parseAgentModelConfig(preference!.value);
  assert.ok(parsed);
  assert.equal(getSetting('agent_model_sync_digest'), agentModelConfig.agentModelConfigDigest(parsed!));
});

test('坏偏好值不抛：mergePreference 拒绝坏结构，应用入口静默跳过', async () => {
  setSetting('agent_model_config', 'not-json');
  setSetting('sync_preference:agent_model_config', JSON.stringify({ updatedAt: Date.now() + 5_000_000, nodeId: 'x' }));
  await sync.onAgentModelPreferenceApplied('agent_model_config', Date.now() + 5_000_000);
  assert.equal(agentModelConfig.parseAgentModelConfig(getSetting('agent_model_config')), null);
  // 其它 key 完全不受影响
  await sync.onAgentModelPreferenceApplied('theme', Date.now());
});
