import { dockerSocketAvailable } from './dockerSocket.js';

/** 桌面端壳内运行（Electron fork，无法重建容器，但也参与版本检测/提示） */
export function isDesktopMode(): boolean {
  return Boolean(process.env.ENGRAM_APP_VERSION && !dockerSocketAvailable()) || Boolean(process.env.ENGRAM_WEB_DIST && process.env.HOST === '127.0.0.1');
}
