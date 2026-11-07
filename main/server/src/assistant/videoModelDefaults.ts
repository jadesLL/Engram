import { consoleUpstream, ensureConsole } from './agentConsole.js';
import { ConsoleRpcError, createConsoleRpc } from './agentConsoleRpc.js';
import { bundledDshHome } from './config.js';
import { hasVideoProvider, videoProviderDefaultProfile, VIDEO_MODEL_ID, VIDEO_PROVIDER_ID } from '../lib/videoModel.js';
import { getSetting, setSetting } from '../lib/db.js';

/**
 * 视频理解模型的默认提供商播种（2026-11 起）。
 *
 * 用户目标：模型与地址都预置好，只需要在「内置 Agent 控制台 → 模型」里填一个 DashScope API Key。
 * 但 dsh 的模型配置只有控制台能写（settings/mutate），所以这里在第一次打开「视频理解模型」
 * 状态接口时，幂等地把默认提供商（dashscope / qwen3.8-omni-flash / DashScope 兼容地址）写进
 * dsh 的 web profile，之后控制台的模型页就能直接看到这张卡并填 Key。
 *
 * 幂等与顺序：
 *  1. 已播种过（Engram 设置 video_provider_seeded=1）→ 直接返回；
 *  2. dsh 配置里已经有视频提供商（用户自己配过）→ 记下已播种标记并返回；
 *  3. 否则确保控制台在跑，读 settings/describe，settings/mutate 写入 providers.dashscope；
 *     并发/别处改动导致 revision 冲突时重读一次重试。
 *
 * 失败不写标记：下次打开设置页会再试（控制台可能只是暂时没起来）。
 */

const SEEDED_SETTING = 'video_provider_seeded';
const SEED_NS = 'llm-pi-ai';

const rpc = createConsoleRpc({ getTarget: () => consoleUpstream() });

export interface VideoProviderSeedResult {
  ok: boolean;
  /** 这次调用真的写入了默认提供商 */
  seeded: boolean;
  /** 已有提供者 / 已播种过，本次没动 dsh 配置 */
  skipped: boolean;
  error?: string;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? (value as Record<string, any>) : {};
}

/** describe 的 namespace 视图里合并 base（bundle 默认）与 user 层 providers */
function providersOf(describe: unknown): Record<string, any> {
  const namespaces: any[] = Array.isArray(asRecord(describe).namespaces) ? asRecord(describe).namespaces as any[] : [];
  const view = namespaces.find((item) => item && item.ns === SEED_NS) ?? null;
  const merged: Record<string, any> = {};
  for (const layer of ['base', 'user']) {
    const providers = asRecord(asRecord(asRecord(view)[layer]).providers);
    for (const [id, raw] of Object.entries(providers)) {
      if (typeof id === 'string' && id && raw && typeof raw === 'object') merged[id] = raw;
    }
  }
  const direct = asRecord(asRecord(view).value).providers;
  for (const [id, raw] of Object.entries(asRecord(direct))) {
    if (typeof id === 'string' && id && raw && typeof raw === 'object') merged[id] = raw;
  }
  return merged;
}

function revisionOf(describe: unknown): number {
  const namespaces: any[] = Array.isArray(asRecord(describe).namespaces) ? asRecord(describe).namespaces as any[] : [];
  const view = namespaces.find((item) => item && item.ns === SEED_NS);
  return typeof view?.revision === 'number' ? view.revision : 0;
}

function hasProvider(providers: Record<string, any>): boolean {
  if (providers[VIDEO_PROVIDER_ID]) return true;
  return Object.values(providers).some((raw) => {
    const models = Array.isArray(raw?.models) ? raw.models : [];
    return models.some((model: any) => model && typeof model.id === 'string' && model.id === VIDEO_MODEL_ID);
  });
}

function errorText(error: unknown): string {
  if (error instanceof ConsoleRpcError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export async function ensureVideoProviderSeeded(origin: string | null): Promise<VideoProviderSeedResult> {
  if (getSetting(SEEDED_SETTING) === '1') return { ok: true, seeded: false, skipped: true };
  const home = bundledDshHome();
  if (hasVideoProvider(home)) {
    setSetting(SEEDED_SETTING, '1');
    return { ok: true, seeded: false, skipped: true };
  }
  if (!origin) {
    return { ok: false, seeded: false, skipped: false, error: '无法识别访问地址（Host 头缺失或非法）' };
  }
  let status: Awaited<ReturnType<typeof ensureConsole>> | null = null;
  try {
    status = await ensureConsole(origin);
  } catch (error) {
    return { ok: false, seeded: false, skipped: false, error: errorText(error) };
  }
  if (!status?.running || !consoleUpstream()) {
    return { ok: false, seeded: false, skipped: false, error: status?.error || '内置 Agent 控制台未启动' };
  }

  try {
    let describe = await rpc.call(origin, 'settings/describe', {});
    if (hasProvider(providersOf(describe))) {
      setSetting(SEEDED_SETTING, '1');
      return { ok: true, seeded: false, skipped: true };
    }
    const ops = [{ op: 'set', path: ['providers', VIDEO_PROVIDER_ID], value: videoProviderDefaultProfile() }];
    try {
      await rpc.call(origin, 'settings/mutate', { ns: SEED_NS, ops, expectedRevision: revisionOf(describe) });
    } catch (error) {
      // revision 冲突（用户/控制台刚好也在改）：重读一次再写，仍失败就交给下次打开页面重试
      if (!(error instanceof ConsoleRpcError) || error.status !== 409) throw error;
      describe = await rpc.call(origin, 'settings/describe', {});
      if (hasProvider(providersOf(describe))) {
        setSetting(SEEDED_SETTING, '1');
        return { ok: true, seeded: false, skipped: true };
      }
      await rpc.call(origin, 'settings/mutate', { ns: SEED_NS, ops, expectedRevision: revisionOf(describe) });
    }
    setSetting(SEEDED_SETTING, '1');
    return { ok: true, seeded: true, skipped: false };
  } catch (error) {
    return { ok: false, seeded: false, skipped: false, error: errorText(error) };
  }
}

/** 仅供测试/诊断：清掉「已播种」标记（不清 dsh 配置） */
export function resetVideoProviderSeedFlag(): void {
  setSetting(SEEDED_SETTING, '');
}
