/**
 * 中枢侧：本机在同一局域网内可达的地址（供 /api/sync/announce 通告给成员端）。
 *
 * 与 DIRECT_ACCESS_URL（公网直连域名）是两回事：这里是内网直连，只在同网段有意义；
 * 成员端探不到就自动降级为主地址，不会因此变得不可用。
 *
 * Docker 注意：容器里 os.networkInterfaces() 看到的是 172.x 容器网段，不是宿主机的
 * 192.168.x，而容器内 PORT（8080）往往也不是宿主映射端口（常见 18080）。所以部署侧
 * 可以用 LAN_ACCESS_URL 显式声明（多个用逗号/空格分隔）与 LAN_PORT 覆盖端口。
 */
import os from 'node:os';
import { PORT } from '../config.js';
import { pickLanUrls, type NetworkInterfaces } from './link.js';

export function localLanUrls(): string[] {
  const extra = (process.env.LAN_ACCESS_URL || '').split(/[\s,;]+/);
  const port = Number(process.env.LAN_PORT || '') || PORT;
  return pickLanUrls(os.networkInterfaces() as NetworkInterfaces, port, extra);
}
