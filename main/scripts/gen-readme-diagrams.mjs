#!/usr/bin/env node
/**
 * 生成 README.md 使用的三组亮/暗双主题架构与流程 SVG 配图。
 * 配色严格对齐 main/web/src/styles/claude-code.css 令牌。
 * 运行：node main/scripts/gen-readme-diagrams.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../docs/readme');

const FONT_SANS =
  'Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, PingFang SC, Microsoft YaHei, sans-serif';
const FONT_MONO =
  'SFMono-Regular, JetBrains Mono, Cascadia Mono, Menlo, Consolas, Microsoft YaHei, monospace';

const THEMES = {
  light: {
    canvas: '#F7F5EF',
    pane: '#FBFAF6',
    card: '#FFFDF8',
    track: '#ECE7D9',
    border: '#E3DFD2',
    borderStrong: '#D2CCBA',
    ink: '#1F1E1B',
    ink2: '#565247',
    ink3: '#736E60',
    clay: '#D97757',
    clayDeep: '#AD4A27',
    claySoft: '#F6E9E2',
    pine: '#33694D',
    pineSoft: '#E6EFEA',
    concept: '#2E4CB8',
    conceptSoft: '#E9EFFF',
    idea: '#A15C07',
    ideaSoft: '#FBF0DD',
    slate: '#5A6570',
    slateSoft: '#ECEFF2',
    shadowOpacity: '0.07',
    brandIconBg: '#F4F1E8',
    brandIconStroke: '#DCD7C8',
  },
  dark: {
    canvas: '#141413',
    pane: '#191817',
    card: '#1D1C1A',
    track: '#252320',
    border: '#2B2925',
    borderStrong: '#3B3830',
    ink: '#E9E5DA',
    ink2: '#B3ADA0',
    ink3: '#837D71',
    clay: '#E08A6A',
    clayDeep: '#F0A184',
    claySoft: '#2E221D',
    pine: '#7FAE8C',
    pineSoft: '#1D2922',
    concept: '#8FA8FF',
    conceptSoft: '#1D243B',
    idea: '#E6B463',
    ideaSoft: '#2D2518',
    slate: '#9CA8B4',
    slateSoft: '#23272C',
    shadowOpacity: '0.28',
    brandIconBg: '#1C1B19',
    brandIconStroke: '#2E2C27',
  },
};

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function brandMark(x, y, size, t) {
  const s = size / 100;
  return `
  <g transform="translate(${x} ${y}) scale(${s})">
    <rect x="0" y="0" width="100" height="100" rx="22" fill="${t.brandIconBg}" stroke="${t.brandIconStroke}" stroke-width="2"/>
    <g transform="translate(50 50)">
      <ellipse cx="0" cy="0" rx="33" ry="14" fill="none" stroke="${t.clay}" stroke-width="8" transform="rotate(-28)"/>
      <circle cx="20.8" cy="-19.8" r="5.5" fill="${t.canvas}" stroke="${t.ink}" stroke-width="2.6"/>
      <circle cx="0" cy="0" r="10" fill="${t.clay}"/>
    </g>
  </g>`;
}

function pill(x, y, w, h, bg, fg, label, opts = {}) {
  const { border, fontSize = 11, fontWeight = 600, mono = false, rx = h / 2 } = opts;
  const strokeAttr = border ? ` stroke="${border}" stroke-width="1"` : '';
  const family = mono ? FONT_MONO : FONT_SANS;
  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${bg}"${strokeAttr}/>
    <text x="${x + w / 2}" y="${y + h / 2 + fontSize * 0.36}" text-anchor="middle" font-family="${family}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fg}">${esc(label)}</text>
  </g>`;
}

function renderWorkspacePreview(themeName, t) {
  const W = 960;
  const H = 540;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 main/scripts/gen-readme-diagrams.mjs 生成，请勿手改 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Engram 工作区界面一览">
  <title>Engram 工作区界面一览</title>
  <defs>
    <filter id="card-shadow-${themeName}" x="-8%" y="-8%" width="116%" height="120%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000000" flood-opacity="${t.shadowOpacity}"/>
    </filter>
    <clipPath id="app-clip-${themeName}">
      <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="14"/>
    </clipPath>
  </defs>

  <!-- 外层应用窗体 -->
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="14" fill="${t.canvas}" stroke="${t.borderStrong}" stroke-width="1.2"/>

  <g clip-path="url(#app-clip-${themeName})">
    <!-- 顶部 38px 铭牌标题栏 -->
    <rect x="8" y="8" width="${W - 16}" height="38" fill="${t.pane}"/>
    <line x1="8" y1="46" x2="${W - 8}" y2="46" stroke="${t.border}" stroke-width="1"/>
    ${brandMark(20, 15, 24, t)}
    <text x="52" y="31" font-family="${FONT_SANS}" font-size="13" font-weight="700" fill="${t.ink}">Engram</text>
    <text x="108" y="31" font-family="${FONT_MONO}" font-size="11" fill="${t.ink3}">·  128 篇页面</text>
    <text x="232" y="31" font-family="${FONT_SANS}" font-size="12" fill="${t.ink2}">概念 / 知识库架构</text>

    <!-- 右侧标题栏胶囊：搜索 / 记灵感 / 同步 -->
    ${pill(570, 15, 122, 24, t.card, t.ink2, 'Ctrl+K  全局搜索', { border: t.border, fontSize: 11, fontWeight: 500, rx: 6 })}
    ${pill(700, 15, 86, 24, t.claySoft, t.clayDeep, '+ 记灵感', { border: t.border, fontSize: 11, fontWeight: 600, rx: 6 })}
    <rect x="794" y="15" width="96" height="24" rx="12" fill="${t.pineSoft}" stroke="${t.border}" stroke-width="1"/>
    <circle cx="808" cy="27" r="4" fill="${t.pine}"/>
    <text x="818" y="31" font-family="${FONT_SANS}" font-size="11" font-weight="600" fill="${t.pine}">局域网同步</text>
    <!-- 窗口控制点 -->
    <circle cx="912" cy="27" r="4" fill="${t.borderStrong}"/>
    <circle cx="928" cy="27" r="4" fill="${t.borderStrong}"/>

    <!-- 左侧图标轨 (46px) -->
    <rect x="8" y="46" width="46" height="${H - 54}" fill="${t.pane}"/>
    <line x1="54" y1="46" x2="54" y2="${H - 8}" stroke="${t.border}" stroke-width="1"/>
    <!-- 图标轨按钮 -->
    <rect x="15" y="60" width="32" height="32" rx="8" fill="${t.claySoft}"/>
    <rect x="23" y="69" width="16" height="14" rx="2.5" fill="none" stroke="${t.clayDeep}" stroke-width="1.6"/>
    <line x1="27" y1="74" x2="35" y2="74" stroke="${t.clayDeep}" stroke-width="1.5"/>
    <line x1="27" y1="78" x2="33" y2="78" stroke="${t.clayDeep}" stroke-width="1.5"/>

    <circle cx="31" cy="112" r="7" fill="none" stroke="${t.ink3}" stroke-width="1.5"/>
    <line x1="36" y1="117" x2="40" y2="121" stroke="${t.ink3}" stroke-width="1.6" stroke-linecap="round"/>

    <circle cx="25" cy="148" r="3" fill="none" stroke="${t.ink3}" stroke-width="1.5"/>
    <circle cx="37" cy="144" r="2.5" fill="none" stroke="${t.ink3}" stroke-width="1.5"/>
    <circle cx="36" cy="156" r="2.5" fill="none" stroke="${t.ink3}" stroke-width="1.5"/>
    <line x1="28" y1="147" x2="34.5" y2="145" stroke="${t.ink3}" stroke-width="1.2"/>
    <line x1="27.5" y1="150" x2="33.5" y2="154.5" stroke="${t.ink3}" stroke-width="1.2"/>

    <rect x="23" y="178" width="16" height="13" rx="2" fill="none" stroke="${t.ink3}" stroke-width="1.5"/>
    <path d="M23 185 h5 l2 2.5 h2 l2 -2.5 h5" fill="none" stroke="${t.ink3}" stroke-width="1.4"/>

    <rect x="23" y="210" width="16" height="15" rx="2.5" fill="none" stroke="${t.ink3}" stroke-width="1.5"/>
    <line x1="27" y1="215" x2="35" y2="215" stroke="${t.ink3}" stroke-width="1.4"/>
    <line x1="27" y1="220" x2="33" y2="220" stroke="${t.ink3}" stroke-width="1.4"/>

    <!-- 底部 ✨ Agent 图标与设置 -->
    <rect x="15" y="454" width="32" height="32" rx="8" fill="${t.conceptSoft}"/>
    <path d="M31 462 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2 z" fill="${t.concept}"/>
    <circle cx="31" cy="506" r="6" fill="none" stroke="${t.ink3}" stroke-width="1.5"/>
    <circle cx="31" cy="506" r="2" fill="${t.ink3}"/>

    <!-- 左侧目录树 (176px) -->
    <rect x="54" y="46" width="176" height="${H - 54}" fill="${t.pane}"/>
    <line x1="230" y1="46" x2="230" y2="${H - 8}" stroke="${t.border}" stroke-width="1"/>
    <text x="68" y="70" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${t.ink}">知识库</text>
    <text x="196" y="70" font-family="${FONT_MONO}" font-size="11" fill="${t.ink3}">+ ⤢</text>

    <!-- 搜索条 -->
    <rect x="66" y="82" width="152" height="26" rx="6" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>
    <text x="76" y="99" font-family="${FONT_SANS}" font-size="11" fill="${t.ink3}">搜索页面与资料...</text>

    <!-- 概念 -->
    <text x="68" y="130" font-family="${FONT_SANS}" font-size="11.5" font-weight="600" fill="${t.ink2}">▾  概念</text>
    <text x="206" y="130" font-family="${FONT_MONO}" font-size="10.5" fill="${t.ink3}">42</text>
    <rect x="66" y="138" width="152" height="26" rx="6" fill="${t.claySoft}"/>
    <rect x="66" y="142" width="3" height="18" rx="1.5" fill="${t.clayDeep}"/>
    <text x="78" y="155" font-family="${FONT_SANS}" font-size="11.5" font-weight="600" fill="${t.ink}">本地优先与同步</text>
    <text x="78" y="177" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">证据引文门禁</text>
    <text x="78" y="199" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">双链图谱引擎</text>

    <!-- 实体 -->
    <text x="68" y="229" font-family="${FONT_SANS}" font-size="11.5" font-weight="600" fill="${t.ink2}">▾  实体</text>
    <text x="206" y="229" font-family="${FONT_MONO}" font-size="10.5" fill="${t.ink3}">36</text>
    <text x="78" y="251" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">人物 · 客户 · 项目</text>

    <!-- 原始资料 -->
    <text x="68" y="283" font-family="${FONT_SANS}" font-size="11.5" font-weight="600" fill="${t.ink2}">▾  原始资料</text>
    <text x="206" y="283" font-family="${FONT_MONO}" font-size="10.5" fill="${t.ink3}">50</text>
    <text x="78" y="305" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">📄  文档（调研/纪要）</text>
    <text x="78" y="328" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">💬  对话沉积</text>
    <text x="78" y="351" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">💡  灵感碎片</text>

    <!-- 收集箱待整理角标 -->
    <rect x="66" y="476" width="152" height="36" rx="8" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>
    <text x="76" y="498" font-family="${FONT_SANS}" font-size="11" font-weight="600" fill="${t.ink2}">收集箱</text>
    ${pill(136, 484, 74, 20, t.ideaSoft, t.idea, '3 项待入库', { fontSize: 10 })}

    <!-- 中间正文主区 (x=242..614) -->
    <!-- 面包屑与操作条 -->
    <text x="248" y="74" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink3}">Wiki  /  概念  /  本地优先与同步</text>
    ${pill(496, 58, 52, 22, t.card, t.ink2, '导出', { border: t.border, fontSize: 10.5 })}
    ${pill(554, 58, 56, 22, t.card, t.ink2, '编辑', { border: t.border, fontSize: 10.5 })}

    <!-- 标题与标签 -->
    <text x="248" y="114" font-family="${FONT_SANS}" font-size="22" font-weight="700" fill="${t.ink}">本地优先与多端同步</text>
    ${pill(248, 126, 48, 22, t.conceptSoft, t.concept, '概念', { fontSize: 11 })}
    ${pill(304, 126, 76, 22, t.pineSoft, t.pine, '已校验 S2', { fontSize: 11 })}
    ${pill(388, 126, 62, 22, t.track, t.ink2, '#架构', { fontSize: 11 })}

    <!-- 正文段落卡 -->
    <rect x="248" y="162" width="362" height="196" rx="10" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>
    <text x="264" y="188" font-family="${FONT_SANS}" font-size="13" font-weight="700" fill="${t.ink}">核心原则</text>
    <text x="264" y="212" font-family="${FONT_SANS}" font-size="12" fill="${t.ink2}">所有正文与资料以 Markdown 形式保存在</text>
    <text x="264" y="232" font-family="${FONT_SANS}" font-size="12" fill="${t.ink2}">本机</text>
    ${pill(294, 217, 56, 20, t.track, t.ink, 'brain/', { mono: true, fontSize: 10.5, rx: 4 })}
    <text x="356" y="232" font-family="${FONT_SANS}" font-size="12" fill="${t.ink2}">，断网可完整检索、编辑与查看</text>

    <!-- 双链胶囊行 -->
    <text x="264" y="256" font-family="${FONT_SANS}" font-size="12" fill="${t.ink2}">关联规范：</text>
    ${pill(326, 241, 108, 21, t.claySoft, t.clayDeep, '[[证据引文门禁]]', { fontSize: 11, rx: 5 })}
    ${pill(440, 241, 96, 21, t.conceptSoft, t.concept, '[[双链图谱引擎]]', { fontSize: 11, rx: 5 })}

    <!-- 来源证据引用条 -->
    <rect x="264" y="276" width="330" height="66" rx="7" fill="${t.pane}" stroke="${t.border}" stroke-width="1"/>
    <rect x="264" y="276" width="3.5" height="66" rx="1.5" fill="${t.pine}"/>
    <text x="278" y="296" font-family="${FONT_SANS}" font-size="11" font-weight="600" fill="${t.pine}">[S1] 原文逐字引文已校验 · 来源证据账本</text>
    <text x="278" y="314" font-family="${FONT_SANS}" font-size="11" fill="${t.ink2}">“成员端优先局域网直连，出门后自动切换</text>
    <text x="278" y="330" font-family="${FONT_SANS}" font-size="11" fill="${t.ink2}">IPv6 / IPv4 双栈，离线改动自动排队补齐。”</text>

    <!-- 中间下方：迷你知识图谱与本页关联卡片 -->
    <rect x="248" y="372" width="362" height="142" rx="10" fill="${t.card}" stroke="${t.border}" stroke-width="1"/>
    <text x="264" y="394" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${t.ink}">🕸 本页图谱关联</text>
    <text x="536" y="394" font-family="${FONT_SANS}" font-size="10.5" fill="${t.ink3}">4 个关联页</text>
    <!-- 节点连线 -->
    <line x1="358" y1="450" x2="296" y2="432" stroke="${t.borderStrong}" stroke-width="1.5"/>
    <line x1="358" y1="450" x2="436" y2="424" stroke="${t.clay}" stroke-width="2"/>
    <line x1="358" y1="450" x2="444" y2="476" stroke="${t.borderStrong}" stroke-width="1.5"/>
    <line x1="436" y1="424" x2="528" y2="446" stroke="${t.borderStrong}" stroke-width="1.5"/>
    <!-- 节点 -->
    <circle cx="296" cy="432" r="7" fill="${t.concept}"/>
    <text x="296" y="454" text-anchor="middle" font-family="${FONT_SANS}" font-size="10.5" fill="${t.ink2}">证据门禁</text>

    <circle cx="358" cy="450" r="11" fill="${t.clay}"/>
    <circle cx="358" cy="450" r="16" fill="none" stroke="${t.clay}" stroke-opacity="0.35" stroke-width="3"/>
    <text x="358" y="480" text-anchor="middle" font-family="${FONT_SANS}" font-size="11" font-weight="700" fill="${t.ink}">本地优先与同步</text>

    <circle cx="436" cy="424" r="7.5" fill="${t.pine}"/>
    <text x="436" y="410" text-anchor="middle" font-family="${FONT_SANS}" font-size="10.5" fill="${t.ink2}">NAS 中枢</text>

    <circle cx="444" cy="476" r="6.5" fill="${t.idea}"/>
    <text x="444" y="497" text-anchor="middle" font-family="${FONT_SANS}" font-size="10.5" fill="${t.ink2}">Android 端</text>

    <circle cx="528" cy="446" r="6.5" fill="${t.slate}"/>
    <text x="536" y="468" text-anchor="middle" font-family="${FONT_SANS}" font-size="10.5" fill="${t.ink2}">原始资料</text>

    <!-- 右侧悬浮「内置 Agent」毛玻璃卡片 -->
    <rect x="626" y="56" width="314" height="464" rx="12" fill="${t.card}" stroke="${t.borderStrong}" stroke-width="1.2" filter="url(#card-shadow-${themeName})"/>
    <!-- 抽屉头 -->
    <rect x="626" y="56" width="314" height="40" rx="12" fill="${t.pane}"/>
    <rect x="626" y="84" width="314" height="12" fill="${t.pane}"/>
    <line x1="626" y1="96" x2="940" y2="96" stroke="${t.border}" stroke-width="1"/>
    <circle cx="646" cy="76" r="9" fill="${t.conceptSoft}"/>
    <path d="M646 70 l1.5 4.5 4.5 1.5 -4.5 1.5 -1.5 4.5 -1.5 -4.5 -4.5 -1.5 4.5 -1.5 z" fill="${t.concept}"/>
    <text x="662" y="80" font-family="${FONT_SANS}" font-size="12.5" font-weight="700" fill="${t.ink}">内置 Agent</text>
    ${pill(832, 65, 96, 22, t.track, t.ink2, '控制台 · 全屏 · —', { fontSize: 10, rx: 6 })}

    <!-- 用户提问气泡 -->
    <rect x="676" y="110" width="250" height="36" rx="9" fill="${t.track}"/>
    <text x="690" y="132" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink}">总结本周收集箱资料并检查同步</text>

    <!-- 折叠的工具调用摘要 -->
    <rect x="640" y="158" width="286" height="28" rx="6" fill="${t.pane}" stroke="${t.border}" stroke-width="1"/>
    <circle cx="654" cy="172" r="3.5" fill="${t.pine}"/>
    <text x="664" y="176" font-family="${FONT_MONO}" font-size="10.5" fill="${t.ink2}">engram search · 3 命中 · 0.2s</text>
    <text x="904" y="176" font-family="${FONT_SANS}" font-size="10.5" fill="${t.ink3}">展开</text>

    <!-- Agent 流式回复正文 -->
    <text x="642" y="208" font-family="${FONT_SANS}" font-size="12" font-weight="700" fill="${t.ink}">已检索并整理 3 份资料：</text>
    <text x="642" y="230" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">• 已提炼 2 份会议纪要入概念页</text>
    <text x="642" y="250" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">• 逐字引文均通过证据门禁校验</text>
    <text x="642" y="270" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">• 建议查看：</text>
    ${pill(716, 255, 114, 20, t.claySoft, t.clayDeep, '[[本地优先与同步]]', { fontSize: 10.5, rx: 5 })}

    <!-- 缓存命中条 -->
    ${pill(642, 290, 154, 20, t.pineSoft, t.pine, '本轮缓存命中 74% · 已完成', { fontSize: 10, rx: 5 })}

    <!-- 推荐问法 -->
    <rect x="640" y="346" width="286" height="30" rx="7" fill="${t.pane}" stroke="${t.border}" stroke-width="1"/>
    <text x="652" y="365" font-family="${FONT_SANS}" font-size="11" fill="${t.ink2}">↳ 提炼下周工作任务到任务看板</text>

    <!-- 底部输入区 -->
    <rect x="640" y="394" width="286" height="112" rx="10" fill="${t.pane}" stroke="${t.borderStrong}" stroke-width="1.1"/>
    <text x="654" y="418" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink3}">问点什么，或让我整理知识库...</text>
    ${pill(652, 470, 56, 24, t.card, t.ink2, '📎 附件', { border: t.border, fontSize: 10.5, rx: 6 })}
    ${pill(714, 470, 66, 24, t.card, t.ink2, '🗃 收集箱', { border: t.border, fontSize: 10.5, rx: 6 })}
    ${pill(854, 470, 60, 24, t.ink, t.card, '发送 ↵', { fontSize: 11, fontWeight: 600, rx: 6 })}
  </g>
</svg>`;
}

function renderWorkflow(themeName, t) {
  const W = 960;
  const H = 290;
  const steps = [
    {
      num: '01',
      title: '多源收集',
      badge: '不污染正文',
      badgeBg: t.ideaSoft,
      badgeFg: t.idea,
      items: ['文档 · 网页原件', 'B站 / 抖音视频链接', '语音速记 · 手机分享', '讯飞办公本 · 飞书表格'],
      foot: '暂存「收集箱」或「原始资料」',
    },
    {
      num: '02',
      title: 'Agent 提炼',
      badge: '内置 / 外部通用',
      badgeBg: t.conceptSoft,
      badgeFg: t.concept,
      items: ['内置聊天抽屉开箱即用', '外部 CLI + Skill 无缝接入', '视频字幕 / 多图语义纪要', '梦境思考按计划自动整理'],
      foot: '统一走 engram 命令面',
    },
    {
      num: '03',
      title: '证据门禁',
      badge: '防编造兜底',
      badgeBg: t.pineSoft,
      badgeFg: t.pine,
      items: ['原文引文逐字校验', '概念/实体多来源门禁', '操作写入日志与版本追溯', 'Markdown 与图片资产落盘'],
      foot: '权威数据永远留在 brain/',
    },
    {
      num: '04',
      title: '检索与产出',
      badge: '即刻可用',
      badgeBg: t.claySoft,
      badgeFg: t.clayDeep,
      items: ['全文搜索与双链跳转', '交互式知识图谱视角', '自动汇总周/月任务看板', '客户调研 · 导出 PDF / 长图'],
      foot: '可检索、可回溯、可多端分享',
    },
  ];

  const cardW = 204;
  const cardH = 228;
  const gap = 26;
  const startX = 33;
  const startY = 31;

  let body = '';
  steps.forEach((s, idx) => {
    const x = startX + idx * (cardW + gap);
    const y = startY;
    body += `
    <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="12" fill="${t.card}" stroke="${t.borderStrong}" stroke-width="1.1"/>
    <text x="${x + 16}" y="${y + 28}" font-family="${FONT_MONO}" font-size="12" font-weight="700" fill="${t.clayDeep}">${s.num}</text>
    <text x="${x + 38}" y="${y + 28}" font-family="${FONT_SANS}" font-size="15" font-weight="700" fill="${t.ink}">${esc(s.title)}</text>
    ${pill(x + 16, y + 40, cardW - 32, 22, s.badgeBg, s.badgeFg, s.badge, { fontSize: 10.5, rx: 6 })}
    <line x1="${x + 16}" y1="${y + 74}" x2="${x + cardW - 16}" y2="${y + 74}" stroke="${t.border}" stroke-width="1"/>
    `;
    s.items.forEach((it, j) => {
      const iy = y + 98 + j * 24;
      body += `
      <circle cx="${x + 21}" cy="${iy - 4}" r="2.2" fill="${t.clay}"/>
      <text x="${x + 31}" y="${iy}" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">${esc(it)}</text>`;
    });
    body += `
    <rect x="${x + 12}" y="${y + 190}" width="${cardW - 24}" height="26" rx="6" fill="${t.pane}" stroke="${t.border}" stroke-width="0.9"/>
    <text x="${x + cardW / 2}" y="${y + 207}" text-anchor="middle" font-family="${FONT_SANS}" font-size="10.5" font-weight="600" fill="${t.ink3}">${esc(s.foot)}</text>`;

    if (idx < steps.length - 1) {
      const ax1 = x + cardW + 4;
      const ax2 = x + cardW + gap - 6;
      const ay = y + cardH / 2;
      body += `
      <line x1="${ax1}" y1="${ay}" x2="${ax2}" y2="${ay}" stroke="${t.clay}" stroke-width="2" stroke-linecap="round"/>
      <polygon points="${ax2 + 3},${ay} ${ax2 - 4},${ay - 4.5} ${ax2 - 4},${ay + 4.5}" fill="${t.clay}"/>`;
    }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 main/scripts/gen-readme-diagrams.mjs 生成，请勿手改 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Engram 知识整理工作流">
  <title>Engram 知识整理工作流</title>
  <rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="14" fill="${t.canvas}" stroke="${t.border}" stroke-width="1"/>
  ${body}
</svg>`;
}

function renderPlatforms(themeName, t) {
  const W = 960;
  const H = 330;

  const cards = [
    {
      x: 30,
      title: 'Windows 桌面端',
      tag: '安装包 / 源码快装',
      tagBg: t.conceptSoft,
      tagFg: t.concept,
      lines: ['Electron 内嵌本地服务端', '断网照常编辑、搜索与看图谱', '托盘常驻 · 应用内增量更新'],
    },
    {
      x: 342,
      title: 'Docker / NAS 中枢',
      tag: '24 小时同步中枢',
      tagBg: t.claySoft,
      tagFg: t.clayDeep,
      lines: ['单容器部署，源码同源零移植', '内置 HTTPS · DDNS · 扫码邀请', '承载手机代理、视频提炼与定时整理'],
    },
    {
      x: 654,
      title: 'Android 本地优先端',
      tag: '触屏适配 · 离线可用',
      tagBg: t.pineSoft,
      tagFg: t.pine,
      lines: ['内置本地知识库与 FTS 索引', '手机 / 折叠屏 / 平板自适应骨架', '系统分享进收集箱 · 后台保活同步'],
    },
  ];

  let cardsSvg = '';
  cards.forEach((c) => {
    const w = 276;
    const h = 152;
    const y = 24;
    cardsSvg += `
    <rect x="${c.x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.card}" stroke="${t.borderStrong}" stroke-width="1.1"/>
    <text x="${c.x + 18}" y="${y + 30}" font-family="${FONT_SANS}" font-size="15.5" font-weight="700" fill="${t.ink}">${esc(c.title)}</text>
    ${pill(c.x + 18, y + 42, 152, 22, c.tagBg, c.tagFg, c.tag, { fontSize: 10.5, rx: 6 })}
    <line x1="${c.x + 18}" y1="${y + 74}" x2="${c.x + w - 18}" y2="${y + 74}" stroke="${t.border}" stroke-width="1"/>`;
    c.lines.forEach((line, i) => {
      const ly = y + 96 + i * 21;
      cardsSvg += `
      <circle cx="${c.x + 23}" cy="${ly - 4}" r="2.2" fill="${t.clay}"/>
      <text x="${c.x + 33}" y="${ly}" font-family="${FONT_SANS}" font-size="11.5" fill="${t.ink2}">${esc(line)}</text>`;
    });
  });

  // 同步连接桥
  const midY = 204;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 main/scripts/gen-readme-diagrams.mjs 生成，请勿手改 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Engram 三端架构与多端同步">
  <title>Engram 三端架构与多端同步</title>
  <rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="14" fill="${t.canvas}" stroke="${t.border}" stroke-width="1"/>

  ${cardsSvg}

  <!-- 垂直连接线到同步总线 -->
  <line x1="168" y1="176" x2="168" y2="${midY}" stroke="${t.pine}" stroke-width="1.8" stroke-dasharray="4 3"/>
  <line x1="480" y1="176" x2="480" y2="${midY}" stroke="${t.clay}" stroke-width="2"/>
  <line x1="792" y1="176" x2="792" y2="${midY}" stroke="${t.pine}" stroke-width="1.8" stroke-dasharray="4 3"/>

  <!-- 同步总线横条 -->
  <rect x="96" y="${midY}" width="768" height="34" rx="17" fill="${t.pane}" stroke="${t.borderStrong}" stroke-width="1.1"/>
  <circle cx="122" cy="${midY + 17}" r="4.5" fill="${t.pine}"/>
  <text x="480" y="${midY + 21}" text-anchor="middle" font-family="${FONT_SANS}" font-size="12" font-weight="600" fill="${t.ink}">双向实时同步通道：局域网直连 → IPv6 → IPv4 自动择优  ·  Markdown / 图片 / 会话 / 看板 / 设置同步</text>
  <circle cx="838" cy="${midY + 17}" r="4.5" fill="${t.pine}"/>

  <!-- 向下连到底座 -->
  <line x1="480" y1="${midY + 34}" x2="480" y2="254" stroke="${t.borderStrong}" stroke-width="1.8"/>

  <!-- 统一底层产品内核 -->
  <rect x="30" y="254" width="900" height="54" rx="12" fill="${t.pane}" stroke="${t.borderStrong}" stroke-width="1.1"/>
  <text x="52" y="286" font-family="${FONT_SANS}" font-size="13.5" font-weight="700" fill="${t.ink}">统一产品内核</text>
  ${pill(176, 267, 224, 28, t.card, t.ink2, 'brain/ Markdown 权威数据', { border: t.border, fontSize: 11.5, rx: 7 })}
  ${pill(414, 267, 240, 28, t.card, t.ink2, 'SQLite FTS5 索引 + 证据账本', { border: t.border, fontSize: 11.5, rx: 7 })}
  ${pill(668, 267, 242, 28, t.claySoft, t.clayDeep, 'engram CLI + Skill 统一接口', { border: t.border, fontSize: 11.5, fontWeight: 600, rx: 7 })}
</svg>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const files = [];
for (const [themeName, themeTokens] of Object.entries(THEMES)) {
  const outputs = [
    [`workspace-preview-${themeName}.svg`, renderWorkspacePreview(themeName, themeTokens)],
    [`workflow-${themeName}.svg`, renderWorkflow(themeName, themeTokens)],
    [`platforms-${themeName}.svg`, renderPlatforms(themeName, themeTokens)],
  ];
  for (const [name, content] of outputs) {
    const outPath = path.join(OUT_DIR, name);
    fs.writeFileSync(outPath, content, 'utf8');
    files.push(outPath);
  }
}

console.log(`Generated ${files.length} SVG diagrams in ${OUT_DIR}:`);
for (const f of files) {
  console.log(' -', path.basename(f));
}
