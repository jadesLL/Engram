import crypto from 'node:crypto';
import fs from 'node:fs';
import { readPage, safeJoin, writePage, pagePathTaken, type PageMeta } from './vault.js';
import { splitFrontmatter, stripLeadingHeading } from './rawBody.js';
import { RAW_IDEA_DIR } from './rawSections.js';
import { RenameError, renamePageSafely } from './renamePage.js';
import { appendWikiLog } from '../pipeline/indexFile.js';
import { enqueuePagePipeline } from '../jobQueue.js';
import {
  draftIdeaNote,
  ideaFileTitle,
  summarizeFixes,
  summarizeRefine,
  type IdeaNoteDraft,
  type IdeaRefineInfo,
} from './ideaNote.js';

/**
 * 灵感后台提炼：落盘之后的那一半（勘误专名 → 精炼正文 → 拟标题 → 改名 → 写成品）。
 *
 * 交互改成「按下就记下」之后，`POST /api/ideas` 只负责把原文立刻落进
 * `原始资料/灵感碎片/`，勘误与改写挪到后台任务里跑。这一步**只做锦上添花**：
 * 失败就一个字都不改，用户写下的原文永远还在（文件不删、内容不动）。
 *
 * 并发保护：用户完全可能在提炼的十几秒里回到成品页手改正文。入队时把磁盘内容
 * （含 frontmatter）的 sha256 记进 payload，执行时比对两次——读到原稿先比一次
 * （快速失败，不白跑一次模型），模型返回、真要落笔之前再比一次（挡住模型调用期间的手改）。
 * 两次都一致才改写；不一致走 `skipped-edit`：只写操作日志，**手改的版本永远赢**。
 *
 * 结果只当「这条任务的产出快照」用：staged/fixes/refined 由 jobs.ts 回填进任务行
 * （jobQueue.saveIdeaDistillResult），给状态查询与通知展示；**最终状态以页面/文件为准**
 * （标题、正文本就在文件里），任务行随任务过期清理，不是长期账本。
 */

/** 提炼结果的状态（唯一口径，见 docs/IDEA-DISTILL-SPEC.md 2.2） */
export type IdeaDistillStaged = 'done' | 'skipped-edit' | 'failed';

/** 机器码：失败/跳过时给前端做分支，文案另走 error */
export type IdeaDistillReason =
  | 'no-model'
  | 'too-long'
  | 'same'
  | 'too-verbose'
  | 'rejected'
  | 'edited'
  | 'missing'
  | 'error';

export interface IdeaDistillInput {
  id: string;
  /** 入队时这条灵感的 vault 相对路径 */
  path: string;
  /** 入队时磁盘内容（含 frontmatter）的 sha256；用来判断用户在提炼期间改没改 */
  hash: string;
}

export interface IdeaDistillFix {
  wrong: string;
  right: string;
  kind: string | null;
}

export interface IdeaDistillRefined {
  applied: boolean;
  before: number;
  after: number;
  reason?: IdeaRefineInfo['reason'];
}

export interface IdeaDistillResult {
  staged: IdeaDistillStaged;
  /** done 后是路径（标题变了会改名） */
  path: string;
  title: string;
  fixes: IdeaDistillFix[];
  pending: string[];
  refined: IdeaDistillRefined;
  reason?: IdeaDistillReason;
  error?: string;
}

export interface IdeaDistillOptions {
  /** 模型那一步（默认走 lib/ideaNote.ts 的完整链路；测试注入假实现） */
  draft?: (content: string) => Promise<IdeaNoteDraft>;
  /** 阶段回调：jobs.ts 把它翻成任务进度，stage 文案见 IDEA_DISTILL_STAGES */
  onProgress?: (stage: string, detail?: string) => void;
  /**
   * 任务取消信号（数据维护 withJobsStopped、用户手动取消、超时兜底都会 abort）。
   * 取消后绝不落笔：维护流程正在清理数据，这时写回去等于把清理结果弄脏；
   * 模型调用中途取消也只当失败，原文保持原样。
   */
  signal?: AbortSignal;
}

/** 取消时给用户/任务行的一句话（取消不是「提炼失败」，原文一个字没动） */
const CANCELLED_ERROR = '提炼被取消，原文没有改动';

/**
 * 阶段文案与进度（SPEC 冻结）：字段名不写进 payload，前端直接看 jobs 的 stage/detail。
 * 勘误/精炼/拟标题共用同一次模型调用，所以「精炼正文」「拟标题」在调用返回后才报——
 * 进度条动得起来，而不是在「勘误专名」上停 20 秒。
 */
export const IDEA_DISTILL_STAGES = {
  read: '读取原稿',
  fix: '勘误专名',
  refine: '精炼正文',
  title: '拟标题',
  write: '写入成品',
} as const;

export const IDEA_DISTILL_STAGE_PROGRESS: Record<string, number> = {
  [IDEA_DISTILL_STAGES.read]: 10,
  [IDEA_DISTILL_STAGES.fix]: 35,
  [IDEA_DISTILL_STAGES.refine]: 60,
  [IDEA_DISTILL_STAGES.title]: 80,
  [IDEA_DISTILL_STAGES.write]: 95,
};

