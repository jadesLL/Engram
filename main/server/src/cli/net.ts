import net from 'node:net';

/**
 * 服务端出网校验共用的 IP 判定（lib/imageFetch、lib/inboxWebFetch 使用）。
 *
 * 远程单文件 CLI 不能有相对导入，所以 CLI 的出网层（含本函数）已内联进 cli/cli.ts；
 * 本模块只保留服务端侧复用的这一份。改这里的判定时必须同步 cli/cli.ts 的内联副本
 * （cli/cli.test.ts 有两者一致性断言）。
 */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;               // 环回 / 私网A / 保留
    if (a === 172 && b >= 16 && b <= 31) return true;                // 私网B
    if (a === 192 && b === 168) return true;                         // 私网C
    if (a === 169 && b === 254) return true;                         // 链路本地（含云元数据）
    if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT
    if (a === 192 && ((b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99))) return true;
    if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;                                       // 组播/保留
    return false;
  }
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  // 仅允许全球单播 2000::/3，也挡住 IPv4 映射、环回、ULA、链路本地、组播与 NAT64。
  if (!/^[23][0-9a-f]{3}:/.test(lower)) return true;
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true; // 文档地址
  if (lower.startsWith('2001:0:') || lower.startsWith('2002:')) return true; // Teredo / 6to4
  return false;
}
