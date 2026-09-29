/**
 * 「DDNS 直连域名」的使用前提清单（纯函数，便于单测）。
 *
 * 起因：原来的「一键配置」默认客户已经有域名、并且已经把域名托管到 Cloudflare，
 * 面板里只有一句括号说明（「域名需已托管在 Cloudflare」）。客户没有域名时，看到的是
 * 「该 Token 名下没有可管理的域名（需要 Zone → DNS → Edit 权限）」——把「你还没买域名」
 * 误报成「权限不足」，客户会一直在 Token 上打转。
 *
 * 这里把前提做成 5 步可勾选的引导，状态全部来自服务端已有的事实（Token 校验结果、
 * zone 列表、zone 状态、同步结果），不额外发请求、也不猜：
 *   1. 买一个自己的域名（客户自己买，Engram 不代购）
 *   2. 把域名绑定到 Cloudflare（添加站点 + 到注册商改 NS）
 *   3. 建一个 API Token（Zone → DNS → Edit + Zone → Zone → Read）
 *   4. 一键启用并写入记录
 *   5. 外网能解析到本机（公共解析器确认）
 */

export type DdnsStepState = 'done' | 'doing' | 'todo' | 'blocked';

export interface DdnsStepAction {
  label: string;
  href: string;
}

export interface DdnsSetupStep {
  id: 'domain' | 'bind' | 'token' | 'configure' | 'live';
  title: string;
  detail: string;
  state: DdnsStepState;
  action: DdnsStepAction | null;
}

export interface DdnsSetupInput {
  /** 粘过 Token 并检查过（或本机早已配置好） */
  checked: boolean;
  /** 最近一次 discover 查到的可维护域名数；null=还没查过 */
  zoneCount: number | null;
  /** 最近一次 discover 失败时的归类：token / no-domain / permission / network */
  errorCode: string | null;
  /** 选中域名在 Cloudflare 的状态（active / pending / ...） */
  zoneStatus: string | null;
  /** 本机已保存 token + 记录 */
  configured: boolean;
  /** 最近一次同步结果 */
  outcome: string | null;
  /** 外网能否解析到本机（null=未能核验） */
  live: boolean | null;
}

export interface DdnsSetupReport {
  steps: DdnsSetupStep[];
  doneCount: number;
  /** 客户还没域名：界面要醒目提示「先去买域名」并给出购买入口 */
  needsDomain: boolean;
  /** 已配置但外网还解析不到：多半卡在 NS 没切 / 还在传播 */
  waitingDns: boolean;
}

/** 买域名：任意注册商都行，这里给一个通用卖场入口 */
export const DOMAIN_SHOP_URL = 'https://www.spaceship.com/';
/** Cloudflare「添加站点」：把域名托管进来（绑定的第一步） */
export const CLOUDFLARE_ADD_SITE_URL = 'https://dash.cloudflare.com/?to=/:account/add-site';
/** Cloudflare 控制台：看分配的两条 NS 与 zone 状态 */
export const CLOUDFLARE_DASH_URL = 'https://dash.cloudflare.com/';

/**
 * Cloudflare「建 Token 页」的预填链接（官方支持，见 Cloudflare 文档
 * fundamentals/api/how-to/account-owned-token-template）：permissionGroupKeys 里放 URL 编码后的权限 JSON。
 * 预选 dns:edit（读写解析记录）与 zone:read（列出账号下的域名——「列域名」这一步需要它；
 * 只想写记录、不要列域名的用户可以在页面上把它去掉）。
 */
export const DDNS_TOKEN_TEMPLATE_URL = 'https://dash.cloudflare.com/profile/api-tokens'
  + '?permissionGroupKeys=%5B%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C'
  + '%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D'
  + '&accountId=%2A&zoneId=all&name=Engram%20DDNS';

export function stepMark(state: DdnsStepState): string {
  return state === 'done' ? '✓' : state === 'doing' ? '●' : state === 'blocked' ? '!' : '○';
}

