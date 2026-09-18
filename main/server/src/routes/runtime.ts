import type { FastifyInstance } from 'fastify';

/**
 * 前端运行能力协商。服务端/桌面端默认具备完整能力；Android 本地引擎提供同形接口，
 * 但只开放本地知识管理和 member 同步。前端请求失败时仍按 full 能力回退，兼容旧服务。
 */
export async function runtimeRoutes(app: FastifyInstance) {
  app.get('/api/runtime/capabilities', async () => ({
    runtime: process.env.ENGRAM_DESKTOP === '1' ? 'desktop' : 'server',
    localFirst: process.env.ENGRAM_DESKTOP === '1',
    syncRoles: ['none', 'hub', 'member'],
    features: {
      agent: true,
      mcp: true,
      jobs: true,
      onlyOffice: Boolean(process.env.ONLYOFFICE_URL),
      serverUpdate: true,
      ddns: true,
      backup: true,
      fileExtraction: true,
    },
  }));
}
