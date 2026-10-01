import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { requireAssistantAccess } from '../assistant/access.js';
import { draftIdeaNote, writeIdeaNote, type IdeaNoteDraft } from '../lib/ideaNote.js';
import { hashIdeaNoteFile, type IdeaDistillResult } from '../lib/ideaDistill.js';
import { enqueueIdeaDistill, findIdeaDistillJob, type IdeaDistillJobRow } from '../jobQueue.js';
import { rawSectionOf } from '../lib/rawSections.js';

/** 单条灵感正文上限：对话框里随手写；到这个量级该走「新建资料」而不是速记 */
const MAX_IDEA_CHARS = 20_000;
/** 调用方回传摘要的长度上限：它只进操作日志一行，够写清「改了哪几处、精炼了多少字」即可 */
const MAX_NOTE_CHARS = 200;
/** 落盘兜底标题：用户按下就记下，真正的标题由后台提炼拟 */
const FALLBACK_IDEA_TITLE = '随手记';

/** `GET /api/ideas/:id/distill` 的响应（除 ok 之外的部分）：字段口径见 SPEC 2.2 */
export interface IdeaDistillStatePayload {
  staged: 'unknown' | 'pending' | 'running' | 'done' | 'skipped-edit' | 'failed';
  jobId: number | null;
  jobStatus: string | null;
  title: string;
  path: string;
  /** 是否已有润色稿落地（done 时 true） */
  distilled: boolean;
  fixes: { wrong: string; right: string; kind: string | null }[];
  pending: string[];
  refined: { applied: boolean; before: number; after: number; reason?: string } | null;
  error: string | null;
  reason: string | null;
}

export interface IdeaRouteDeps {
  /** 仅供测试注入：预览接口的「正文 → 标题 + 勘误与精炼后的正文」（默认走 lib/ideaNote.ts 的链路） */
  draftNote?: (content: string) => Promise<IdeaNoteDraft>;
}

/** 正文校验：空与超长是接口级错误，落盘与预览共用同一套口径 */
function ideaContent(raw: unknown): { text: string } | { error: string; code: 400 | 413 } {
  const text = String(raw ?? '').trim();
  if (!text) return { error: '还没有写内容', code: 400 };
  if (text.length > MAX_IDEA_CHARS) {
    return { error: `这条灵感有 ${text.length} 字，太长记不下，请改用「新建资料」`, code: 413 };
  }
  return { text };
}

/** 调用方回传的摘要（老预览流程的勘误/精炼明细）：单行化、去自带括号、截断，再套上括号 */
function ideaNoteSuffix(raw: unknown): string {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[（(]+/, '')
    .replace(/[）)]+$/, '')
    .trim()
    .slice(0, MAX_NOTE_CHARS);
  return text ? `（${text}）` : '';
}

/** 展示用标题：原始资料的文件名带 `YYYY.MM.DD_` 前缀，界面/toast 里不需要 */
function displayTitle(pageTitle: string): string {
  return String(pageTitle ?? '').replace(/^\d{4}\.\d{2}\.\d{2}_/, '');
}

/**
 * 只有 `原始资料/灵感碎片/` 下的页面才是灵感。
 * 状态查询与重新提炼走成员令牌就能调（内容面公开入口），不能拿它当「任意页面存不存在」的探针；
 * 分类口径统一走 lib/rawSections.ts 的 rawSectionOf（别在这里写目录字面量）。
 */
function isIdeaNotePath(rel: string | null | undefined): boolean {
  return rawSectionOf(rel) === 'idea';
}

/**
 * 把「页面 + 最近的提炼任务」翻成 SPEC 2.2 的状态。纯函数：路由只负责取数据，
 * 六种 staged 的映射集中在这里，单测直接调用即可。
 *
 * `cancelled` 对用户来说和 failed 是一回事（这次没提炼成、原文都在）——数据维护会成批取消任务，
 * 归到 failed 至少让成品页有「重新提炼」可按，比落在 unknown 强。
 */
