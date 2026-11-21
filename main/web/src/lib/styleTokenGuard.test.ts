import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * UI 令牌守卫（2026-11 美化收口轮）：锁住「还完的债不再涨」。
 *
 * 2026-11 还债轮把组件 <style> 里的字号/颜色向全局令牌收敛（阶梯见 main.css 的 --fs-*，
 * 色板见 claude-code.css 的 --cc-*）。本文件对每个 .vue 组件统计 <style> 区的
 * 「font-size 字面值」与「#hex 字面值」，不得超过基线。要写新字面值时：
 *  1. 优先用令牌——99% 的情况都该这样；
 *  2. 确有必要的（第三方覆写、装饰性特例）把本文件基线表对应条目 +1，
 *     并在末尾 ALLOWED_NOTES 里登记原因，评审时可见。
 *
 * 统计口径：
 *  - 只统计 .vue 的 <style> 块（含 scoped）；<script> 里的 JS 用色（画布色板等）不在其列；
 *  - font-size：/font-size:\s*\d+(\.\d+)?px/，令牌写法 var(--fs-*) / var(--font-*) 不命中；
 *  - hex：/#[0-9a-fA-F]{3,8}\b/；data:URI 里 URL 编码的 %23 不会命中。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');

/** [文件, font-size 字面值上限, hex 字面值上限]（相对 src/ 的路径）
 * 基线 = 2026-11 还债轮完成后的存量（69 文件 · font-size 368 · hex 117）。
 * MobileInbox 的 54 个 hex 是封面艺术系统 cov-* 类型渐变（非主题语义，见该文件注释）。 */
const BASELINE: ReadonlyArray<readonly [string, number, number]> = [
  ['components/agentConsole/AdvancedPanel.vue', 2, 0],
  ['components/agentConsole/ConsoleField.vue', 1, 0],
  ['components/agentConsole/ModelsPanel.vue', 7, 0],
  ['components/agentConsole/PluginsPanel.vue', 7, 0],
  ['components/agentConsole/PresetsPanel.vue', 4, 0],
  ['components/AppContextMenu.vue', 3, 0],
  ['components/AssetDrawer.vue', 8, 2],
  ['components/BackTrailMenu.vue', 2, 0],
  ['components/BeautifyTaskPill.vue', 1, 0],
  ['components/ChatDrawer.vue', 0, 3],
  ['components/DocumentTitle.vue', 4, 0],
  ['components/EditorAiDialog.vue', 4, 1],
  ['components/EditorTableBar.vue', 3, 1],
  ['components/FilePreview.vue', 3, 0],
  ['components/FileRow.vue', 4, 1],
  ['components/HomeAdaptiveSummary.vue', 39, 6],
  ['components/HomeBoard.vue', 7, 0],
  ['components/HomeBoardModules/HomeActionComposer.vue', 18, 0],
  ['components/HomeBoardModules/HomeBoardSnapshot.vue', 5, 0],
  ['components/HomeBoardModules/HomeDigest.vue', 3, 0],
  ['components/HomeBoardModules/HomeHeat.vue', 19, 0],
  ['components/HomeBoardModules/HomeInbox.vue', 6, 0],
  ['components/HomeBoardModules/HomeRing.vue', 5, 0],
  ['components/HomeBoardModules/HomeRoam.vue', 6, 0],
  ['components/HomeBoardModules/HomeShortcuts.vue', 1, 1],
  ['components/HomeBoardModules/HomeStats.vue', 5, 0],
  ['components/HomeBoardModules/HomeSystem.vue', 4, 0],
  ['components/HomeBoardModules/HomeTags.vue', 3, 0],
  ['components/HomeBoardModules/HomeTasks.vue', 2, 0],
  ['components/HomeBoardModules/HomeWeekly.vue', 5, 0],
  ['components/HomeModuleShell.vue', 14, 0],
  ['components/InboxFilePicker.vue', 1, 7],
  ['components/MarkdownEditor.vue', 8, 4],
  ['components/MobileInbox.vue', 1, 54],
  ['components/PageOutline.vue', 9, 0],
  ['components/PageRow.vue', 2, 1],
  ['components/PdfViewer.vue', 2, 2],
  ['components/ReadingPreview.vue', 8, 1],
  ['components/RelatedMenu.vue', 1, 0],
  ['components/settings/AgentCliSection.vue', 3, 0],
  ['components/settings/AndroidUpdatePanel.vue', 0, 1],
  ['components/settings/BoardSection.vue', 1, 0],
  ['components/settings/DreamSection.vue', 7, 2],
  ['components/settings/StoragePanel.vue', 2, 0],
  ['components/settings/SyncPanel.vue', 3, 0],
  ['components/settings/UpdatePanel.vue', 0, 2],
  ['components/Sidebar.vue', 8, 0],
  ['components/SyncButton.vue', 1, 0],
  ['components/SyncChannelPopover.vue', 6, 0],
  ['components/SyncLogDrawer.vue', 0, 12],
  ['components/taskBoard/TaskBoardPanels.vue', 3, 0],
  ['components/taskBoard/TaskCardItem.vue', 2, 0],
  ['components/taskBoard/TaskMonthBoard.vue', 7, 0],
  ['components/taskBoard/TaskOverdueBar.vue', 2, 0],
  ['components/taskBoard/TaskWeekBoard.vue', 2, 0],
  ['components/ui/AppModal.vue', 1, 0],
  ['components/ui/QrCode.vue', 0, 2],
  ['components/ui/QrScannerOverlay.vue', 1, 2],
  ['components/UpdateNotice.vue', 3, 2],
  ['components/UpdateOverlay.vue', 1, 0],
  ['views/AgentConsoleView.vue', 3, 0],
  ['views/AgentView.vue', 1, 0],
  ['views/CustomerResearchView.vue', 45, 0],
  ['views/EditorView.vue', 11, 0],
  ['views/GraphView.vue', 8, 1],
  ['views/Home.vue', 9, 0],
  ['views/InboxView.vue', 6, 9],
  ['views/SearchView.vue', 2, 0],
  ['views/TasksView.vue', 3, 0],
];

