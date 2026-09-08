import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import * as acme from 'acme-client';

/**
 * 内置 TLS/ACME 证书管理器（HTTPS 直连入口）。
 *
 * 职责：为 TLS_DOMAIN 签发/续期 Let's Encrypt 证书（DNS-01，Cloudflare API 写 TXT），
 * 证书+私钥+账户 key 持久化在数据卷缓存目录，启动时有效证书直接加载，
 * 余量不足 30 天自动重签并回调通知（监听器换证书）。
 *
 * 设计说明：全部外部交互（ACME、Cloudflare API、DoH）走可注入的 fetchImpl，
 * 签发流程走可注入的 issueImpl —— 生产用真实实现，测试用 stub。
 */

export interface TlsConfig {
  /** 证书域名（单域名） */
  domain: string;
  /** Cloudflare API token，需 Zone.DNS Edit 权限（写/删 TXT 记录） */
  dnsApiToken: string;
  /** 证书/账户 key 缓存目录（数据卷内，持久化） */
  cacheDir: string;
  /** ACME 账户邮箱（可选） */
  email?: string;
  /** ACME directory URL（默认 Let's Encrypt production） */
  acmeDirectoryUrl: string;
  /** 剩余有效期低于该天数则重签 */
  renewalThresholdDays: number;
  /** DNS 传播轮询超时（毫秒） */
  propagationTimeoutMs: number;
}

