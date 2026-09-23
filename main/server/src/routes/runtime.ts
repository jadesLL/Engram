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
