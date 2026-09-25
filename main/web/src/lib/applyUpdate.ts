// 显式 .ts：web 测试链是 `node --test src/**/*.test.ts`（无 tsx），node 原生类型剥离
// 不接受无扩展名的相对运行时导入，否则本模块被测试直接引入时报 ERR_MODULE_NOT_FOUND。
import { ssePost } from '../api.ts';

/**
 * 应用内「立即更新」：三种运行形态各自的更新动作，提示条（UpdateNotice）与设置页
 * （UpdatePanel）共用同一份实现，避免两处各写一套 SSE/下载/轮询逻辑再慢慢跑偏。
 *
 * 形态判定与动作：
 *   源码模式（桌面壳 + 非安装包）→ 主进程增量拉源码 + 重建 + 自动重启；
 *   安装包形态（桌面壳 + 打包）  → 检查 Release → 下载 exe（带进度）→ 静默安装并重启；
 *   Docker 服务端 / 浏览器访问   → POST /api/update/apply（SSE 进度）→ 等 /health 恢复 → 刷新页面。
 *
 * 全部一键执行，不再二次确认：调用方只负责展示进度与错误（本模块把各形态的
 * 成功/失败/超时收敛成同一个 ApplyResult）。
 */

const desktopApi = (): any => (window as any).wikiDesktop;

export interface UpdateSourceCfg {
  giteaUrl?: string;
  giteaRepo?: string;
  giteaAuthType?: string;
  giteaToken?: string;
  giteaUsername?: string;
  giteaPassword?: string;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  /** 已经是最新，无需动作 */
  skipped?: boolean;
  /** 流程已交给重启/刷新接管，调用方不必再做别的 */
  handingOff?: boolean;
  /** 等服务端恢复超时（仅服务器形态） */
  timeout?: boolean;
}

export const UPDATE_SOURCE_HINT = '还没有配置更新源：打开「设置 → 连接与同步 → 更新源配置」填写远端仓库地址后重试。';

/** 把主进程/服务端的错误码翻成人话（未配置更新源是最常见的一种） */
export function friendlyApplyError(error?: string): string {
  const text = String(error || '').trim();
  if (!text) return '更新失败，请稍后重试';
  if (text === 'not-configured' || text.includes('not-configured')) return UPDATE_SOURCE_HINT;
  return text;
}

export interface ServerUpdateHandlers {
  /** 进度行（追加展示，调用方自行截断） */
  log?: (line: string) => void;
  /** 已提交更新、开始等旧服务下线 */
  onWaiting?: () => void;
  /** 5 分钟内没等到服务恢复 */
  onTimeout?: () => void;
  /** 覆盖默认的 location.reload()（测试或自定义壳用） */
  reload?: () => void;
}

/**
 * Docker 服务端更新：SSE 执行更新流程，随后轮询 /health 等新容器起来再刷新页面。
 * 必须先观察到一次下线再等回 200——done 事件发出时旧容器还活着（switcher 随后才停旧起新），
 * 否则会把切换前的旧容器当恢复、reload 到旧版本前端。
 */
