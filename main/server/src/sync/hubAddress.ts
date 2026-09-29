/**
 * 中枢「成员该填哪个地址」的唯一算法（设置页「同步群组」与 /api/sync/hub-addresses 用它）。
 *
 * 起因（用户报的 bug）：中枢设置页原来把 `location.origin` 当成成员绑定地址展示与复制。
 * 桌面版（Windows exe）的内嵌服务只监听 127.0.0.1，页面永远开在 http://127.0.0.1:18180 上，
 * 于是**中枢给别人看的地址永远是 127.0.0.1**——填到手机或另一台电脑上必然连不上；
 * 电脑上用浏览器打开 Docker 版的 127.0.0.1:18080 也一样。
 *
 * 本模块只回答一个问题：这台中枢上，别的设备**真的能连上**的地址有哪些。三条纪律：
 *  1. 回环地址（127.0.0.0/8、::1、localhost）永不入列——它只对本机有意义；
 *  2. 服务只监听回环时不给出任何地址（配了也连不上），由界面引导用户开启局域网访问；
 *  3. 容器里不做网卡自动探测（看到的是 172.x 容器网段），只认部署侧声明的 LAN_ACCESS_URL。
 *
 * 纯逻辑：不读数据库、不发请求，网卡、环境变量与浏览器 origin 都由调用方传入，便于单测。
 */
import fs from 'node:fs';
import os from 'node:os';
import { dockerSocketAvailable } from '../lib/dockerSocket.js';
import {
  isLoopbackHost,
  isLoopbackUrl,
  isPrivateHost,
  isWildcardHost,
  lanIfaceCandidates,
  normalizeBase,
  type NetworkInterfaces,
} from './link.js';

/** 地址类别：局域网内 / 需要走公网 */
export type HubAddressKind = 'lan' | 'public';

/** 这条地址是哪来的：部署侧声明 / 监听地址 / 网卡自动探测 / DDNS 域名 / 公网直连 / 浏览器当前地址 */
export type HubAddressSource = 'env' | 'bind' | 'auto' | 'ddns' | 'direct' | 'origin';

export interface HubAddressEntry {
  url: string;
  kind: HubAddressKind;
  source: HubAddressSource;
  /** 展示用标签，如「局域网 · WLAN」「公网直连域名」 */
  label: string;
  /** 网卡名（source=auto 时才有）：多张网卡时帮用户认出该用哪张 */
  iface?: string;
}

export interface HubAddressEnv {
  /** 部署侧显式声明的局域网地址（多个用逗号/空格分隔），容器部署必须靠它 */
  LAN_ACCESS_URL?: string;
  /** 用网卡地址拼 URL 时的端口（容器内 PORT 不是宿主映射端口） */
  LAN_PORT?: string;
  /** 部署侧声明的公网直连地址（/health 也通告这一条） */
  DIRECT_ACCESS_URL?: string;
}

export interface HubAddressInput {
  /** 服务实际监听地址（config.HOST）：127.0.0.1=只本机，0.0.0.0/具体 IP=对外可达 */
  bindHost: string;
  /** 监听端口（容器内是容器端口） */
  port: number;
  ifaces?: NetworkInterfaces;
  env?: HubAddressEnv;
  /** 设置页自己的 origin：非回环时它本身就是一条可用地址（Docker 部署常用局域网 IP 打开） */
  origin?: string;
  /** DDNS 已启用时的直连域名（如 home.xxx.com） */
  ddnsHost?: string;
  /** 是否跑在容器里（默认按 inContainer() 判定） */
  containerized?: boolean;
}

export interface HubAddressReport {
  bindHost: string;
  /** loopback=只有本机能连（桌面版默认），lan=局域网/公网可达 */
  bindScope: 'loopback' | 'lan';
  port: number;
  /** 成员可以直接填写的地址（已剔除回环；bindScope=loopback 时为空） */
  addresses: HubAddressEntry[];
  /** 被剔除的回环地址（含设置页自己的 origin）：界面据此解释「为什么不是 127.0.0.1」 */
  skippedLoopback: string[];
  containerized: boolean;
}

/**
 * 是否跑在容器里。
 *
 * 容器里的 os.networkInterfaces() 是 172.x 的 Docker 网段（宿主机上根本不存在），自动探测
 * 只能得到成员连不上的地址，所以容器里不做自动探测，只认部署侧声明的 LAN_ACCESS_URL。
 * 线索两条：/.dockerenv（Docker 与多数 NAS 的容器都写这个文件）、docker.sock 已挂载。
 * 环境变量 ENGRAM_CONTAINER=1/0 可强制覆盖（自建运行时、host 网络部署等特殊场景）。
 */
export function inContainer(): boolean {
  const forced = String(process.env.ENGRAM_CONTAINER || '').trim();
  if (forced === '1') return true;
  if (forced === '0') return false;
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch {
    /* 读不到按非容器处理 */
  }
  return dockerSocketAvailable();
}

/** 默认 18080：本项目的标准宿主映射端口，与 DdnsSection 给的口径一致 */
const DEFAULT_PUBLIC_PORT = '18080';

