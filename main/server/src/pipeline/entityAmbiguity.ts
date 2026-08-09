import type { Candidate, PlanItem } from './ingestModel.js';

export interface EntityRosterEntry {
  id?: string;
  title: string;
  type: string;
  summary?: string;
}

export interface AmbiguitySuggestion {
  id?: string;
  title: string;
  type: string;
  score: number;
  reason: string;
}

export interface EntityAmbiguity {
  category: 'role_title' | 'possible_typo';
  label: string;
  question: string;
  suggestions: AmbiguitySuggestion[];
}

export type AmbiguousPlanItem = PlanItem & { ambiguity?: EntityAmbiguity };

const ROLE_SUFFIXES = [
  '董事长', '总经理', '负责人', '副总裁', '总裁', '总监', '经理', '主管',
  '主任', '部长', '局长', '处长', '院长', '校长', '老板', '老师', '总', '董', '工',
];
const ORG_SUFFIXES = ['有限责任公司', '股份有限公司', '有限公司', '集团公司', '集团', '公司'];

function cleanName(value: string): string {
  return String(value || '').trim().replace(/[\s·•・]+/g, '').toLowerCase();
}

function comparableName(value: string): string {
  let name = cleanName(value);
  for (const suffix of ORG_SUFFIXES) {
    if (name.length > suffix.length + 1 && name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name;
}

function roleTitleParts(value: string): { prefix: string; suffix: string } | null {
  const name = cleanName(value);
  for (const suffix of ROLE_SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const prefix = name.slice(0, -suffix.length);
    if (!prefix || (prefix.length <= 3 && /^[\u3400-\u9fff]+$/.test(prefix))) return { prefix, suffix };
  }
  return null;
}

function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const previous = right.map((_, index) => index + 1);
  previous.unshift(0);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function compatibleType(kind: string, type: string): boolean {
  if (kind === type) return true;
  return kind === 'project' && type === 'org';
}

function contextFor(candidate: Candidate | undefined): string {
  if (!candidate) return '';
  return [
    candidate.summary,
    ...candidate.facts.flatMap((fact) => [fact.statement, ...fact.sources.map((source) => source.quote)]),
  ].join('\n');
}

function roleSuggestions(prefix: string, roster: EntityRosterEntry[], context: string): AmbiguitySuggestion[] {
  return roster
    .filter((entry) => entry.type === 'person')
    .filter((entry) => !prefix || cleanName(entry.title).startsWith(prefix))
    .map((entry) => {
      const mentioned = context.includes(entry.title);
      return {
        id: entry.id,
        title: entry.title,
        type: entry.type,
        score: mentioned ? 0.99 : 0.72,
        reason: mentioned ? '上下文出现完整姓名' : `与称谓共用姓氏“${prefix}”`,
      };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
    .slice(0, 5);
}

function typoSuggestions(name: string, kind: string, roster: EntityRosterEntry[], context: string): AmbiguitySuggestion[] {
  const source = comparableName(name);
  if (source.length < 2 || source.length > 20) return [];
  return roster
    .filter((entry) => compatibleType(kind, entry.type))
    .flatMap((entry) => {
      const target = comparableName(entry.title);
      if (!target || source === target || Math.abs(source.length - target.length) > 1) return [];
      if (kind === 'person' && (source.length !== target.length || source[0] !== target[0])) return [];
      const distance = editDistance(source, target);
      if (distance !== 1) return [];
      const mentioned = context.includes(entry.title);
      const score = mentioned ? 0.99 : Math.max(0.82, 1 - distance / Math.max(source.length, target.length));
      return [{
        id: entry.id,
        title: entry.title,
        type: entry.type,
        score,
        reason: mentioned ? '上下文出现已有正确名称' : '与已有实体仅一字之差',
      }];
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
    .slice(0, 5);
}

export function classifyEntityName(
  name: string,
  kind: string,
  roster: EntityRosterEntry[],
  context = '',
): EntityAmbiguity | null {
  if (!['person', 'project', 'org'].includes(kind)) return null;
  const role = kind === 'person' ? roleTitleParts(name) : null;
  if (role) {
    const suggestions = roleSuggestions(role.prefix, roster, context);
    return {
      category: 'role_title',
      label: '称谓不完整',
      question: `“${name}”是职务或称谓，不是稳定的人物名称。请确认完整姓名${suggestions.length ? '，或选择库中已有的人物' : ''}。`,
      suggestions,
    };
  }

  const suggestions = typoSuggestions(name, kind, roster, context);
  if (!suggestions.length) return null;
  return {
    category: 'possible_typo',
    label: '疑似错别字',
    question: `“${name}”与已有实体“${suggestions[0].title}”高度相似。请确认是否为错别字并合并，或填写经过确认的正确名称。`,
    suggestions,
  };
}

export function guardAmbiguousEntityNames(
  items: PlanItem[],
  candidates: Candidate[],
  roster: EntityRosterEntry[],
): AmbiguousPlanItem[] {
  const candidateByName = new Map(candidates.map((candidate) => [cleanName(candidate.name), candidate]));
  const rosterTitles = new Set(roster.map((entry) => cleanName(entry.title)));
  return items.map((item) => {
    const validMergeTarget = item.action === 'merge' && rosterTitles.has(cleanName(item.target));
    if (validMergeTarget || !['create', 'review', 'merge'].includes(item.action) || rosterTitles.has(cleanName(item.name))) return item;
    const ambiguity = classifyEntityName(item.name, item.kind, roster, contextFor(candidateByName.get(cleanName(item.name))));
    if (!ambiguity) return item;
    return {
      ...item,
      action: 'review',
      reason: [...new Set([item.reason, ambiguity.label, ambiguity.question].filter(Boolean))].join('；'),
      ambiguity,
    };
  });
}

export function isIncompleteRoleTitle(name: string): boolean {
  return Boolean(roleTitleParts(name));
}