export async function applyServerUpdate(h: ServerUpdateHandlers = {}): Promise<ApplyResult> {
  const log = h.log || (() => {});
  let streamEnded = false;
  let failed = '';
  try {
    await ssePost('/api/update/apply', {}, {
      onEvent: (event, data) => {
        if (event === 'progress' && data?.text) log(String(data.text));
        else if (event === 'done') log(String(data?.message || '更新流程已移交'));
        else if (event === 'error') {
          failed = String(data?.error || '未知错误');
          log(`更新失败: ${failed}`);
        }
      },
    });
    streamEnded = true;
  } catch (e: any) {
    // HTTP 层直接拒绝（未挂载 socket / 已有更新在进行 / 桌面端模式）：更新压根没开始，
    // 不能按「连接中断」上报——那会让人以为服务端还在跑而重复点。
    const status = Number(e?.status || 0);
    if (status >= 400) return { ok: false, error: friendlyApplyError(e?.message || `更新请求被服务端拒绝（HTTP ${status}）`) };
    log(`连接中断: ${e?.message || e}`);
  }
  if (!streamEnded) {
    return { ok: false, error: '与本地服务的连接中断，更新可能仍在服务端执行；稍后点「检查更新」确认版本。' };
  }
  if (failed) return { ok: false, error: friendlyApplyError(failed) };

  h.onWaiting?.();
  const deadline = Date.now() + 5 * 60_000;
  await new Promise((res) => setTimeout(res, 8000));
  let sawDown = false;
  for (;;) {
    if (Date.now() > deadline) {
      h.onTimeout?.();
      return { ok: false, timeout: true, error: '等待服务恢复超时（超过 5 分钟），请手动刷新页面确认版本。' };
    }
    try {
      const r = await fetch('/health', { cache: 'no-store' });
      if (r.ok) {
        if (sawDown) {
          await new Promise((res) => setTimeout(res, 1500));
          (h.reload || (() => location.reload()))();
          return { ok: true, handingOff: true };
        }
      } else {
        sawDown = true;
      }
    } catch {
      sawDown = true;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
}

/** 源码模式更新：主进程自己弹置顶进度窗，成功后 app.relaunch 重启（本窗口随后关闭） */
export async function applySourceUpdate(): Promise<ApplyResult> {
  const wd = desktopApi();
  if (!wd?.desktopSourceUpdate) {
    return { ok: false, error: '当前桌面端壳不支持源码更新，请先更新一次桌面端再试。' };
  }
  try {
    const r = await wd.desktopSourceUpdate();
    if (!r?.ok) return { ok: false, error: friendlyApplyError(r?.error || '更新失败') };
    return { ok: true, handingOff: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || '更新失败' };
  }
}

export interface InstallerUpdateHandlers {
  /** 进度行 */
  log?: (line: string) => void;
  /** 下载进度（0-100，未知大小时为 null） */
  onProgress?: (percent: number | null) => void;
  /** 下载完成、进入静默安装（应用即将退出重启） */
  onInstalling?: () => void;
  /** 更新源配置：设置页传页面里已保存的值；提示条不传，由主进程自行解析 */
  cfg?: UpdateSourceCfg;
  /** 已经做过的检查结果（设置页先「检查更新」再点安装）：传了就不再重复请求远端 */
  check?: { ok?: boolean; hasUpdate?: boolean; latestVersion?: string | null; exe?: { url: string } | null; error?: string } | null;
}

/**
 * 安装包形态更新：检查 Release → 下载 exe → 静默安装并重启（主进程自带安装进度窗）。
 * 下载前必然先做一次检查：既确认确实有新版本，也让主进程记住本次用的更新源配置
 * （desktop-update-download 在没收到配置时优先复用「最近一次检查」的配置，保证与资产 URL 同源）。
 */
export async function applyDesktopInstallerUpdate(h: InstallerUpdateHandlers = {}): Promise<ApplyResult> {
  const wd = desktopApi();
  const log = h.log || (() => {});
  if (!wd?.desktopUpdateCheck || !wd.desktopUpdateDownload || !wd.desktopUpdateRunInstaller) {
    return { ok: false, error: '当前桌面端壳不支持自动安装更新，请到「设置 → 连接与同步 → 桌面端更新」手动更新。' };
  }
  let check = h.check || null;
  if (!check) {
    log('正在检查更新源…');
    check = await wd.desktopUpdateCheck(h.cfg);
  }
  if (!check?.ok) return { ok: false, error: friendlyApplyError(check?.error) };
  if (!check.hasUpdate) return { ok: true, skipped: true };
  const exe = check.exe;
  if (!exe?.url) return { ok: false, error: '远端 Release 里没有可用的安装包（exe），请稍后再试或手动下载。' };

  log(`开始下载 v${check.latestVersion || '新版本'} 安装包…`);
  const off = wd.onUpdateProgress ? wd.onUpdateProgress((p: any) => h.onProgress?.(p?.percent ?? null)) : null;
  try {
    const { path: filePath } = await wd.desktopUpdateDownload(exe.url, h.cfg);
    h.onProgress?.(null);
    log('下载完成，正在静默安装并重启…');
    h.onInstalling?.();
    await wd.desktopUpdateRunInstaller(filePath, check.latestVersion);
    return { ok: true, handingOff: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || '下载安装包失败' };
  } finally {
    off?.();
  }
}