export function ideaDistillState(
  page: { path: string; title: string } | null,
  job: IdeaDistillJobRow | null
): IdeaDistillStatePayload {
  if (!page || !job) {
    return {
      staged: 'unknown',
      jobId: null,
      jobStatus: null,
      title: '',
      path: '',
      distilled: false,
      fixes: [],
      pending: [],
      refined: null,
      error: null,
      reason: null,
    };
  }

  // 任务收尾时把提炼结果回填进 payload.result（见 jobQueue.saveIdeaDistillResult）：
  // staged 要靠它区分 done 与 skipped-edit，前端通知里的明细也从这里来
  const result = (job.payload?.result ?? null) as IdeaDistillResult | null;
  const staged: IdeaDistillStatePayload['staged'] =
    job.status === 'pending' || job.status === 'paused'
      ? 'pending'
      : job.status === 'running'
        ? 'running'
        : job.status === 'done'
          ? result?.staged === 'skipped-edit'
            ? 'skipped-edit'
            : 'done'
          : 'failed';

  return {
    staged,
    jobId: job.id,
    jobStatus: job.status,
    // 展示口径与 POST 一致：原始资料的页面标题带 `YYYY.MM.DD_` 前缀，
    // 通知里的《标题》不该把它念出来（成品页展示也在做同一件事）
    title: displayTitle(page.title),
    path: page.path,
    distilled: staged === 'done',
    fixes: Array.isArray(result?.fixes)
      ? result.fixes.map((fix) => ({ wrong: fix.wrong, right: fix.right, kind: fix.kind ?? null }))
      : [],
    pending: Array.isArray(result?.pending) ? result.pending.map((item) => String(item)) : [],
    refined: result?.refined ?? null,
    error: staged === 'failed' ? result?.error || job.error || '提炼没有完成，原文已经保留' : null,
    reason: staged === 'failed' ? result?.reason ?? 'error' : staged === 'skipped-edit' ? result?.reason ?? 'edited' : null,
  };
}

/**
 * 记一条灵感。新语义（2026-10）：**按下就落盘**，勘误/精炼/拟标题交给后台的 idea_distill 任务，
 * 完成后再通知用户去看成品。旧语义（等模型拟好标题、让用户确认后落盘）留在下面的兼容分支里。
 *
 * 为什么改：模型这一环会失败（没凭据、超时、网关抽风），旧流程里这些都会让「记一条灵感」整个失败——
 * 用户写下的东西丢在半路。现在原文先落 `原始资料/灵感碎片/YYYY.MM.DD_随手记.md`，
 * 提炼失败也只是标题朴素一点，内容一个字都不少。
 *
 * 三条路的分工（按请求体区分，不看前端版本）：
 *  - 不带 `title`：新语义——落盘 + 入队，立即返回 jobId；
 *  - 带 `title`（哪怕是空串）：老客户端 / 手机端窄代理 / 脚本——落盘即所见即所得，不入队；
 *  - `/api/ideas/preview`：**仅供脚本与过渡**保留，前端已不再调用（新流程不需要用户确认这一步）。
 */