/** stage → 任务进度：数字集中在这里，jobs.ts 不用再抄一份 */
export function ideaDistillProgress(stage: string): number {
  return IDEA_DISTILL_STAGE_PROGRESS[stage] ?? 50;
}

/** 文件完整内容（含 frontmatter）的 sha256：入队与执行时必须用同一把尺子 */
export function hashIdeaNoteContent(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 读一条灵感在磁盘上的 sha256；文件不在或路径非法返回 null（调用方按「文档不存在」处理） */
export function hashIdeaNoteFile(rel: string): string | null {
  try {
    const abs = safeJoin(String(rel ?? ''));
    if (!fs.existsSync(abs)) return null;
    return hashIdeaNoteContent(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/** 原始资料的日期前缀（`2026.10.01_`）：改名沿用文件里已有的那一天，不因为提炼换了今天 */
export function ideaFileDatePrefix(rel: string): string {
  const base = String(rel ?? '').split('/').pop() ?? '';
  const matched = /^(\d{4}\.\d{2}\.\d{2})_/.exec(base);
  return matched ? `${matched[1]}_` : '';
}

/** 文件名兜底标题（frontmatter 缺失、pages 行还没建时的最后一道） */
function fileNameTitle(rel: string): string {
  return (String(rel ?? '').split('/').pop() ?? '').replace(/\.md$/i, '');
}

/**
 * 展示用标题：原始资料的文件名带 `YYYY.MM.DD_` 前缀（与后端的 displayTitle 同一口径）。
 * 提炼失败时界面用的是「当前标题」——那条链路里标题可能是还没被模型改写过的
 * `2026.10.02_随手记`，直接把日期前缀亮给用户很糙。
 */
function displayTitle(title: string): string {
  return String(title ?? '').replace(/^\d{4}\.\d{2}\.\d{2}_/, '');
}

function skippedResult(rel: string, title: string): IdeaDistillResult {
  return {
    staged: 'skipped-edit',
    path: rel,
    title,
    fixes: [],
    pending: [],
    refined: { applied: false, before: 0, after: 0 },
    reason: 'edited',
  };
}

function failedResult(
  rel: string,
  title: string,
  reason: IdeaDistillReason,
  error: string,
  refinedReason?: IdeaRefineInfo['reason']
): IdeaDistillResult {
  return {
    staged: 'failed',
    path: rel,
    // 失败时界面显示的就是这个 title（通知与成品页都读它）：剥掉 `YYYY.MM.DD_` 前缀，
    // 别把 `2026.10.02_随手记` 原样亮给用户
    title: displayTitle(title),
    fixes: [],
    pending: [],
    refined: { applied: false, before: 0, after: 0, ...(refinedReason ? { reason: refinedReason } : {}) },
    reason,
    error,
  };
}

/**
 * 唯一的新标题：`YYYY.MM.DD_标题`，撞名依次加序号。
 *
 * 为什么不让 `renamePageSafely` 自己去撞名处理：它的撞名分支只改文件名（加 `-N`），
 * frontmatter 标题仍是原来那个 ⇒ 文件名与 frontmatter 不一致（历史遗留行为，见
 * renamePage.ts 的 pagePathTaken 分支）。同一天两条灵感被模型拟出同一个标题是真会发生的
 * （同文重记、模型给出相同的短标题），所以这里先把唯一标题算好再改名，两边一致。
 *
 * `currentRel` 是这条灵感自己现在的路径：它当然「已存在」，但那是自己，不算撞名——
 * 模型拟出的标题与当前一致时（`desired === currentTitle`）必须原样返回，否则会平白加个序号。
 */
function uniqueIdeaTitle(desired: string, currentRel: string): string {
  let candidate = desired;
  for (let i = 2; `${RAW_IDEA_DIR}/${candidate}.md` !== currentRel
    && pagePathTaken(`${RAW_IDEA_DIR}/${candidate}.md`); i += 1) {
    candidate = `${desired} (${i})`;
  }
  return candidate;
}

function logSkip(rel: string, title: string): void {
  try {
    appendWikiLog('灵感提炼', `「${title}」（${rel}）正文已被改动，跳过改写（保留你手改的版本）`);
  } catch { /* 日志失败不阻塞 */ }
}

/**
 * 提炼一条已落盘的灵感。返回结果不会抛错：失败也走 `staged:'failed'`，
 * 让调用方（jobs 任务）自己决定要不要把它标成失败任务。
 */
export async function distillIdeaNote(
  input: IdeaDistillInput,
  options: IdeaDistillOptions = {}
): Promise<IdeaDistillResult> {
  const rel = String(input?.path ?? '').trim();
  const expectedHash = String(input?.hash ?? '');
  const onProgress = options.onProgress ?? (() => { /* 无回调时静默 */ });
  const runDraft = options.draft ?? ((content: string) => draftIdeaNote(content));
  const aborted = () => Boolean(options.signal?.aborted);

  onProgress(IDEA_DISTILL_STAGES.read);
  let raw: string;
  try {
    const abs = safeJoin(rel);
    if (!rel || !fs.existsSync(abs)) {
      return failedResult(rel, '', 'missing', '这条灵感已经不在了，没有改动任何内容');
    }
    raw = fs.readFileSync(abs, 'utf8');
  } catch (error: any) {
    return failedResult(rel, '', 'error', `读不到这条灵感（${error?.message || error}），没有改动任何内容`);
  }

  const page = readPage(rel);
  const title = page?.meta.title || fileNameTitle(rel);

  // 第一次比对：读到原稿就已经和入队时不一致（编辑器保存、同步拉回、Agent 改过）——
  // 没必要再跑一次模型，更不能等它回来才发现白改
  if (hashIdeaNoteContent(raw) !== expectedHash) {
    logSkip(rel, title);
    return skippedResult(rel, title);
  }
  // 已经取消就别再启动一次模型调用（少浪费一次二十秒的补全）
  if (aborted()) return failedResult(rel, title, 'error', CANCELLED_ERROR);

  onProgress(IDEA_DISTILL_STAGES.fix, title);
  let drafted: IdeaNoteDraft;
  try {
    // 送进去的是正文（frontmatter 不参与改写）：原始资料没有一级标题，正文就是全部内容
    drafted = await runDraft(splitFrontmatter(raw).body.trim());
  } catch (error: any) {
    console.warn(`[ideaDistill] 提炼失败，原文原样保留：${error?.message || error}`);
    return failedResult(rel, title, 'error', '提炼出错了，已按原文记下');
  }

  // 模型跑的这段时间里任务可能被取消（withJobsStopped / 用户取消）：到这一步就停，
  // 一个字都不写——否则维护清理完的数据会被这条迟到的任务又写回来
  if (aborted()) return failedResult(rel, title, 'error', CANCELLED_ERROR);

  // 没接模型（或模型不可用）时 draftIdeaNote 退化成规则标题——不算「提炼完成」：
  // 报 failed 前端才有「再试一次」入口，而原文一个字都没动
  if (drafted.titleSource === 'heuristic') {
    return failedResult(rel, title, drafted.refined.reason ?? 'no-model', '没接模型，已按原文记下', drafted.refined.reason);
  }

  // 第二次比对：模型跑的这十几秒里用户可能已经手改过。必须在**任何写操作之前**——
  // 改名也算写（renamePageSafely 会重写 frontmatter），先改名再发现不一致就晚了
  if (hashIdeaNoteFile(rel) !== expectedHash) {
    logSkip(rel, title);
    return skippedResult(rel, title);
  }

  onProgress(IDEA_DISTILL_STAGES.refine, summarizeRefine(drafted.refined) || '按勘误稿保留');
  onProgress(IDEA_DISTILL_STAGES.title, drafted.title);

  let finalPath = rel;
  let finalTitle = title;
  const modelTitle = String(drafted.title ?? '').trim();
  if (page && modelTitle) {
    const desired = uniqueIdeaTitle(`${ideaFileDatePrefix(rel)}${ideaFileTitle(modelTitle)}`, rel);
    if (desired !== title) {
      try {
        // 原始资料的标题由文件名与 frontmatter 承载，正文本来就不写 H1，所以 syncH1: false
        const renamed = renamePageSafely(input.id, desired, { syncH1: false, allowSamePath: true });
        finalPath = renamed.path;
        finalTitle = renamed.title;
      } catch (error: any) {
        // 「标题未变化」= 模型拟出的标题与当前一致，不是错误：接着写正文
        const unchanged = error instanceof RenameError && error.message === '标题未变化';
        if (!unchanged) {
          console.warn(`[ideaDistill] 改名失败，原文原样保留：${error?.message || error}`);
          return failedResult(rel, title, 'error', '改名失败，已按原文记下');
        }
      }
    }
  }

  onProgress(IDEA_DISTILL_STAGES.write, finalPath);
  let written: PageMeta;
  try {
    written = writePage(finalPath, `${stripLeadingHeading(drafted.text).trim()}\n`, {});
  } catch (error: any) {
    console.warn(`[ideaDistill] 写入成品失败，原文原样保留：${error?.message || error}`);
    return failedResult(finalPath, finalTitle, 'error', '写入成品失败，已按原文保留');
  }
  finalTitle = written.title || finalTitle;

  // 索引与图谱边：writePage 内部已发 page-changed，这里只补队列（同 lib/ideaNote.ts 落盘路径）
  enqueuePagePipeline(input.id);
  try {
    appendWikiLog('灵感提炼', `「${finalTitle}」（${finalPath}）${summarizeFixes(drafted.fixes, drafted.pending, drafted.refined)}`);
  } catch { /* 日志失败不阻塞 */ }

  return {
    staged: 'done',
    path: finalPath,
    title: finalTitle,
    fixes: drafted.fixes.map((fix) => ({ wrong: fix.wrong, right: fix.right, kind: fix.kind ?? null })),
    pending: drafted.pending,
    refined: drafted.refined,
  };
}