/** 标签：类别 + 来源（界面一行一个，用户要一眼看懂「这条是给谁用的」） */
function labelOf(kind: HubAddressKind, source: HubAddressSource, iface?: string): string {
  if (source === 'origin') return '当前访问地址';
  if (source === 'ddns') return '公网直连域名';
  if (source === 'direct') return '公网直连地址';
  if (source === 'env') return kind === 'lan' ? '局域网（部署侧声明）' : '部署侧声明地址';
  if (source === 'bind') return '局域网（本机监听地址）';
  return iface ? `局域网 · ${iface}` : '局域网';
}

/** 地址拆分：逗号/分号/空白分隔（与 linkAnnounce 的 LAN_ACCESS_URL 口径一致） */
function splitUrls(raw: string): string[] {
  return String(raw || '').split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean);
}

/**
 * 算出「成员能连上这台中枢」的地址清单，局域网在前、公网在后。
 *
 * 排序即推荐顺序：部署侧声明 → 本机监听地址 → 网卡自动探测（真实网卡优先）→ DDNS 域名 /
 * 公网直连声明 → 设置页当前地址。同一条地址只出现一次。
 */
export function memberHubAddresses(input: HubAddressInput): HubAddressReport {
  const bindHost = String(input.bindHost || '').trim();
  const env = input.env || {};
  const port = Number(input.port) > 0 ? Math.trunc(Number(input.port)) : 0;
  const envPort = Number(env.LAN_PORT) > 0 ? Math.trunc(Number(env.LAN_PORT)) : port;
  const origin = normalizeBase(input.origin || '');
  const containerized = input.containerized ?? inContainer();
  const bindScope: 'loopback' | 'lan' = isLoopbackHost(bindHost) ? 'loopback' : 'lan';

  const lan: HubAddressEntry[] = [];
  const pub: HubAddressEntry[] = [];
  const skippedLoopback: string[] = [];
  const seen = new Set<string>();
  /** 界面要能解释「为什么不再显示 127.0.0.1」：被丢掉的回环地址单独记一份 */
  const noteLoopback = (url: string): void => {
    if (url && !skippedLoopback.includes(url)) skippedLoopback.push(url);
  };

  const add = (raw: string, source: HubAddressSource, label?: string): void => {
    const url = normalizeBase(String(raw || ''));
    // 只认 http(s) 与能解析的 URL：坏值不进清单（界面直接展示与复制，不能有半截字符串）
    if (!url || !/^https?:\/\//i.test(url)) return;
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return;
    }
    if (isLoopbackHost(host)) {
      noteLoopback(url);
      return;
    }
    if (isWildcardHost(host) || seen.has(url)) return;
    seen.add(url);
    const kind: HubAddressKind = isPrivateHost(host) ? 'lan' : 'public';
    const entry: HubAddressEntry = { url, kind, source, label: label || labelOf(kind, source) };
    (kind === 'lan' ? lan : pub).push(entry);
  };

  if (bindScope === 'lan') {
    // 1) 部署侧声明：容器里唯一可信的局域网地址来源
    for (const raw of splitUrls(env.LAN_ACCESS_URL || '')) add(raw, 'env');
    // 2) 监听地址本身就是具体 IP（不是 0.0.0.0）时，它是最权威的答案
    if (port && !isWildcardHost(bindHost)) add(`http://${bindHost.includes(':') ? `[${bindHost}]` : bindHost}:${port}`, 'bind');
    // 3) 网卡自动探测：容器里跳过（172.x 是 Docker 网段，成员连不到）
    //    ifaces 缺省取真实网卡：中枢接口漏传会让这张清单永远是空的（真机验收抓到过）
    const lanPort = envPort || port;
    if (lanPort && !containerized) {
      const ifaces = input.ifaces ?? (os.networkInterfaces() as NetworkInterfaces);
      for (const item of lanIfaceCandidates(ifaces, lanPort)) {
        add(item.url, 'auto', labelOf('lan', 'auto', item.iface));
      }
    }
    // 4) DDNS 直连域名：不在同一局域网时走它（端口取部署声明或当前访问端口）
    const ddnsHost = String(input.ddnsHost || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (ddnsHost) {
      const originPort = (() => {
        try {
          return new URL(origin).port;
        } catch {
          return '';
        }
      })();
      add(`http://${ddnsHost}:${env.LAN_PORT || originPort || DEFAULT_PUBLIC_PORT}`, 'ddns');
    }
    // 5) 公网直连地址（部署侧声明，等同 /health 里通告的那条）
    for (const raw of splitUrls(env.DIRECT_ACCESS_URL || '')) add(raw, 'direct');
    // 6) 设置页当前地址：Docker 版常用局域网 IP 打开，它本身就是成员能用的地址
    if (origin) add(origin, 'origin');
  } else if (origin && isLoopbackUrl(origin)) {
    // 只监听回环（桌面版默认）：配了也连不上，因此一条地址都不给，
    // 只把「你以为能用的那条 127.0.0.1」记下来，界面据此说明并引导开启局域网访问。
    noteLoopback(normalizeBase(origin));
  }

  return {
    bindHost,
    bindScope,
    port,
    addresses: [...lan, ...pub],
    skippedLoopback,
    containerized,
  };
}
