import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import {
  BEAUTIFY_MAX_DOCUMENT,
  EDITOR_AI_MAX_AFTER,
  EDITOR_AI_MAX_BEFORE,
  EDITOR_AI_MAX_INSTRUCTION,
  EDITOR_AI_MAX_SELECTION,
  EDITOR_AI_TASKS,
  beautifyDocument,
  buildEditorAiMessages,
  cleanEditorAiOutput,
  resolveEditorModelConfig,
  validateBeautified,
  type EditorAiTask,
} from '../lib/editorAi.js';
import {
  completeText,
  ModelCapabilityError,
  ModelEmptyResponseError,
  ModelOutputTruncatedError,
  ModelUnavailableError,
} from '../lib/modelClient.js';

/**
 * 编辑页「就地 AI」的唯一入口。
 *
 * 一次请求 = 一次补全：不在服务端保存草稿、不写文件、不碰页面版本。正文由前端在应用
 * 结果时通过既有的 PUT /api/pages/:id 落盘，保存状态、SSE 回声与撤销栈都走原通道。
 */
export async function editorAiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/editor/ai', async (req, reply) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const task = String(body.task || '') as EditorAiTask;
    if (!(EDITOR_AI_TASKS as readonly string[]).includes(task)) {
      return reply.code(400).send({ error: '不支持的 AI 编辑动作' });
    }
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    const selection = typeof body.selection === 'string' ? body.selection : '';
    const before = typeof body.before === 'string' ? body.before : '';
    const after = typeof body.after === 'string' ? body.after : '';
    const document = typeof body.document === 'string' ? body.document : '';

    if (instruction.length > EDITOR_AI_MAX_INSTRUCTION) {
      return reply.code(400).send({ error: `要求太长了：请控制在 ${EDITOR_AI_MAX_INSTRUCTION} 字以内` });
    }
    if (selection.length > EDITOR_AI_MAX_SELECTION) {
      return reply.code(400).send({ error: `选中的文字太长（超过 ${EDITOR_AI_MAX_SELECTION} 字），请分段处理` });
    }
    if (before.length > EDITOR_AI_MAX_BEFORE * 4 || after.length > EDITOR_AI_MAX_AFTER * 4) {
      return reply.code(400).send({ error: '上下文过长' });
    }
    if (task === 'rewrite' && !selection.trim()) {
      return reply.code(400).send({ error: '没有选中要改写的文字' });
    }
    if (task === 'continue' && !selection.trim()) {
      return reply.code(400).send({ error: '请先选中要接着写的那段文字' });
    }
    if (task === 'beautify') {
      if (!document.trim()) return reply.code(400).send({ error: '页面还没有内容' });
      if (document.length > BEAUTIFY_MAX_DOCUMENT) {
        return reply.code(400).send({
          error: `页面太长（${document.length} 字，上限 ${BEAUTIFY_MAX_DOCUMENT} 字），请分节后再整理`,
        });
      }
    }

    const config = resolveEditorModelConfig();
    const input = { task, instruction, title, selection, before, after, document };

    try {
      if (task === 'beautify') {
        const result = await beautifyDocument(document, { config });
        const problem = validateBeautified(document, result.text);
        if (problem) return reply.code(422).send({ error: problem });
        return { text: result.text, chunks: result.chunks };
      }

      const maxTokens = task === 'rewrite'
        ? Math.min(8192, Math.max(2048, Math.ceil(selection.length * 1.6)))
        : 4096;
      const result = await completeText(buildEditorAiMessages(input), {
        maxTokens,
        temperature: task === 'rewrite' ? 0.3 : 0.6,
        timeoutMs: 180_000,
        config,
      });
      const text = cleanEditorAiOutput(result.text);
      if (!text) return reply.code(502).send({ error: '模型没有返回可用内容，请重试' });
      return { text, model: result.model };
    } catch (error: any) {
      if (error instanceof ModelUnavailableError) {
        return reply.code(503).send({
          error: '内置 Agent 还没配置模型密钥：请到 设置 → Agent 与自动化 → 内置 Agent 控制台 → 设置 → 模型 填写 API 密钥',
        });
      }
      if (error instanceof ModelOutputTruncatedError) {
        return reply.code(422).send({
          error: task === 'beautify'
            ? '整理结果达到模型输出上限，请分节后再试'
            : '模型输出达到上限，请缩短要求或选中文字后重试',
        });
      }
      if (error instanceof ModelCapabilityError) {
        return reply.code(422).send({ error: error.message });
      }
      if (error instanceof ModelEmptyResponseError) {
        return reply.code(502).send({ error: '模型没有返回内容，请重试' });
      }
      req.log.error({ err: error }, '编辑器 AI 请求失败');
      return reply.code(502).send({ error: `AI 请求失败：${error?.message || '未知错误'}` });
    }
  });
}
