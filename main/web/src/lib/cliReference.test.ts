import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_COMMANDS,
  CLI_GROUPS,
  formatCliCommand,
  groupedCliCommands,
} from './cliReference.ts';

/**
 * 「工具与手册」的命令参考表与设置页接入区的契约守卫。
 *
 * MCP 已整体下线：Web 侧不再有 MCP 配置片段、MCP 地址、MCP 工具清单，
 * 客户端接入改为一键写入 skill + CLI 包装脚本。这里锁三件事：
 *  1. CLI_COMMANDS 覆盖 docs/AGENT-CLI-SKILL.md 第 3 节的全部命令，分组合法、无重复；
 *  2. AgentPanel / AgentCliSection 引用的是新数据源与新端点（mcpTools / MCP 配置不得回潮）；
 *  3. 旧组件（AgentMcpSection / AgentHarnessSection）已删除，不再有 MCP 专用端点引用。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '..');
const settingsDir = path.join(webSrc, 'components', 'settings');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(webSrc, rel), 'utf8');
}

/** 契约第 3 节的命令面：命令前缀（含子命令），新增 / 改名时两处同步 */
const CONTRACT_COMMANDS = [
  'login',
  'status',
  'config show',
  'guide',
  'skill list',
  'skill show',
  'search',
  'pages list',
  'pages read',
  'pages related',
  'pages evidence',
  'pages write',
  'pages rename',
  'pages move',
  'pages delete',
  'pages asset',
  'files list',
  'files read',
  'files raw',
  'files add',
  'inbox list',
  'inbox read',
  'inbox raw',
  'inbox add',
  'inbox write',
  'inbox convert',
  'chat save',
  'names check',
  'names propose',
  'names list',
  'names audit',
  'names answer',
  'research begin',
  'research submit',
  'ask',
];

test('CLI 命令表覆盖契约第 3 节全部命令', () => {
  const commands = CLI_COMMANDS.map((item) => item.command);
  for (const expected of CONTRACT_COMMANDS) {
    assert.ok(
      commands.some((command) => command === expected || command.startsWith(expected + ' ')),
      `命令表缺 ${expected}：设置页会少一条 Agent 实际可用的命令`,
    );
  }
  // 删除项不得回潮：mcp-config 是旧 MCP 时代的子命令
  assert.ok(!commands.some((command) => command.startsWith('mcp-config')), 'mcp-config 已删除，命令表不应再列');
});

test('命令表分组合法、无重复、顺序与分组登记一致', () => {
  const groups = new Set(CLI_GROUPS.map((item) => item.group));
  const seen = new Set<string>();
  for (const item of CLI_COMMANDS) {
    assert.ok(groups.has(item.group), `${item.command} 的分组 ${item.group} 不在 CLI_GROUPS 里`);
    assert.ok(item.summary.trim().length > 0, `${item.command} 缺一句话功能`);
    assert.ok(item.notes.trim().length > 0, `${item.command} 缺使用要点`);
    assert.ok(!seen.has(item.command), `命令重复登记：${item.command}`);
    seen.add(item.command);
  }
  // 三组都必须有内容（否则页面上会渲染出空分组）
  const grouped = groupedCliCommands();
  assert.equal(grouped.length, CLI_GROUPS.length);
  for (const group of grouped) assert.ok(group.items.length > 0, `分组「${group.label}」没有命令`);
});

test('命令带 engram 前缀展示，全局选项与退出码有单独说明', () => {
  assert.equal(formatCliCommand('status'), 'engram status');
  assert.equal(formatCliCommand('pages read <ref>'), 'engram pages read <ref>');
  assert.ok(readSrc('lib/cliReference.ts').includes('--json'), '全局选项说明缺 --json');
});

test('AgentPanel 用 cliReference 渲染命令表，且不再出现 MCP 工具清单', () => {
  const panel = readSrc('components/settings/AgentPanel.vue');
  assert.ok(panel.includes("from '../../lib/cliReference'"), 'AgentPanel 没有改用 lib/cliReference');
  assert.doesNotMatch(panel, /mcpTools|MCP_TOOLS|McpToolDoc/, 'AgentPanel 仍在引用 MCP 工具清单');
  assert.doesNotMatch(panel, /mcp__engram__/, 'AgentPanel 仍在展示 MCP 工具名');
  assert.doesNotMatch(panel, /<code>mcp-config<\/code>/, 'AgentPanel 仍把 mcp-config 当可用命令');
  assert.match(panel, /AgentCliSection/, 'AgentPanel 没有挂新的 AgentCliSection');
  assert.match(panel, /查看命令参考|命令参考/, 'AgentPanel 缺少命令参考入口（原「查看工具」）');
  assert.doesNotMatch(panel, /查看工具/, 'AgentPanel 仍留着 MCP 时代的「查看工具」文案');
});

test('AgentCliSection 只调契约里的新端点（接入 / 令牌 / CLI 下载），不出现 MCP 地址与片段', () => {
  const section = readSrc('components/settings/AgentCliSection.vue');
  for (const endpoint of [
    '/api/settings/agent-access',
    '/api/settings/agent-access/register',
    '/api/settings/agent-access/unregister',
    '/api/settings/agent-tokens',
    '/api/settings/agent-cli-source',
  ]) {
    assert.ok(section.includes(endpoint), `AgentCliSection 缺端点 ${endpoint}`);
  }
  assert.doesNotMatch(section, /\/mcp\b/, 'AgentCliSection 仍在展示 /mcp 地址');
  assert.doesNotMatch(section, /mcpServers|mcp_servers|mcp-tokens|mcp__engram__/, 'AgentCliSection 仍在写 MCP 配置 / MCP 令牌端点');
  assert.doesNotMatch(section, /Kimi Work|kimiwork/, 'Kimi Work 入口已下线（无 shell，不能跑 CLI）');
  // 远程接入必须给出 login 用法与 CLI 下载
  assert.match(section, /login --url/, 'AgentCliSection 缺少 engram login 说明');
});

test('旧 MCP 接入组件已删除', () => {
  for (const file of ['AgentMcpSection.vue', 'AgentHarnessSection.vue']) {
    assert.ok(!fs.existsSync(path.join(settingsDir, file)), `${file} 应已删除（MCP 接入不再保留）`);
  }
  assert.ok(fs.existsSync(path.join(settingsDir, 'AgentCliSection.vue')), '缺 AgentCliSection.vue');
});

test('Web 源码里不再有 mcpTools / MCP 工具清单的数据源文件', () => {
  assert.ok(!fs.existsSync(path.join(webSrc, 'lib', 'mcpTools.ts')), 'lib/mcpTools.ts 应已改名为 cliReference.ts');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(vue|ts)$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/mcpTools|MCP_TOOLS/.test(text)) offenders.push(path.relative(webSrc, full));
    }
  };
  walk(webSrc);
  assert.deepEqual(offenders, [], '仍有文件引用 mcpTools / MCP_TOOLS：' + offenders.join(', '));
});
