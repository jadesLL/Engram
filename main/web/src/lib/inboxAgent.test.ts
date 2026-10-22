import test from 'node:test';
import assert from 'node:assert/strict';
// 测试由 node 内置类型擦除直接跑（web 包无额外测试框架），相对导入要带真实扩展名
import {
  AGENT_ACTION_TIP,
  AGENT_MENU_LABEL,
  AGENT_PRIMARY_LABEL,
  canConvertItem,
  inboxPrimaryKind,
  inboxPrimaryLabel,
  inboxRetryLabel,
  isServerConvertible,
  type InboxPrimaryKind,
} from './inboxAgent.ts';
import type { InboxItem } from '../stores/inbox';

type Subject = Pick<InboxItem, 'status' | 'capability'>;

function item(status: InboxItem['status'], capability: InboxItem['capability']): Subject {
  return { status, capability };
}

test('待整理：可转格式给「转换」，agent-only 给「让 Agent 处理」，unsupported 主操作留空', () => {
  // video（B站/抖音链接占位稿与本地音视频）也走服务端转换，主操作同样是「转换」
  for (const capability of ['office', 'pdf', 'text', 'video'] as const) {
    assert.equal(inboxPrimaryKind(item('pending', capability), false), 'convert');
  }
  assert.equal(inboxPrimaryKind(item('pending', 'agent-only'), false), 'agent');
  assert.equal(inboxPrimaryKind(item('pending', 'unsupported'), false), 'none');
});

test('失败条目主操作保持「重新转换」，Agent 入口只在菜单里（不进主操作）', () => {
  assert.equal(inboxPrimaryKind(item('failed', 'office'), false), 'retry');
  assert.equal(inboxPrimaryKind(item('failed', 'text'), false), 'retry');
});

test('转换中看过程；已转换按是否入库切换「入库 / 查看产物」', () => {
  assert.equal(inboxPrimaryKind(item('converting', 'office'), false), 'process');
  assert.equal(inboxPrimaryKind(item('converted', 'office'), false), 'adopt');
  assert.equal(inboxPrimaryKind(item('converted', 'office'), true), 'review');
  // Agent 把图片 / 音视频转出产物后，和普通转换产物一样可以入库
  assert.equal(inboxPrimaryKind(item('converted', 'agent-only'), false), 'adopt');
});

test('Agent 入口文案与提示固定，避免入口被改得读不懂', () => {
  assert.equal(AGENT_MENU_LABEL, '让 Agent 总结并转换');
  assert.equal(AGENT_PRIMARY_LABEL, '让 Agent 处理');
  assert.match(AGENT_ACTION_TIP, /收集箱/);
});

test('isServerConvertible 与服务端四种可转能力对齐（video 走视频理解管线）', () => {
  assert.deepEqual(
    (['office', 'pdf', 'text', 'video'] as const).filter(isServerConvertible),
    ['office', 'pdf', 'text', 'video'],
  );
  assert.equal(isServerConvertible('agent-only'), false);
  assert.equal(isServerConvertible('unsupported'), false);
  assert.equal(isServerConvertible(''), false);
});

test('主操作文案：视频条目是「提炼视频 / 重新提炼」，其他格式维持「转为 Markdown / 重新转换」', () => {
  // 视频走视频理解模型，说「提炼视频」比「转为 Markdown」更准确
  assert.equal(inboxPrimaryLabel('video'), '提炼视频');
  assert.equal(inboxRetryLabel('video'), '重新提炼');
  // 其余能力（含不可转的）文案保持原样
  for (const capability of ['office', 'pdf', 'text', 'agent-only', 'unsupported', '']) {
    assert.equal(inboxPrimaryLabel(capability), '转为 Markdown');
    assert.equal(inboxRetryLabel(capability), '重新转换');
  }
});

test('canConvertItem：只有服务端可转且不在转换中才可点，失败可重试', () => {
  assert.equal(canConvertItem(item('pending', 'text')), true);
  assert.equal(canConvertItem(item('failed', 'pdf')), true);
  assert.equal(canConvertItem(item('pending', 'video')), true);
  assert.equal(canConvertItem(item('failed', 'video')), true);
  assert.equal(canConvertItem(item('converting', 'office')), false);
  assert.equal(canConvertItem(item('pending', 'agent-only')), false);
  assert.equal(canConvertItem(item('pending', 'unsupported')), false);
});

test('主操作判定覆盖所有状态 × 能力组合（不出现漏配的空档）', () => {
  const statuses: InboxItem['status'][] = ['pending', 'converting', 'converted', 'failed'];
  const capabilities: InboxItem['capability'][] = ['office', 'pdf', 'text', 'video', 'agent-only', 'unsupported'];
  const allowed: readonly InboxPrimaryKind[] = ['convert', 'process', 'retry', 'adopt', 'review', 'agent', 'none'];
  const seen = new Set<InboxPrimaryKind>();
  for (const status of statuses) {
    for (const capability of capabilities) {
      for (const adopted of [false, true]) {
        const kind = inboxPrimaryKind(item(status, capability), adopted);
        assert.ok(allowed.includes(kind), `${status}/${capability}/${adopted} 得到未知主操作 ${kind}`);
        seen.add(kind);
      }
    }
  }
  // 七种主操作都可达：none 用于待整理的 unsupported，agent 用于待整理的 agent-only
  assert.equal(seen.size, allowed.length);
});
