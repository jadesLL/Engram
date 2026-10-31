import type { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { stampPreference } from '../sync/preferences.js';
import { currentNodeId } from '../sync/store.js';
import { recordLocalChange } from '../sync/index.js';
import { applyVideoConfigInput, videoConfigForClient } from '../lib/videoConfig.js';

/**
 * 视频理解模型的独立读写口（v1.5.1 起）。
 *
 * 为什么从通用 /api/settings 拆出来：
 *  - 手机（Android 本地服务）只持同步成员令牌，需要把「视频理解模型」的配置经中枢
 *    窄代理到手机的 设置 → Agent 与自动化 → 视频理解模型；
 *  - 通用设置面还包含 DDNS Token 等 owner 级配置，不能整体对成员令牌开放；
 *  - 所以单独开一条只认 video_config 的窄接口，其余键一概不读不写。
 *
 * 鉴权：requireAssistantAccess —— owner 登录态 / MCP token / 同步成员令牌（手机）都可。
 * 读：永远脱敏（apiKey 只回 hasKey，见 /api/inbox/video-status）；写：空 Key = 保留原值，
 * apiKey:null = 显式清除，避免手机端留空保存把中枢的 Key 冲掉。
 */
export async function videoConfigRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAssistantAccess);

  app.get('/api/settings/video-config', async () => ({
    settings: { video_config: videoConfigForClient() },
  }));

  app.put('/api/settings/video-config', async (req) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const { changed } = applyVideoConfigInput(body['video_config']);
    if (changed) {
      stampPreference('video_config', currentNodeId());
      recordLocalChange('preference', 'video_config');
    }
    return { ok: true };
  });
}
