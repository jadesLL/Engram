import { FastifyInstance } from 'fastify';
import { requireAuth } from './auth.js';
import { closeAllRuntimes } from '../assistant/dshRuntime.js';
import { stopConsole } from '../assistant/agentConsole.js';
import {
  cancelPythonRuntimeInstall,
  pythonRuntimeStatus,
  startPythonRuntimeInstall,
} from '../lib/pythonRuntime.js';

/**
 * 设置 → 外设接入（以及所有需要 Python 的接入）共用的「Python 运行时」管理面。
 *
 * 为什么不把这些接口挂在 doxent 下面：运行时是 Engram 级共享资产（一份解释器供给所有
 * Python 技能 / 官方客户端），办公本只是第一个使用者；新增使用方时直接复用 GET / install /
 * cancel，不需要再复制一套下载逻辑。
 *
 * 权限：下载/解压会在本机落文件，属于 owner 级管理面（与「外部接入」一致，手机令牌不可用）。
 */
export async function pythonRuntimeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** 运行时状态（含下载进度）；设置页在下载期间轮询这个接口 */
  app.get('/api/settings/python-runtime', async () => ({ runtime: await pythonRuntimeStatus() }));

  /**
   * 下载并安装共享运行时：后台任务，202 立即返回当前状态。
   * 安装完成后回收 Agent 运行时 / 停止内置 Agent 控制台，让新解释器进入 PATH 后下次启动生效。
   */
  app.post('/api/settings/python-runtime/install', async (_req, reply) => {
    try {
      const runtime = await startPythonRuntimeInstall({
        onInstalled: () => {
          try {
            closeAllRuntimes();
          } catch (error) {
            console.warn('[python] 关闭聊天运行时失败（下次对话仍会重开）', error);
          }
          try {
            stopConsole();
          } catch (error) {
            console.warn('[python] 停止内置 Agent 控制台失败（下次打开会重开）', error);
          }
        },
      });
      return reply.code(202).send({ ok: true, runtime });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** 取消下载 / 解压；已失败的记录也一并清掉，便于直接重试 */
  app.post('/api/settings/python-runtime/cancel', async () => ({
    ok: true,
    runtime: await cancelPythonRuntimeInstall(),
  }));
}
