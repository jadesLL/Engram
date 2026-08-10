import type { StoredContribution } from './sourceLedger.js';

export interface KnowledgeRelation {
  src: string;
  word: string;
  dst: string;
  factId: string;
}

export interface EntitySections {
  title: string;
  current: string;
  related: string;
  timeline: string;
}

export interface EntitySynthesisSections {
  id: string;
  current: string;
  related: string;
  timeline: string;
}

function clean(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseEntitySections(markdown: string, fallbackTitle: string): EntitySections {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const titleLine = lines.find((line) => /^#\s+/.test(line));
  const title = titleLine?.replace(/^#\s+/, '').trim() || fallbackTitle;
  const buckets: Record<'current' | 'related' | 'timeline', string[]> = {
    current: [],
    related: [],
    timeline: [],
  };
  let state: keyof typeof buckets = 'current';
  for (const line of lines) {
    if (line === titleLine) continue;
    if (/^##\s*当前理解\s*$/.test(line)) { state = 'current'; continue; }
    if (/^##\s*相关页面\s*$/.test(line)) { state = 'related'; continue; }
    if (/^##\s*时间线\s*$/.test(line)) { state = 'timeline'; continue; }
    if (state === 'timeline' && /^##\s+/.test(line)) {
      state = 'current';
    }
    buckets[state].push(line);
  }
  const current = clean(buckets.current.join('\n')).replace(/^##\s+/gm, '### ');
  return {
    title,
    current,
    related: clean(buckets.related.join('\n')),
    timeline: clean(buckets.timeline.join('\n')),
  };
}

export function renderEntitySections(sections: EntitySections): string {
  return [
    `# ${sections.title}`,
    '',
    '## 当前理解',
    '',
    sections.current,
    '',
    '## 相关页面',
    '',
    sections.related,
    '',
    '## 时间线',
    '',
    sections.timeline,
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

export function ensureEntityStructure(markdown: string, fallbackTitle = '未命名实体'): string {
  return renderEntitySections(parseEntitySections(markdown, fallbackTitle));
}

function contributionPattern(key: string, section?: 'current' | 'related'): RegExp {
  const suffix = section ? `:${section}` : '';
  return new RegExp(
    `<!-- contribution:${escapeRegExp(key)}${suffix}:start -->[\\s\\S]*?<!-- contribution:${escapeRegExp(key)}${suffix}:end -->\\n*`,
    'g'
  );
}

function synthesisPattern(section: 'current' | 'related' | 'timeline'): RegExp {
  return new RegExp(
    `<!--\\s*synthesis:([^:>]+):${section}:start\\s*-->([\\s\\S]*?)<!--\\s*synthesis:\\1:${section}:end\\s*-->`,
    'g',
  );
}

function anyContributionPattern(): RegExp {
  return /<!--\s*contribution:[^>]+:start\s*-->[\s\S]*?<!--\s*contribution:[^>]+:end\s*-->\n*/g;
}

function stripSynthesisBlock(value: string, section: 'current' | 'related' | 'timeline'): string {
  return clean(value.replace(synthesisPattern(section), ''));
}

function synthesisBlock(id: string, section: 'current' | 'related' | 'timeline', content: string): string {
  return [
    `<!-- synthesis:${id}:${section}:start -->`,
    clean(content),
    `<!-- synthesis:${id}:${section}:end -->`,
  ].join('\n');
}

function extractSynthesisBlock(
  value: string,
  section: 'current' | 'related' | 'timeline',
): { id: string; content: string } | null {
  const match = [...value.matchAll(synthesisPattern(section))].at(-1);
  return match ? { id: match[1], content: clean(match[2]) } : null;
}

export function extractEntitySynthesis(markdown: string, fallbackTitle = '未命名实体'): EntitySynthesisSections | null {
  const sections = parseEntitySections(markdown, fallbackTitle);
  const current = extractSynthesisBlock(sections.current, 'current');
  const related = extractSynthesisBlock(sections.related, 'related');
  const timeline = extractSynthesisBlock(sections.timeline, 'timeline');
  if (!current) return null;
  return {
    id: current.id,
    current: current.content,
    related: related?.id === current.id ? related.content : '',
    timeline: timeline?.id === current.id ? timeline.content : '',
  };
}

export function extractEntityManualSections(
  existing: string,
  title: string,
  allManaged: StoredContribution[],
): EntitySections {
  const stripped = removeManagedBlocks(existing || `# ${title}\n`, allManaged, true);
  const sections = parseEntitySections(stripped, title);
  return {
    ...sections,
    current: stripSynthesisBlock(sections.current.replace(anyContributionPattern(), ''), 'current'),
    related: stripSynthesisBlock(sections.related.replace(anyContributionPattern(), ''), 'related'),
    timeline: stripSynthesisBlock(sections.timeline.replace(anyContributionPattern(), ''), 'timeline'),
  };
}

export function renderEntitySynthesisProjection(
  existing: string,
  title: string,
  allManaged: StoredContribution[],
  synthesis: EntitySynthesisSections,
): string {
  const sections = extractEntityManualSections(existing, title, allManaged);
  sections.current = [
    sections.current,
    synthesisBlock(synthesis.id, 'current', synthesis.current),
  ].filter(Boolean).join('\n\n');
  sections.related = [
    sections.related,
    synthesisBlock(synthesis.id, 'related', synthesis.related),
  ].filter(Boolean).join('\n\n');
  sections.timeline = [
    sections.timeline,
    synthesisBlock(synthesis.id, 'timeline', synthesis.timeline),
  ].filter(Boolean).join('\n\n');
  return renderEntitySections(sections);
}

function sourceMarker(runId: string, factIds: string[]): string {
  return `<!-- ingest:${runId};facts:${factIds.join(',')} -->`;
}

function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function splitDraft(content: string): { current: string; related: string } {
  const normalized = clean(content).replace(/^#\s+.+\n+/, '');
  const marker = normalized.match(/^##\s*相关页面\s*$/m);
  if (!marker?.index && marker?.index !== 0) {
    return { current: normalized.replace(/^##\s+/gm, '### '), related: '' };
  }
  const before = normalized.slice(0, marker.index);
  const after = normalized.slice(marker.index + marker[0].length);
  return {
    current: clean(before).replace(/^##\s+/gm, '### '),
    related: clean(after),
  };
}

function relationLines(contribution: StoredContribution): string[] {
  const relations = parseJsonArray<KnowledgeRelation>(contribution.relations);
  return relations
    .filter((relation) => relation.src && relation.dst && relation.word)
    .map((relation) => `- [[${relation.src}]]::${relation.word}::[[${relation.dst}]]`);
}

function entityBlocks(contribution: StoredContribution): { current: string; related: string } {
  const draft = splitDraft(contribution.content);
  const facts = parseJsonArray<string>(contribution.fact_ids);
  const source = contribution.source_ref || contribution.source_path;
  const current = [
    `<!-- contribution:${contribution.contribution_key}:current:start -->`,
    `### 来源提炼（${contribution.updated_at.slice(0, 10)}）`,
    '',
    `> 来源：${source}`,
    sourceMarker(contribution.run_id, facts),
    '',
    draft.current,
    `<!-- contribution:${contribution.contribution_key}:current:end -->`,
  ].join('\n');
  const relatedLines = [...new Set([
    ...draft.related.split('\n').map((line) => line.trim()).filter(Boolean),
    ...relationLines(contribution),
  ])];
  const related = relatedLines.length ? [
    `<!-- contribution:${contribution.contribution_key}:related:start -->`,
    ...relatedLines,
    `<!-- contribution:${contribution.contribution_key}:related:end -->`,
  ].join('\n') : '';
  return { current, related };
}

function conceptBlock(contribution: StoredContribution): string {
  const facts = parseJsonArray<string>(contribution.fact_ids);
  const source = contribution.source_ref || contribution.source_path;
  return [
    `<!-- contribution:${contribution.contribution_key}:start -->`,
    clean(contribution.content),
    '',
    '---',
    `> 来源：${source}`,
    sourceMarker(contribution.run_id, facts),
    `<!-- contribution:${contribution.contribution_key}:end -->`,
  ].join('\n');
}

function removeManagedBlocks(markdown: string, contributions: StoredContribution[], entity: boolean): string {
  let next = markdown;
  for (const contribution of contributions.filter((item) => item.managed)) {
    if (entity) {
      next = next
        .replace(contributionPattern(contribution.contribution_key, 'current'), '')
        .replace(contributionPattern(contribution.contribution_key, 'related'), '');
    } else {
      next = next.replace(contributionPattern(contribution.contribution_key), '');
    }
  }
  return next;
}

export function renderKnowledgeProjection(
  existing: string,
  title: string,
  entity: boolean,
  allManaged: StoredContribution[],
  active: StoredContribution[],
): string {
  const stripped = removeManagedBlocks(existing || `# ${title}\n`, allManaged, entity);
  if (!entity) {
    const base = stripped.trim() || `# ${title}`;
    const blocks = active.filter((item) => item.managed).map(conceptBlock);
    return `${base.replace(/\n*$/, '')}${blocks.length ? `\n\n${blocks.join('\n\n')}` : ''}\n`;
  }

  const sections = parseEntitySections(stripped, title);
  const currentBlocks: string[] = [];
  const relatedBlocks: string[] = [];
  for (const contribution of active.filter((item) => item.managed)) {
    const blocks = entityBlocks(contribution);
    currentBlocks.push(blocks.current);
    if (blocks.related) relatedBlocks.push(blocks.related);
  }
  sections.current = [sections.current, ...currentBlocks].filter(Boolean).join('\n\n');
  sections.related = [sections.related, ...relatedBlocks].filter(Boolean).join('\n\n');
  return renderEntitySections(sections);
}

export function mergeManualContent(keep: string, other: string, title: string, day: string): string {
  const entity = /##\s*时间线/.test(keep) || /##\s*当前理解/.test(keep);
  if (!entity) {
    return `${keep.replace(/\n*$/, '')}\n\n## 合并自 [[${title}]]（${day}）\n\n${other.replace(/^#\s+.+$/m, '').trim()}\n`;
  }
  const sections = parseEntitySections(keep, title);
  const absorbed = other.replace(/^#\s+.+$/m, '').trim().replace(/^##\s+/gm, '### ');
  sections.current = [
    sections.current,
    `> 合并自 [[${title}]]（${day}）`,
    absorbed,
  ].filter(Boolean).join('\n\n');
  sections.timeline = [
    sections.timeline,
    `- ${day}: 合并吸收了 [[${title}]] 的内容`,
  ].filter(Boolean).join('\n');
  return renderEntitySections(sections);
}
