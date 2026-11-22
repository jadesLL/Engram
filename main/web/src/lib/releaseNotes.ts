/**
 * Release 正文（= CHANGELOG 版本段落）解析：把用户可见更新按「更新 / 优化 / 修复」归类。
 *
 * 更新提示条、安卓更新面板和设置页共用这一份口径，避免各入口各自截取 Markdown：
 * - 只展示用户能看懂的条目，剥离 [平台影响: X] 标记、链接/加粗/代码等 Markdown 记号；
 * - `### 内部 / 文档 / 构建 / 测试 / CI` 与「安卓端累计更新」段不进提示（内部改动不是用户更新内容）；
 * - 兼容历史分类名（新增 → 更新、体验优化 → 优化），老版本 Release 也能正确分组；
 * - 不渲染远端 Markdown/HTML，只输出纯文本，避免远端内容注入页面。
 */

export interface ReleaseNotesSection {
  /** update / optimize / fix / other（other 保留原始小标题） */
  key: string;
  /** 展示用分类名：更新 / 优化 / 修复 … */
  title: string;
  items: string[];
}

export interface ParsedReleaseNotes {
  /** 版本段落开头的加粗摘要（有才返回） */
  summary: string;
  sections: ReleaseNotesSection[];
  /** 跨分类展平后的用户可见条目（顺序：更新 → 优化 → 修复 → 其他） */
  highlights: string[];
}

interface Category {
  key: string;
  title: string;
  hidden?: boolean;
}

/** 分类别名：新条目统一写「更新 / 优化 / 修复」，历史段落里的旧标题照样能归类。 */
const CATEGORY_ALIASES: Record<string, Category> = {
  更新: { key: 'update', title: '更新' },
  新增: { key: 'update', title: '更新' },
  新功能: { key: 'update', title: '更新' },
  功能: { key: 'update', title: '更新' },
  优化: { key: 'optimize', title: '优化' },
  体验优化: { key: 'optimize', title: '优化' },
  性能优化: { key: 'optimize', title: '优化' },
  改进: { key: 'optimize', title: '优化' },
  修复: { key: 'fix', title: '修复' },
  问题修复: { key: 'fix', title: '修复' },
  'Bug 修复': { key: 'fix', title: '修复' },
  Bug修复: { key: 'fix', title: '修复' },
  内部: { key: 'internal', title: '内部', hidden: true },
  文档: { key: 'internal', title: '文档', hidden: true },
  构建: { key: 'internal', title: '构建', hidden: true },
  测试: { key: 'internal', title: '测试', hidden: true },
  CI: { key: 'internal', title: 'CI', hidden: true },
};

const CATEGORY_ORDER: Record<string, number> = { update: 0, optimize: 1, fix: 2 };
const DEFAULT_CATEGORY: Category = { key: 'update', title: '更新' };
const MAX_ITEM_LENGTH = 220;

/** 行内 Markdown → 纯文本（链接留标题、图片丢弃、强调/代码记号去掉、HTML 标签剔除）。 */
function cleanInline(text: string): string {
  return String(text)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 条目正文清洗：先去掉平台影响标记（它只服务发版流程，属于「奇奇怪怪」的内部记号）。 */
function cleanItem(text: string): string {
  const withoutPlatform = String(text).replace(/^[\[【]平台影响\s*[:：][^\]】]*[\]】]\s*/, '');
  const cleaned = cleanInline(withoutPlatform);
  return cleaned.length > MAX_ITEM_LENGTH ? cleaned.slice(0, MAX_ITEM_LENGTH - 1) + '…' : cleaned;
}

function categoryOf(heading: string): Category | null {
  const name = cleanInline(heading);
  const known = CATEGORY_ALIASES[name];
  if (known) return known;
  // 未约定的分类保留原小标题展示，不静默丢掉用户可见内容
  return { key: `other:${name}`, title: name || '其他' };
}

/**
 * 解析 Release 正文 / 源码模式增量 CHANGELOG 片段。
 * 只收集 Markdown 列表项和普通段落；标题、摘要、注释、代码块、表格分隔线都跳过。
 */
export function parseReleaseNotes(markdown: string, maxPerSection = 8): ParsedReleaseNotes {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const buckets = new Map<string, ReleaseNotesSection>();
  const order: string[] = [];
  let current: Category | null = null;
  let hidden = false;
  let summary = '';
  let inFence = false;
  let inComment = false;

  const push = (raw: string) => {
    const category = current;
    if (!category || hidden) return;
    const item = cleanItem(raw);
    if (!item) return;
    const key = category.key;
    if (!buckets.has(key)) {
      buckets.set(key, { key, title: category.title, items: [] });
      order.push(key);
    }
    const bucket = buckets.get(key)!;
    if (!bucket.items.includes(item)) bucket.items.push(item);
  };

  for (const line of lines) {
    const trimmed = line.trim();
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
    if (!trimmed) continue;
    // H1/H2：版本标题或大区标题，重置分类（摘要只认第一个 H2 之后的加粗行）
    if (/^#{1,2}\s+/.test(trimmed)) {
      current = null;
      hidden = false;
      continue;
    }
    const heading = /^###\s+(.+)$/.exec(trimmed);
    if (heading) {
      const category = categoryOf(heading[1]);
      current = category;
      hidden = Boolean(category?.hidden);
      continue;
    }
    const bold = /^\*\*(.+?)\*\*$/.exec(trimmed);
    if (bold) {
      const text = cleanInline(bold[1]);
      // 安卓累积段是发版工具把同一批改动再列一遍，提示里不重复展示
      if (/安卓端/.test(text) && /累计|更新/.test(text)) {
        hidden = true;
        continue;
      }
      if (!current && !summary) summary = text;
      continue;
    }
    const bullet = /^(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(trimmed);
    if (bullet) {
      if (!current) current = DEFAULT_CATEGORY;
      push(bullet[1]);
      continue;
    }
    // 表格分隔/引用/分割线/HTML 不是用户更新条目
    if (/^(?:\||-{3,}|={3,}|>|<)/.test(trimmed)) continue;
    // 没有列表记号的普通段落（老 Release 常见）同样作为一条更新说明
    if (!current) current = DEFAULT_CATEGORY;
    push(trimmed);
  }

  const sections = order
    .map((key) => buckets.get(key)!)
    .filter((section) => section.items.length > 0)
    .sort((a, b) => (CATEGORY_ORDER[a.key] ?? 9) - (CATEGORY_ORDER[b.key] ?? 9))
    .map((section) => ({ ...section, items: section.items.slice(0, maxPerSection) }));

  return { summary, sections, highlights: sections.flatMap((section) => section.items) };
}

/** 只取分类后的可见段落（更新提示条 / 安卓更新面板共用）。 */
export function releaseNoteSections(markdown: string, maxPerSection = 8): ReleaseNotesSection[] {
  return parseReleaseNotes(markdown, maxPerSection).sections;
}