export interface LoadedCert {
  key: string;
  cert: string;
  expiresAt: Date;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const LETSENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
const LETSENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const RENEWAL_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** DNS 传播轮询间隔 */
const PROPAGATION_POLL_MS = 5_000;

/** 从环境变量解析 TLS 配置；未配置 TLS_DOMAIN 返回 null（功能关闭，行为与历史一致） */
export function readTlsConfig(env: NodeJS.ProcessEnv, dataDir: string): TlsConfig | null {
  const domain = (env.TLS_DOMAIN || '').trim();
  if (!domain) return null;
  const dnsApiToken = (env.TLS_DNS_API_TOKEN || '').trim();
  if (!dnsApiToken) {
    throw new Error('已配置 TLS_DOMAIN 但缺少 TLS_DNS_API_TOKEN（Cloudflare token，需 Zone.DNS Edit 权限）');
  }
  const dirInput = (env.TLS_ACME_DIRECTORY || '').trim();
  return {
    domain,
    dnsApiToken,
    cacheDir: path.join(path.resolve(dataDir), 'tls'),
    email: (env.TLS_EMAIL || '').trim() || undefined,
    acmeDirectoryUrl: dirInput || LETSENCRYPT_PRODUCTION,
    renewalThresholdDays: 30,
    propagationTimeoutMs: 120_000,
  };
}

export function isLetsEncryptStaging(directoryUrl: string): boolean {
  return directoryUrl === LETSENCRYPT_STAGING;
}

export { LETSENCRYPT_PRODUCTION, LETSENCRYPT_STAGING };

// ---------- Cloudflare DNS（TXT 记录读写） ----------

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

function cfHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** 逐级剥标签查询域名所属 CF zone（如 a.b.xxx.com → xxx.com） */
export async function findCloudflareZoneId(
  domain: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const labels = domain.split('.');
  // 从完整域名开始逐级剥标签（证书域名可能就是 zone 根本身）
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}`,
      { headers: cfHeaders(token) },
    );
    if (!res.ok) throw new Error(`Cloudflare zone 查询失败: HTTP ${res.status}`);
    const data = (await res.json()) as { success: boolean; result?: Array<{ id: string }> };
    if (data.success && data.result && data.result.length > 0) return data.result[0].id;
  }
  throw new Error(`Cloudflare 未找到域名 ${domain} 所属 zone`);
}

/** 轮询 DoH 直到 TXT 记录出现（值匹配），超时抛错 */
export async function waitForTxtPropagation(
  txtName: string,
  expectedValue: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  pollMs = PROPAGATION_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const expected = expectedValue.replace(/^"|"$/g, '');
  for (;;) {
    try {
      const res = await fetchImpl(
        `https://dns.alidns.com/resolve?name=${encodeURIComponent(txtName)}&type=TXT`,
        { headers: { Accept: 'application/json' } },
      );
      if (res.ok) {
        const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
        const hit = (data.Answer || []).some(
          (a) => a.type === 16 && a.data.replace(/^"|"$/g, '') === expected,
        );
        if (hit) return;
      }
    } catch {
      /* 网络抖动继续轮询 */
    }
    if (Date.now() >= deadline) {
      throw new Error(`TXT 记录 ${txtName} 传播等待超时（${timeoutMs}ms）`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** 写 DNS-01 TXT 记录并等待传播；返回清理函数（删除 TXT） */
export async function createDns01Challenge(
  domain: string,
  keyAuthorization: string,
  token: string,
  fetchImpl: FetchLike,
  propagationTimeoutMs: number,
): Promise<() => Promise<void>> {
  const txtName = `_acme-challenge.${domain}`;
  const zoneId = await findCloudflareZoneId(domain, token, fetchImpl);
  const createRes = await fetchImpl(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    {
      method: 'POST',
      headers: cfHeaders(token),
      body: JSON.stringify({ type: 'TXT', name: txtName, content: keyAuthorization, ttl: 60 }),
    },
  );
  if (!createRes.ok) throw new Error(`Cloudflare TXT 创建失败: HTTP ${createRes.status}`);
  const created = (await createRes.json()) as { success: boolean; result?: CfDnsRecord };
  if (!created.success) throw new Error('Cloudflare TXT 创建失败: API 返回 success=false');

  await waitForTxtPropagation(txtName, keyAuthorization, propagationTimeoutMs, fetchImpl);

  return async () => {
    try {
      const recordId = created.result?.id;
      if (recordId) {
        await fetchImpl(
          `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
          { method: 'DELETE', headers: cfHeaders(token) },
        );
      }
    } catch {
      /* 清理失败不影响签发结果 */
    }
  };
}

// ---------- 证书管理器 ----------

export interface CertManagerOptions extends Omit<TlsConfig, 'renewalThresholdDays' | 'propagationTimeoutMs'> {
  /** 剩余有效期低于该天数则重签（默认 30 天） */
  renewalThresholdDays?: number;
  /** DNS 传播轮询超时毫秒（默认 120s） */
  propagationTimeoutMs?: number;
  /** 测试注入：自定义签发实现（生产用 ACME） */
  issueImpl?: (domain: string) => Promise<{ key: string; cert: string }>;
  /** 测试注入：自定义 fetch */
  fetchImpl?: FetchLike;
  /** 测试注入：续期检查间隔毫秒（默认 12h） */
  renewalCheckIntervalMs?: number;
}

export class CertManager {
  private readonly domain: string;
  private readonly dnsApiToken: string;
  private readonly cacheDir: string;
  private readonly email: string | undefined;
  private readonly acmeDirectoryUrl: string;
  private readonly renewalThresholdDays: number;
  private readonly propagationTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly issueImpl?: (domain: string) => Promise<{ key: string; cert: string }>;
  private current: LoadedCert | null = null;
  private renewalCbs: Array<(c: LoadedCert) => void> = [];
  private renewalTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private constructor(opts: CertManagerOptions) {
    this.domain = opts.domain;
    this.dnsApiToken = opts.dnsApiToken;
    this.cacheDir = opts.cacheDir;
    this.email = opts.email;
    this.acmeDirectoryUrl = opts.acmeDirectoryUrl;
    this.renewalThresholdDays = opts.renewalThresholdDays ?? 30;
    this.propagationTimeoutMs = opts.propagationTimeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl || ((u, i) => fetch(u, i));
    this.issueImpl = opts.issueImpl;
  }

  static async create(opts: CertManagerOptions): Promise<CertManager> {
    fs.mkdirSync(opts.cacheDir, { recursive: true });
    const mgr = new CertManager(opts);
    const cached = mgr.loadCached();
    // 缓存文件存在但临期：current 为空（需要重签），但标记 hadCachedCert ——
    // 重签成功视为续期（onRenewal 回调），与「无缓存首次签发」区分
    mgr.current = cached && !cached.stale ? cached.entry : null;
    mgr.hadCachedCert = cached !== null;
    const interval = opts.renewalCheckIntervalMs ?? RENEWAL_CHECK_INTERVAL_MS;
    mgr.renewalTimer = setInterval(() => {
      // checkAndRenew 的 rejection 必须就地捕获：定时器回调里的 void promise
      // 无人接盘会变成 unhandledRejection，Node ≥15 默认直接终止整个进程。
      mgr.checkAndRenew().catch((error) => {
        console.error(
          `[tls] 证书续期失败（将在下个周期重试）: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, interval);
    mgr.renewalTimer.unref();
    return mgr;
  }

  /** 当前有效证书（缓存命中时立即可用）；无缓存时由 waitReady() 触发签发 */
  getCached(): LoadedCert | null {
    return this.current;
  }

  /** 等待证书就绪：缓存有效直接返回，否则走 ACME 签发（并发调用合并为一次） */
  async waitReady(): Promise<LoadedCert> {
    if (this.current) return this.current;
    await this.issueIfNeeded();
    if (!this.current) throw new Error('证书签发后仍未就绪');
    return this.current;
  }

  /** 续期成功后回调（用于热更换 HTTPS 监听证书） */
  onRenewal(cb: (c: LoadedCert) => void): void {
    this.renewalCbs.push(cb);
  }

  stop(): void {
    this.stopped = true;
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = null;
  }

  /** 供测试/手动触发：需要时重签并分发回调 */
  async checkAndRenew(): Promise<LoadedCert> {
    if (this.stopped) throw new Error('CertManager 已停止');
    await this.issueIfNeeded();
    if (!this.current) throw new Error('证书签发失败');
    return this.current;
  }

  private loadCached(): { entry: LoadedCert; stale: boolean } | null {
    const certPath = path.join(this.cacheDir, 'cert.pem');
    const keyPath = path.join(this.cacheDir, 'privkey.pem');
    try {
      const cert = fs.readFileSync(certPath, 'utf8');
      const key = fs.readFileSync(keyPath, 'utf8');
      const expiresAt = certExpiresAt(cert);
      if (remainingDays(expiresAt) < this.renewalThresholdDays) {
        return { entry: { cert, key, expiresAt }, stale: true };
      }
      return { entry: { cert, key, expiresAt }, stale: false };
    } catch {
      return null;
    }
  }

  private issuing: Promise<void> | null = null;
  private hadCachedCert = false;

  private async issueIfNeeded(): Promise<void> {
    if (this.current && remainingDays(this.current.expiresAt) >= this.renewalThresholdDays) {
      return;
    }
    if (this.issuing) return this.issuing;
    this.issuing = (async () => {
      try {
        if (this.stopped) return;
        const issued = this.issueImpl
          ? await this.issueImpl(this.domain)
          : await this.issueViaAcme();
        const expiresAt = certExpiresAt(issued.cert);
        const entry: LoadedCert = { ...issued, expiresAt };
        fs.writeFileSync(path.join(this.cacheDir, 'cert.pem'), issued.cert, { mode: 0o600 });
        fs.writeFileSync(path.join(this.cacheDir, 'privkey.pem'), issued.key, { mode: 0o600 });
        // 续期判定：此前有在用证书，或启动时存在旧缓存文件（含临期）→ 换新证书即续期
        const isRenewal = this.current !== null || this.hadCachedCert;
        this.current = entry;
        this.hadCachedCert = true;
        console.log(`[tls] 证书已就绪: ${this.domain}（有效期至 ${expiresAt.toISOString()}）`);
        if (isRenewal) {
          for (const cb of this.renewalCbs) {
            try {
              cb(entry);
            } catch {
              /* 回调异常不影响续期结果 */
            }
          }
        }
      } finally {
        this.issuing = null;
      }
    })();
    return this.issuing;
  }

  /** 生产签发实现：ACME DNS-01（Cloudflare） */
  private async issueViaAcme(): Promise<{ key: string; cert: string }> {
    const domain = this.domain;
    const cacheDir = this.cacheDir;
    const { dnsApiToken, propagationTimeoutMs } = this;
    const email = this.email;
    const acmeDirectoryUrl = this.acmeDirectoryUrl;
    const accountKeyPath = path.join(cacheDir, 'account.pem');
    let accountKey = fs.existsSync(accountKeyPath)
      ? fs.readFileSync(accountKeyPath, 'utf8')
      : await acme.forge.createPrivateKey().then((b) => b.toString('utf8'));
    fs.writeFileSync(accountKeyPath, accountKey, { mode: 0o600 });

    const client = new acme.Client({ directoryUrl: acmeDirectoryUrl, accountKey });
    const [certKey, csr] = await acme.forge.createCsr({
      commonName: domain,
      altNames: [domain],
    });
    // CSR 为 PEM 文本（forge 输出）；finalizeOrder 内部 getPemBodyAsB64u 可直接处理。
    // 不使用 client.auto()：其 readCsrDomains 走 @peculiar/x509 解析 CSR，在
    // acme-client 5.4 + Node 22 上报 "Cannot get schema for 'CertificationRequest'
    // target"。单域名场景域名已知，手动 order 流程完全绕开该解析。
    const csrPem = csr.toString('utf8');

    // 0) 注册/载入 ACME 账户（程序化同意 LE 订户条款）
    await client.createAccount({
      termsOfServiceAgreed: true,
      ...(email ? { contact: [`mailto:${email}`] } : {}),
    });

    // 1) 下单（单域名）
    const order = await client.createOrder({
      identifiers: [{ type: 'dns', value: domain }],
    });

    // 2) 逐个 authorization 完成 DNS-01 challenge（写 TXT → 等 ACME 验证通过 → 删 TXT）
    const authorizations = await client.getAuthorizations(order);
    for (const authz of authorizations) {
      if (authz.status === 'valid') continue;
      const authzDomain = authz.identifier?.value || domain;
      const challenge = authz.challenges.find((c) => c.type === 'dns-01');
      if (!challenge) {
        throw new Error(`ACME 未为 ${authzDomain} 提供 dns-01 challenge`);
      }
      const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
      let completed = false;
      try {
        const cleanup = await createDns01Challenge(
          authzDomain,
          keyAuthorization,
          dnsApiToken,
          this.fetchImpl,
          propagationTimeoutMs,
        );
        try {
          await client.completeChallenge(challenge);
          completed = true;
          await client.waitForValidStatus(challenge);
        } finally {
          await cleanup();
        }
      } catch (e) {
        if (!completed) {
          try {
            await client.deactivateAuthorization(authz);
          } catch {
            /* 停用失败不影响错误上抛 */
          }
        }
        throw e;
      }
    }

    // 3) 等 order ready → finalize（提交 CSR）→ 等 valid → 下载证书
    await client.waitForValidStatus(order);
    const finalized = await client.finalizeOrder(order, csrPem);
    const cert = await client.getCertificate(finalized);
    return { key: certKey.toString('utf8'), cert };
  }
}

/** 删除 DNS-01 TXT（按 name+content 查找；清理失败静默） */
export async function removeDns01Challenge(
  domain: string,
  keyAuthorization: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<void> {
  try {
    const txtName = `_acme-challenge.${domain}`;
    const zoneId = await findCloudflareZoneId(domain, token, fetchImpl);
    const listRes = await fetchImpl(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(txtName)}`,
      { headers: cfHeaders(token) },
    );
    if (!listRes.ok) return;
    const list = (await listRes.json()) as { success: boolean; result?: CfDnsRecord[] };
    for (const rec of list.result || []) {
      if (rec.content.replace(/^"|"$/g, '') === keyAuthorization) {
        await fetchImpl(
          `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${rec.id}`,
          { method: 'DELETE', headers: cfHeaders(token) },
        );
      }
    }
  } catch {
    /* 清理失败静默 */
  }
}

// ---------- 工具 ----------

/** 解析证书 PEM 的到期时间 */
export function certExpiresAt(certPem: string): Date {
  const x509 = new X509Certificate(certPem);
  return new Date(x509.validTo);
}

/** 剩余有效天数（向下取整） */
export function remainingDays(expiresAt: Date): number {
  return Math.floor((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}
