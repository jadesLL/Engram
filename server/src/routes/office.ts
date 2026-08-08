import path from 'node:path';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import {
  createEditorConfig,
  handleOfficeCallback,
  listOfficeVersions,
  resolveContentToken,
  restoreOfficeVersion,
} from '../office/service.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function officeRoutes(app: FastifyInstance) {
  app.get('/api/files/office-config', { preHandler: requireAuth }, async (req, reply) => {
    const { path: relPath } = req.query as { path?: string };
    if (!relPath) return reply.code(400).send({ error: '缺少 path' });
    try {
      return await createEditorConfig(relPath);
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes('尚未就绪') || message.includes('未启用') ? 503 : 400).send({ error: message });
    }
  });

  app.get('/api/files/office-content', async (req, reply) => {
    const { token } = req.query as { token?: string };
    if (!token) return reply.code(401).send({ error: '缺少 token' });
    try {
      const file = resolveContentToken(token);
      reply.header('Content-Type', file.mime);
      reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      return reply.send(fs.createReadStream(file.abs));
    } catch (error) {
      return reply.code(401).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/files/office-callback', async (req, reply) => {
    const { token } = req.query as { token?: string };
    if (!token) return reply.code(401).send({ error: 1 });
    try {
      return await handleOfficeCallback(token, req.body, req.headers as Record<string, unknown>);
    } catch (error) {
      app.log.error({ err: error }, 'ONLYOFFICE callback failed');
      return reply.code(400).send({ error: 1, message: errorMessage(error) });
    }
  });

  app.get('/api/files/office-versions', { preHandler: requireAuth }, async (req, reply) => {
    const { path: relPath } = req.query as { path?: string };
    if (!relPath) return reply.code(400).send({ error: '缺少 path' });
    try {
      return { versions: listOfficeVersions(relPath) };
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/files/office-versions/:id/restore', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!id || path.basename(id) !== id) return reply.code(400).send({ error: '版本 id 无效' });
    try {
      return await restoreOfficeVersion(id);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });
}
