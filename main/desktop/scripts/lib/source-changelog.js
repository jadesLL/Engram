// 源码模式更新说明：从远端 CHANGELOG 的增量条目提取用户可见更新（按「更新 / 优化 / 修复」归类），
// 提取不到时退回提交标题（过滤 Merge / docs / chore 等内部提交）。
// 产物是一段迷你 Markdown，由 web 侧 lib/releaseNotes.ts 统一解析展示，桌面主进程不再自己截取文案。
//
// 为什么不用 `git log --format=%s` 直接展示：日常合并包含 Merge 提交与 docs(changelog) 记录，
// 用户看到的是一屏提交标题（「Merge branch …」「docs(changelog): …」），既看不懂也不代表更新内容。
const CHANGELOG_PATHS = ['CHANGELOG.md', 'main/CHANGELOG.md'];

/** 从 `git diff --unified=0` 输出里取新增行（去掉 '+' 前缀与文件头），用于筛出本次新增的 CHANGELOG 条目。 */
function addedLinesFromDiff(diffText) {
  const added = new Set();
  for (const raw of String(diffText || '').replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1).trim();
    if (line) added.add(line);
  }
  return added;
}

/**
 * 本地 HEAD 的「未发布」区条目：用于排除「只是挪了位置」的旧条目。
 * 例如把已有条目从无分类整理到 `### 更新` 下，diff 会把它算成新增行；但它描述的改动本地早已有，
 * 不能算进这次更新。
 */
function unreleasedBullets(text) {
  const bullets = new Set();
  let inUnreleased = false;
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = raw.trim();
    if (/^##\s+/.test(trimmed)) {
      inUnreleased = /^##\s+未发布(?:\s|$)/.test(trimmed);
      continue;
    }
    if (inUnreleased && /^\s*[-*+]\s+/.test(raw)) bullets.add(trimmed);
  }
  return bullets;
}

/**
 * 从远端 CHANGELOG 抽取「本次新增」的条目，保留其 H3 分类标题。
 * 只处理 `## 未发布` 与 `## v<版本>` 段落；安卓累计段与注释/代码块跳过。
 * @param {string} remoteText 远端（origin/<branch>）CHANGELOG 全文
 * @param {Set<string>} addedLines addedLinesFromDiff() 的结果
 * @param {string} [localText] 本地 HEAD 的 CHANGELOG 全文（排除已存在条目，避免分类整理被误报为新增）
 * @returns {string} 迷你 Markdown（无新条目返回空串）
 */
function extractNewEntries(remoteText, addedLines, localText = '') {
  if (!remoteText || !addedLines || addedLines.size === 0) return '';
  const lines = String(remoteText).replace(/\r\n/g, '\n').split('\n');
  const alreadyKnown = unreleasedBullets(localText);
  const out = [];
  let inSection = false;
  let inComment = false;
  let inFence = false;
  let heading = '';
  let emittedHeading = '';
  let skipGroup = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (inFence) {
      if (trimmed.startsWith('```')) inFence = false;
      continue;
    }
    if (trimmed.startsWith('```')) {
      inFence = true;
      continue;
    }
    if (inComment) {
      if (trimmed.includes('-->')) inComment = false;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true;
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      inSection = /^##\s+未发布(?:\s|$)/.test(trimmed) || /^##\s+v\d+\.\d+\.\d+/.test(trimmed);
      heading = '';
      emittedHeading = '';
      skipGroup = false;
      continue;
    }
    if (/^#\s+/.test(trimmed) || !inSection) continue;
    const h3 = /^###\s+(.+)$/.exec(trimmed);
    if (h3) {
      heading = h3[1].trim();
      emittedHeading = '';
      skipGroup = false;
      continue;
    }
    const bold = /^\*\*(.+?)\*\*$/.exec(trimmed);
    if (bold) {
      // 「安卓端：自 vX 以来的累计更新」是发版工具对同一批改动的重复罗列
      skipGroup = /安卓端/.test(bold[1]) && /累计|更新/.test(bold[1]);
      continue;
    }
    if (!/^\s*[-*+]\s+/.test(raw) || skipGroup || !addedLines.has(trimmed)) continue;
    if (alreadyKnown.has(trimmed)) continue;
    const title = heading || '更新';
    if (emittedHeading !== title) {
      out.push(`### ${title}`);
      emittedHeading = title;
    }
    out.push(trimmed);
  }
  return out.join('\n');
}

/** 提交前缀 → 用户分类；docs/chore/ci/test/build/style/refactor/revert 属于内部改动，不展示。 */
const COMMIT_CATEGORY = {
  feat: '更新',
  feature: '更新',
  fix: '修复',
  hotfix: '修复',
  perf: '优化',
  improve: '优化',
  opt: '优化',
};
const INTERNAL_COMMIT_TYPES = new Set(['docs', 'chore', 'test', 'tests', 'ci', 'build', 'release', 'style', 'refactor', 'revert']);
const CATEGORY_ORDER = ['更新', '优化', '修复'];

/** 提交标题 → { category, text }；Merge/内部提交返回 null。 */
function classifySubject(subject) {
  const text = String(subject || '').trim();
  if (!text || /^Merge\b/i.test(text)) return null;
  const match = /^([A-Za-z]+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(text);
  if (!match) return { category: '更新', text };
  const type = match[1].toLowerCase();
  if (INTERNAL_COMMIT_TYPES.has(type)) return null;
  return { category: COMMIT_CATEGORY[type] || '更新', text: match[2].trim() };
}

/** 旧版前端只认 changes（纯字符串数组）：给出过滤后的用户可读提交标题。 */
function visibleSubjects(subjects, limit = 8) {
  const items = [];
  for (const subject of Array.isArray(subjects) ? subjects : []) {
    const classified = classifySubject(subject);
    if (!classified || !classified.text) continue;
    items.push(classified.text);
    if (items.length >= limit) break;
  }
  return items;
}

/** 提交标题兜底：按「更新 / 优化 / 修复」生成迷你 Markdown（CHANGELOG 没有增量条目时才用）。 */
function fallbackFromSubjects(subjects, limit = 8) {
  const buckets = new Map(CATEGORY_ORDER.map((category) => [category, []]));
  let count = 0;
  for (const subject of Array.isArray(subjects) ? subjects : []) {
    if (count >= limit) break;
    const classified = classifySubject(subject);
    if (!classified || !classified.text) continue;
    const bucket = buckets.get(classified.category);
    if (!bucket || bucket.includes(classified.text)) continue;
    bucket.push(classified.text);
    count += 1;
  }
  const out = [];
  for (const category of CATEGORY_ORDER) {
    const items = buckets.get(category);
    if (!items || items.length === 0) continue;
    out.push(`### ${category}`, ...items.map((item) => `- ${item}`));
  }
  return out.join('\n');
}

module.exports = {
  CHANGELOG_PATHS,
  addedLinesFromDiff,
  extractNewEntries,
  classifySubject,
  visibleSubjects,
  fallbackFromSubjects,
};
