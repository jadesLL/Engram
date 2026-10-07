import fs from 'node:fs';
import os from 'node:os';
import { docker, dockerSocketAvailable } from './dockerSocket.js';

/** 生产镜像更新会继承旧 Env，不能仅依赖旧 OFFICE_EDITOR_ENABLED=true/false。 */
export function dockerOfficeRetired(inContainer = fs.existsSync('/.dockerenv'), nodeEnv = process.env.NODE_ENV): boolean {
  return inContainer && nodeEnv === 'production';
}

type Engine = Pick<typeof docker, 'inspectContainer' | 'stopContainer' | 'removeContainer'>;

/** 只处理本应用同一 Compose 项目的旧 sidecar；不删除任何数据卷。 */
export async function retireLegacyDockerOffice(options: {
  retired?: boolean; socket?: boolean; selfId?: string; engine?: Engine;
} = {}): Promise<boolean> {
  if (!(options.retired ?? dockerOfficeRetired()) || !(options.socket ?? dockerSocketAvailable())) return false;
  const engine = options.engine ?? docker;
  const self = await engine.inspectContainer(options.selfId ?? os.hostname());
  if (!self || self.Config.Labels?.['com.engram.feature']) return false;
  const office = await engine.inspectContainer('engram-onlyoffice');
  if (!office || !/^onlyoffice\/documentserver(?::|@|$)/.test(office.Config.Image)) return false;
  const project = self.Config.Labels?.['com.docker.compose.project'];
  if (!project || office.Config.Labels?.['com.docker.compose.project'] !== project ||
      office.Config.Labels?.['com.docker.compose.service'] !== 'onlyoffice') return false;
  if (office.State?.Running) await engine.stopContainer(office.Id);
  await engine.removeContainer(office.Id, false, false);
  return true;
}
