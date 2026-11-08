import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 「视频理解模型」面板 Key 来源护栏（2026-11 模型配置多端同步）。
 *
 * 服务端 status 新增 keySource: 'local' | 'synced' | 'none'：面板只按它显示「Key 从哪来的」，
 * 任何分支都不渲染 Key 本身（接口也不回显明文）。这里沿用本目录其它护栏测试的做法——
 * 读源码 + 正则锁关键声明，不把 Vue SFC 渲染起来（web 包没有 jsdom 渲染链路）：
 *  ① 三个来源分支都有中文文案（synced 必须点明「本机未配置」）；
 *  ② 旧服务端没有 keySource 时按 hasKey 降级，不报错；
 *  ③ 状态里没有 apiKey 字段、面板也不读它（明文永不进页面）；
 *  ④ 读取完成前不显示来源，未配置时「去控制台配置」入口仍在。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const panelPath = path.resolve(here, '..', 'components', 'settings', 'VideoPanel.vue');
const modelsPanelPath = path.resolve(here, '..', 'components', 'agentConsole', 'ModelsPanel.vue');
const panel = fs.readFileSync(panelPath, 'utf8');

test('Key 来源三分支：local / synced / none 都有明确文案', () => {
  // 契约（docs/AGENT-MODEL-SYNC.md）：keySource 只能是这三种，且必须是可选字段
  assert.match(panel, /type VideoKeySource = 'local' \| 'synced' \| 'none'/, '缺少 keySource 的三态类型');
  assert.match(panel, /keySource\?: VideoKeySource/, 'keySource 必须是可选字段：旧服务端没有它时不能报错');
  // 本机已配置
  assert.match(
    panel,
    /return hub \? '中枢控制台已配置' : '本机控制台已配置'/,
    '缺「本机控制台已配置」文案',
  );
  // 来自同步：必须点明本机未配置，否则用户会以为本机也存着这份 Key
  assert.match(panel, /'来自多端同步（本机未配置）'/, '缺「来自多端同步（本机未配置）」文案');
  // 未配置
  assert.match(panel, /return '未配置';/, '缺「未配置」文案');
  // 手机不持有模型 Key：同一分支换成「中枢」口径（面板显示的是中枢那份状态）
  assert.match(panel, /'来自多端同步（中枢本机未配置）'/, '手机上要按中枢口径说明 Key 来源');
  // 读取完成前不显示来源（避免把「还没读到」说成「未配置」）
  assert.match(panel, /if \(!loaded\.value\) return '';/, '读取完成前就显示了 Key 来源');
});

test('旧服务端降级：没有 keySource 时按 hasKey 推本机口径，不报错', () => {
  assert.match(
    panel,
    /function normalizeKeySource\(raw: Partial<VideoStatus> \| undefined\): VideoKeySource/,
    '缺少 keySource 归一化函数',
  );
  assert.match(
    panel,
    /return raw\?\.hasKey === true \? 'local' : 'none'/,
    '旧服务端必须降级成 local / none，不能抛错或留空',
  );
  assert.match(panel, /keySource: normalizeKeySource\(raw\)/, 'normalizeStatus 没有用降级结果');
});

test('永不在页面显示 Key 明文：状态里没有 apiKey 字段，也不读它', () => {
  assert.doesNotMatch(panel, /apiKey\s*[:=]/, '面板里出现了 apiKey 字段或赋值：明文 Key 不能进前端状态');
  assert.doesNotMatch(
    panel,
    /status\.value\.apiKey|status\?\.apiKey|raw\.apiKey/,
    '面板读了 apiKey：明文 Key 会被渲染出来',
  );
  // 来源行只渲染来源文案（不拼 hasKey 等原始值）
  const row = panel.match(/<div v-if="keySourceLabel"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(row, '找不到 Key 来源行（keySourceLabel 没有渲染出来）');
  assert.doesNotMatch(row, /\{\{\s*(?:status\.value\.)?hasKey\s*\}\}/, '来源行渲染了 hasKey 原始值');
});

test('未配置时仍给「去控制台配置」入口（入口没了就没法补 Key）', () => {
  assert.match(panel, /去控制台配置模型与 API Key/, '缺少「去控制台配置模型与 API Key」按钮');
  assert.match(
    panel,
    /function openConsole\(\): void \{[\s\S]{0,160}?router\.push\('\/settings\/agent-console'\)/,
    '入口没有跳到内置 Agent 控制台的模型页',
  );
});

test('控制台模型页写明模型配置随「设置」分类多端同步、本机 Key 优先', () => {
  const models = fs.readFileSync(modelsPanelPath, 'utf8');
  assert.match(
    models,
    /模型配置与相关 API Key 随多端同步的「设置」分类下发到群组内其他设备/,
    '控制台模型页缺少多端同步说明：用户不知道配置会下发给群组内其他设备',
  );
  assert.match(models, /本机已配置的 Key 优先/, '模型页要说明本机 Key 优先，否则用户以为同步会盖掉本机配置');
});
