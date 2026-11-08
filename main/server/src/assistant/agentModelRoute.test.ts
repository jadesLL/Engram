import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  agentModelRouteCacheKey,
  parseAgentModelRoute,
  readAgentModelRoute,
  resetAgentModelRouteCache,
  resolveAgentModelRoute,
} from './agentModelRoute.js';

/**
 * 聊天运行时的模型路由。
 *
 * 为什么钉这么细：dsh 的 SDK 会话不读控制台默认模型，不显式把 `agent-default-model` 交给它，
 * 就会兜底成模型目录外的 `deepseek-v4-flash`（纯文本，图片进不了上下文）。这里按
 * `dsh --dump-config` 的真实输出形状（分节注释 + 多层 patch）钉住解析与回退。
 */

/** 真实 dump 的骨架：bundle 层给出 dsh 默认值，config 字段缩进固定 */
const BASE_DUMP = `# == @deepseek-ai/dsh-base
- id: agent
  name: '@deepseek-ai/dsh-agent'
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
# == @deepseek-ai/dsh-base
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
`;

/** 用户在控制台保存默认模型后，profile patch 作为后面的层覆盖前面的层 */
const OVERRIDE_LAYER = `# == @deepseek-ai/dsh-base, patched by /data/dsh/profiles/web/cordis.patch.yml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: dashscope
    model: qwen3.8-omni-flash
`;

test('解析：bundle 默认值（没在控制台保存过时取 dsh 自带默认）', () => {
  assert.deepEqual(parseAgentModelRoute(BASE_DUMP), { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('解析：后面的层覆盖前面的层（控制台保存的默认模型优先）', () => {
  assert.deepEqual(parseAgentModelRoute(BASE_DUMP + OVERRIDE_LAYER), {
    provider: 'dashscope',
    model: 'qwen3.8-omni-flash',
  });
});

test('解析：覆盖层只写了 model 时，provider 沿用前面那层的值（防御脏 patch）', () => {
  const partial = `# == patched
- id: agent-default-model
  config:
    model: deepseek-v4-pro
`;
  assert.deepEqual(parseAgentModelRoute(BASE_DUMP + partial), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
});

test('解析：容忍引号值与 CRLF（Windows 上写出的 patch）', () => {
  const quoted = [
    '# == base',
    "- id: 'agent-default-model'",
    '  config:',
    '    provider: "deepseek-official"',
    "    model: 'deepseek-flash'",
  ].join('\r\n');
  assert.deepEqual(parseAgentModelRoute(quoted), { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('解析：嵌套结构里的同名字段不冒到路由上', () => {
  const nested = `# == base
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    models:
      - id: deepseek-v4-pro
        name: DeepSeek-V4-Pro
`;
  assert.deepEqual(parseAgentModelRoute(nested), { provider: 'deepseek-official', model: 'deepseek-flash' });
});

test('解析：只认顶层条目（insert 块里的同名条目不算）', () => {
  const inserted = `# == base
- insert:
    - id: agent-default-model
      config:
        provider: someone
        model: whatever
`;
  assert.equal(parseAgentModelRoute(inserted), undefined);
});

test('解析：没有这个条目 / 缺 provider / 缺 model 都返回 undefined（调用方回退 SDK 默认路由）', () => {
  assert.equal(parseAgentModelRoute('# == base\n- id: agent\n  name: x\n'), undefined);
  assert.equal(parseAgentModelRoute(''), undefined);
  assert.equal(parseAgentModelRoute('# == base\n- id: agent-default-model\n  config:\n    model: deepseek-flash\n'), undefined);
  assert.equal(parseAgentModelRoute('# == base\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n'), undefined);
  assert.equal(parseAgentModelRoute('# == base\n- id: agent-default-model\n  name: x\n'), undefined);
});

test('readAgentModelRoute：dump 起不来时返回 undefined，绝不抛（聊天必须照常可用）', () => {
  resetAgentModelRouteCache();
  const missing = path.join(os.tmpdir(), 'engram-no-such-node-' + process.pid);
  const route = readAgentModelRoute({ node: missing, dshBin: 'x.js', home: os.tmpdir(), timeoutMs: 3000 });
  assert.equal(route, undefined);
});

test('缓存键：随 profile patch 内容变化（控制台改了默认模型必须重读）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-route-'));
  try {
    const profile = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profile, { recursive: true });
    const patch = path.join(profile, 'cordis.patch.yml');
    fs.writeFileSync(patch, '[]\n', 'utf8');
    const options = { node: '/usr/bin/node', dshBin: '/app/dsh/bin.js', home, version: '0.2.1-rc.2' };
    const before = agentModelRouteCacheKey(options);
    fs.writeFileSync(patch, '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n', 'utf8');
    const after = agentModelRouteCacheKey(options);
    assert.notEqual(before, after);
    assert.equal(after, agentModelRouteCacheKey({ ...options }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveAgentModelRoute：失败结果也缓存（同一个配置状态不反复起子进程）', () => {
  resetAgentModelRouteCache();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-route-'));
  try {
    const options = { node: path.join(os.tmpdir(), 'engram-no-such-node-' + process.pid), dshBin: 'x.js', home, timeoutMs: 3000 };
    assert.equal(resolveAgentModelRoute(options), undefined);
    assert.equal(resolveAgentModelRoute(options), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    resetAgentModelRouteCache();
  }
});