export function ddnsSetupSteps(input: DdnsSetupInput): DdnsSetupReport {
  const zoneCount = input.zoneCount;
  const hasZone = typeof zoneCount === 'number' && zoneCount > 0;
  const noDomain = input.checked && (input.errorCode === 'no-domain' || zoneCount === 0);

  const domain: DdnsSetupStep = noDomain
    ? {
        id: 'domain',
        state: 'blocked',
        title: '1. 买一个自己的域名',
        detail: '你的 Cloudflare 账号下还没有域名。域名要你自己买（几十块一年），Engram 不代购、也送不了；没有域名，后面几步全都做不了。',
        action: { label: '去挑一个域名', href: DOMAIN_SHOP_URL },
      }
    : hasZone
      ? {
          id: 'domain',
          state: 'done',
          title: '1. 买一个自己的域名',
          detail: `已在 Cloudflare 看到 ${zoneCount} 个域名`,
          action: null,
        }
      : {
          id: 'domain',
          state: 'todo',
          title: '1. 买一个自己的域名',
          detail: '先去注册商买一个（Spaceship / Namecheap / 阿里云 都行）——后面几步都围着它转。',
          action: { label: '去挑一个域名', href: DOMAIN_SHOP_URL },
        };

  const bind: DdnsSetupStep = !hasZone
    ? {
        id: 'bind',
        state: 'todo',
        title: '2. 把域名绑定到 Cloudflare',
        detail: '在 Cloudflare「添加站点」，再到域名注册商把 NS（域名服务器）改成 Cloudflare 给的两条——这一步就叫「绑定」；不绑定的话 DNS 不归 Cloudflare 管，DDNS 也写不进去。',
        action: { label: '打开 Cloudflare 添加站点', href: CLOUDFLARE_ADD_SITE_URL },
      }
    : input.zoneStatus === 'active'
      ? {
          id: 'bind',
          state: 'done',
          title: '2. 把域名绑定到 Cloudflare',
          detail: '域名已在 Cloudflare 生效（Active）',
          action: null,
        }
      : {
          id: 'bind',
          state: 'doing',
          title: '2. 把域名绑定到 Cloudflare',
          detail: input.zoneStatus
            ? `域名已添加，但 Cloudflare 状态还是「${input.zoneStatus}」：去注册商把 NS 换成 Cloudflare 分配的那两条，等它变成 Active。`
            : '域名已添加；确认注册商那边的 NS 已换成 Cloudflare 给的两条。',
          action: { label: '打开 Cloudflare 看 NS', href: CLOUDFLARE_DASH_URL },
        };

  // 没域名时 Token 本身是好的：客户只是还没有域名，别把他按在 Token 这一步。
  const tokenOk = input.checked
    && input.errorCode !== 'token'
    && input.errorCode !== 'permission'
    && input.errorCode !== 'network';
  const token: DdnsSetupStep = tokenOk
    ? {
        id: 'token',
        state: 'done',
        title: '3. 建一个 Cloudflare API Token',
        detail: 'Token 有效（Zone → DNS → Edit + Zone → Zone → Read）',
        action: null,
      }
    : input.checked && input.errorCode === 'permission'
      ? {
          id: 'token',
          state: 'blocked',
          title: '3. 建一个 Cloudflare API Token',
          detail: 'Cloudflare 说这个 Token 的权限不够：按预选权限重建一个，要包含 Zone → DNS → Edit 与 Zone → Zone → Read。',
          action: { label: '重建 Token', href: DDNS_TOKEN_TEMPLATE_URL },
        }
      : {
          id: 'token',
          state: 'todo',
          title: '3. 建一个 Cloudflare API Token',
          detail: '点下面的「创建 Cloudflare Token」（权限已预选），建好粘回本页。',
          action: { label: '创建 Token', href: DDNS_TOKEN_TEMPLATE_URL },
        };

  const configure: DdnsSetupStep = input.configured
    ? {
        id: 'configure',
        state: 'done',
        title: '4. 一键启用并写入记录',
        detail: '配置已保存，服务端每 5 分钟自动比对，地址变了才写',
        action: null,
      }
    : {
        id: 'configure',
        state: 'todo',
        title: '4. 一键启用并写入记录',
        detail: '前 3 步都打勾之后，点「② 一键启用并立即同步」。',
        action: null,
      };

  const liveDoing = input.configured
    && ['zone-pending', 'not-published', 'propagating'].includes(input.outcome || '');
  const live: DdnsSetupStep = input.live === true
    ? {
        id: 'live',
        state: 'done',
        title: '5. 外网能解析到本机',
        detail: '公共解析器已确认能解析到本机地址',
        action: null,
      }
    : liveDoing
      ? {
          id: 'live',
          state: 'doing',
          title: '5. 外网能解析到本机',
          detail: input.outcome === 'propagating'
            ? '记录刚写入 Cloudflare，等 1～5 分钟解析传播，下个周期自动复查。'
            : '记录写好了，但外网还解析不到：多半是第 2 步的 NS 还没切到 Cloudflare（见下方状态卡）。',
          action: null,
        }
      : {
          id: 'live',
          state: 'todo',
          title: '5. 外网能解析到本机',
          detail: '前 4 步完成、域名生效之后，这一步会自动打勾并亮绿灯。',
          action: null,
        };

  const steps = [domain, bind, token, configure, live];
  return {
    steps,
    doneCount: steps.filter((s) => s.state === 'done').length,
    needsDomain: noDomain,
    waitingDns: input.configured && input.live !== true,
  };
}
