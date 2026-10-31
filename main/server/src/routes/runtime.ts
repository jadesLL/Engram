import type { FastifyInstance } from 'fastify';
import { officeConfigured } from '../office/service.js';
import { isDesktopMode } from '../lib/runtimeMode.js';

/**
 * 前端运行能力协商。服务端/桌面端默认具备完整能力；Android 本地引擎提供同形接口，
 * 但只开放本地知识管理和 member 同步。前端请求失败时仍按 full 能力回退，兼容旧服务。
 */
export async function runtimeRoutes(app: FastifyInstance) {
  app.get('/api/runtime/capabilities', async () => {
    const desktop = isDesktopMode();
    return {
      runtime: desktop ? 'desktop' : 'server',
      localFirst: desktop,
      agentMode: 'local',
      nativeActions: [],
      syncRoles: ['none', 'hub', 'member'],
      features: {
        agent: true,
        agentAdmin: true,
        // v1.5.1：手机（Android 本地服务）绑定中枢后，经成员令牌把「内置 Agent 控制台」与
        // 「视频理解模型」的配置窄代理到中枢，所以这两个能力位对手机也放开；agentAdmin
        // 仍保持 false（手机不跑 dsh，也不直接持有模型 Key）。
        agentConsole: true,
        videoConfig: true,
        mcp: true,
        jobs: true,
        onlyOffice: officeConfigured(),
        serverUpdate: true,
        ddns: true,
        backup: true,
        fileExtraction: true,
      },
    };
  });
}