export async function ideaRoutes(app: FastifyInstance, deps: IdeaRouteDeps = {}) {
  // 手机端（Android 本地服务）只有同步成员令牌，却要能用「记一条灵感」——它与收集箱同属内容面，
  // 走 requireAssistantAccess（成员 token 或 owner / MCP token），不再是仅 owner 的 requireAuth。
  app.addHook('preHandler', requireAssistantAccess);

  const draft = deps.draftNote ?? draftIdeaNote;

  /** 预览：勘误 + 精炼 + 拟标题，但不落盘（**仅供脚本与过渡**，前端已改走后台提炼） */
  app.post('/api/ideas/preview', async (req, reply) => {
    const checked = ideaContent(((req.body ?? {}) as { content?: unknown }).content);
    if ('error' in checked) return reply.code(checked.code).send({ error: checked.error });

    const drafted = await draft(checked.text);
    return {
      ok: true,
      title: drafted.title,
      titleSource: drafted.titleSource,
      text: drafted.text,
      fixes: drafted.fixes.map((fix) => ({ wrong: fix.wrong, right: fix.right, kind: fix.kind ?? null })),
      pending: drafted.pending,
      refined: drafted.refined,
    };
  });

  /**
   * 状态查询：前端轮询它弹「提炼完成」通知，成品页据此显示「提炼中 → 完成」。
   * 一条灵感从未提炼过（老数据、脚本路径）返回 `staged:'unknown'` 而不是 404——
   * 前端省一次异常分支，也免得把「没有提炼记录」当错误弹给用户。
   */
  app.get('/api/ideas/:id/distill', async (req) => {
    const id = String((req.params as { id?: string } | undefined)?.id ?? '');
    const page = db.prepare(`SELECT id, path, title FROM pages WHERE id = ? AND deleted = 0`).get(id) as
      | { id: string; path: string; title: string }
      | undefined;
    // 非灵感页面（Wiki 实体页、原始资料/文档 里的资料…）按「没有这条灵感」处理：
    // 字段全空仍是 200，保持「unknown 不报错」的契约，但也不泄漏其它页面的存在性
    const idea = page && isIdeaNotePath(page.path) ? page : null;
    // 按 id 找而不是按路径：提炼成功会改名，payload 里记的是改名前那条路径
    const job = idea ? findIdeaDistillJob({ id: idea.id }) : undefined;
    return { ok: true, ...ideaDistillState(idea, job ?? null) };
  });

  /**
   * 重新提炼（成品页的「重新提炼」按钮）：按当前磁盘内容重新入队一次。
   * 已在队列里（同 path 有 pending/running）就复用现有任务，前端接着跟踪同一个 jobId。
   */
  app.post('/api/ideas/:id/distill/retry', async (req, reply) => {
    const id = String((req.params as { id?: string } | undefined)?.id ?? '');
    const page = db.prepare(`SELECT id, path FROM pages WHERE id = ? AND deleted = 0`).get(id) as
      | { id: string; path: string }
      | undefined;
    // 与状态查询同一道范围限制：非灵感页面直接当作「这条灵感已经不在了」
    const idea = page && isIdeaNotePath(page.path) ? page : null;
    const hash = idea ? hashIdeaNoteFile(idea.path) : null;
    if (!idea || !hash) return reply.code(404).send({ error: '这条灵感已经不在了' });

    // reused=true：同 path 已有排队/在跑的任务，前端接着跟踪同一个 jobId，不要另起一条跟踪链
    const { jobId, reused } = enqueueIdeaDistill({
      id: idea.id,
      path: idea.path,
      hash,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, jobId, reused };
  });

  /**
   * 落盘。两种调用方式：
   *  - 带 title 字段（**哪怕是空串**）：老客户端 / 手机端窄代理 / 脚本——content 就是定稿，
   *    落盘即所见即所得，不入队提炼；空标题由 ideaFileTitle 退化成「随手记」；
   *  - 完全没有 title 字段：新语义——原文立刻落盘（兜底标题「随手记」），并入队后台提炼。
   * 按「字段在不在」而不是「值空不空」区分：老客户端清空标题时不该被当成新语义再跑一遍提炼。
   */
  app.post('/api/ideas', async (req, reply) => {
    const body = (req.body ?? {}) as { content?: unknown; title?: unknown; note?: unknown };
    const checked = ideaContent(body.content);
    if ('error' in checked) return reply.code(checked.code).send({ error: checked.error });

    if (typeof body.title === 'string') {
      const title = body.title.trim();
      const created = writeIdeaNote({ title, content: checked.text, note: ideaNoteSuffix(body.note) });
      // 回报用户确认过的标题（不带日期前缀），toast 直接用它；空标题时用落盘实际用的那个
      const shown = title || displayTitle(created.pageTitle);
      return { ok: true, ...created, title: shown };
    }

    const created = writeIdeaNote({ title: FALLBACK_IDEA_TITLE, content: checked.text, note: '' });
    // hash 取**落盘后**磁盘上的完整内容（含 frontmatter）：后台任务是靠它判断用户有没有手改的。
    // 读不到（磁盘异常）时仍然算记下了——内容已在文件里，只是这次不排提炼，别把失败甩给用户。
    const hash = hashIdeaNoteFile(created.path);
    const jobId = hash
      ? enqueueIdeaDistill({ id: created.id, path: created.path, hash, createdAt: new Date().toISOString() }).jobId
      : null;
    return {
      ok: true,
      id: created.id,
      path: created.path,
      // 兜底标题只用于界面占位（同名加序号时会是「随手记 (2)」这种），**不是权威标题**：
      // 提炼完成后由后台任务改名（payload 里的 id/path 才是这条灵感的身份）
      title: displayTitle(created.pageTitle),
      jobId,
      distilling: jobId !== null,
    };
  });
}
