import type { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { ensureVideoProviderSeeded } from '../assistant/videoModelDefaults.js';
import { applyVideoConfigInput, videoConfigForClient, videoConfigStatus } from '../lib/videoConfig.js';
import { requestOrigin } from '../lib/requestOrigin.js';
import { stampPreference } from '../sync/preferences.js';
import { currentNodeId } from '../sync/store.js';
import { recordLocalChange } from '../sync/index.js';

/**
 * 视频理解模型的独立读写口（v1.5.1 起，2026-11 改为 DSH 模型配置）。
 *
 * 为什么从通用 /api/settings 拆出来：
 *  - 手机（Android 本地服务）只持同步成员令牌，需要把「视频理解模型」的配置经中枢
 *    窄代理到手机的 设置 → Agent 与自动化 → 视频理解模型；
 *  - 通用设置面还包含 DDNS Token 等 owner 级配置，不能整体对成员令牌开放；
 *  - 所以单独开一条只认 video_config 的窄接口，其余键一概不读不写。
 *
 * 2026-11 起这里只维护「是否启用」：模型与 Key 复用内置 Agent 控制台的 dsh 模型配置
 * （见 lib/videoModel.ts）。GET 会顺带幂等播种默认 DashScope 提供商（用户只需去控制台填
 * 一个 API Key），并把解析到的模型状态一起返回给面板展示。
 *
 * 鉴权：requireAssistantAccess —— owner 登录态 / MCP token / 同步成员令牌（手机）都可。
 * 读：不回显任何 API Key（只有 hasKey）；写：只认 enabled，旧客户端的 baseUrl/apiKey/model 字段忽略。
 */
export async function videoConfigRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAssistantAccess);

  app.get('/api/settings/video-config', async (req) => {
    // 默认提供商播种：已播种/已有提供者时零成本返回；控制台没起来时把原因带回面板（不阻塞读）
    const seed = await ensureVideoProviderSeeded(requestOrigin(req));
    const status: Record<string, unknown> = { ...videoConfigStatus() };
    if (!seed.ok) status.seedError = seed.error || '默认提供商未就绪';
    return {
      settings: { video_config: videoConfigForClient() },
      status,
    };
  });

  app.put('/api/settings/video-config', async (req) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const { changed } = applyVideoConfigInput(body['video_config']);
    if (changed) {
      stampPreference('video_config', currentNodeId());
      recordLocalChange('preference', 'video_config');
    }
    // 打开开关时顺手补一次播种（幂等；失败不影响保存，面板下次 GET 会再试）
    if (changed) await ensureVideoProviderSeeded(requestOrigin(req)).catch(() => null);
    return { ok: true };
  });
}
