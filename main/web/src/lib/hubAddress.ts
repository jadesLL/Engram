/**
 * 中枢「成员绑定地址」的前端口径：消费 `/api/sync/hub-addresses`，把事实翻译成人话。
 *
 * 服务端只说事实——哪些地址可用、哪些回环被剔除、本机服务监听的是回环还是全网卡；
 * 文案留在这里（可单测，也和设置页其他提示同源）。核心纪律与后端一致：
 * **127.0.0.1 永远不作为成员绑定地址出现**——它只对中枢自己有意义，别的设备填了连不上
 * （桌面版默认只监听回环，旧界面直接把 `location.origin` 抄给用户，就是这个 bug 的来源）。
 */

export interface HubAddressEntry {
  url: string;
  kind: 'lan' | 'public';
  /** env=部署侧声明 / bind=本机监听地址 / auto=网卡探测 / ddns / direct / origin=当前访问地址 */
  source: string;
  label: string;
  iface?: string;
}

export interface HubAddressReport {
  bindHost: string;
  /** loopback=只监听本机（桌面版默认），lan=局域网可达 */
  bindScope: 'loopback' | 'lan';
  port: number;
  addresses: HubAddressEntry[];
  /** 被剔除的回环地址（含设置页自己的 origin） */
  skippedLoopback: string[];
  containerized: boolean;
}

/** 可用的成员绑定地址（没有报告时为「还没有结果」，界面不该据此说「不可用」） */
export function bindingAddresses(report: HubAddressReport | null | undefined): HubAddressEntry[] {
  if (!report || !Array.isArray(report.addresses)) return [];
  return report.addresses;
}

/** 主地址：清单里的第一条（服务端已按「局域网 → 公网」排好） */
export function primaryBindingAddress(report: HubAddressReport | null | undefined): string {
  return bindingAddresses(report)[0]?.url || '';
}

/**
 * 一条都没有时该说什么（有地址就返回空串：正常态不需要解释）。
 * `desktop` 为真时补一句「怎么开」——桌面端有「允许局域网访问」开关可点。
 */
export function hubAddressNotice(report: HubAddressReport | null | undefined, opts: { desktop?: boolean } = {}): string {
  if (!report) return '';
  if (bindingAddresses(report).length) return '';
  if (report.bindScope === 'loopback') {
    const head = '本机服务当前只监听 127.0.0.1（只有这台电脑能连），因此没有能给别的设备用的地址。';
    return opts.desktop
      ? `${head}要把这台电脑当同步中枢，请打开下面的「允许局域网访问」——本地服务会以 0.0.0.0 重启，这里随后会列出局域网地址。`
      : `${head}请用 Docker / NAS 版担任中枢，或让本机服务监听局域网地址后再回来。`;
  }
  if (report.containerized) {
    return '容器里看到的是 Docker 内网网段（172.x），成员连不上，因此不做自动探测：'
      + '请在部署侧的 compose/.env 里声明对外地址，例如 LAN_ACCESS_URL=http://192.168.31.100:18080。';
  }
  return '没有检测到局域网地址：确认这台机器已连上路由器/交换机（有线或 Wi-Fi），网卡没有被禁用。';
}

/** 回环地址被剔除时的一句说明（没有剔除就返回空串）：让用户明白「为什么不再是 127.0.0.1」 */
export function hubSkippedNotice(report: HubAddressReport | null | undefined): string {
  const skipped = report?.skippedLoopback || [];
  if (!skipped.length) return '';
  return `已忽略 ${skipped.join('、')}：它是本机回环地址，只在这台设备内有效，别的设备填了连不上。`;
}
