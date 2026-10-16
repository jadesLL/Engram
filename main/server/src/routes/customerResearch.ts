import type { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { AgentNotConfiguredError, cancelRun } from '../assistant/runner.js';
import { getRun } from '../assistant/repository.js';
import { customerResearchRules, customerResearchTasks, startBuiltinCustomerResearch, updateCustomerResearchRules, CustomerResearchError } from '../research/customerResearch.js';

export async function customerResearchRoutes(app: FastifyInstance) {
  // Android forwards these task operations with its existing sync member token.
  app.addHook('preHandler', requireAssistantAccess);
  app.get('/api/customer-research', async () => ({ tasks: customerResearchTasks(), rules: customerResearchRules() }));
  app.put('/api/customer-research/rules', async (req, reply) => {
    try { return updateCustomerResearchRules(req.body); }
    catch (e) { if (e instanceof CustomerResearchError) return reply.code(e.status).send({ error: e.message }); throw e; }
  });
  app.post('/api/customer-research', async (req, reply) => {
    try { return reply.code(202).send(await startBuiltinCustomerResearch(req.body as any)); }
    catch (e) { if (e instanceof CustomerResearchError || e instanceof AgentNotConfiguredError) return reply.code(e.status).send({ error: e.message }); throw e; }
  });
  app.post('/api/customer-research/stop', async (req, reply) => {
    const id = (req.body as any)?.taskId;
    const task = customerResearchTasks().find(t => t.id === id);
    if (!task?.runId || !getRun(task.runId)) return reply.code(400).send({ error: '没有可停止的内置调研任务' });
    return { stopped: await cancelRun(task.runId) };
  });
}