/** 基线外仍保留的字面值及原因（评审提示，不参与断言） */
const ALLOWED_NOTES: ReadonlyArray<readonly [string, string]> = [
  ['views/GraphView.vue', 'TYPE_COLOR 分组色板是功能性数据色（JS 常量，不进 <style>），有注释约定'],
  ['styles/claude-code.css', '全站令牌定义文件本体（--cc-*），hex 是唯一定义源'],
  ['styles/main.css', '语义令牌定义文件本体，hex 是唯一定义源'],
];

function walkVueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      out.push(...walkVueFiles(p));
    } else if (name.endsWith('.vue')) {
      out.push(p);
    }
  }
  return out;
}

function styleBlocks(source: string): string {
  return (source.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');
}

test('组件 <style> 的字号/颜色字面值不超过还债基线', () => {
  const baseline = new Map(BASELINE.map(([file, fsMax, hexMax]) => [file, { fsMax, hexMax }]));
  const offenders: string[] = [];

  for (const abs of walkVueFiles(srcRoot)) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const limits = baseline.get(rel);
    if (!limits) {
      // 新组件默认零基线：出现任何字面值都算超（新组件应该一开始就用令牌）
      const css = styleBlocks(fs.readFileSync(abs, 'utf8'));
      const fsCount = (css.match(/font-size:\s*\d+(\.\d+)?px/g) || []).length;
      const hexCount = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
      if (fsCount || hexCount) offenders.push(`${rel}: 无基线却有字面值（font-size ${fsCount} / hex ${hexCount}）——用令牌或登记基线`);
      continue;
    }
    const css = styleBlocks(fs.readFileSync(abs, 'utf8'));
    const fsCount = (css.match(/font-size:\s*\d+(\.\d+)?px/g) || []).length;
    const hexCount = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
    if (fsCount > limits.fsMax || hexCount > limits.hexMax) {
      offenders.push(`${rel}: font-size ${fsCount}/${limits.fsMax} · hex ${hexCount}/${limits.hexMax}`);
    }
  }

  const message = [
    'UI 令牌守卫发现硬编码回潮（2026-11 还债基线被突破）：',
    ...offenders,
    '处理：改用令牌（--fs-* / --cc-* / 语义令牌）；确需保留的把 styleTokenGuard 基线 +1 并登记 ALLOWED_NOTES。',
  ].join('\n');
  assert.deepEqual(offenders, [], message);
});
