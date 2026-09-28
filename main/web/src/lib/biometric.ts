/**
 * 系统解锁桥（指纹 / 人脸 / 锁屏密码）。
 *
 * 手机版的知识库会话 cookie 最多 30 天，过期或退出登录后还是会回到登录页。用户要求这里
 * **调用系统解锁能力**（Android 的 BiometricPrompt / 钥匙串验证），而不是应用自己画一套图案锁。
 *
 * 分工：
 *  - 原生（`mobile/android/.../BiometricUnlock.java`）负责弹系统弹窗、把登录密码用 Keystore
 *    密封存盘，并在**解锁成功之后**才把密码交给网页；
 *  - 本模块只做契约转换：把原生的同步字符串接口包成 Promise，网页侧不出现任何平台判断。
 *
 * 桌面端 / Docker 网页端没有 `window.EngramBiometric`，所有能力查询都返回 null，
 * 登录页据此完全隐藏这一块——不会出现点了没反应的按钮。
 */

export type BiometricKind = 'biometric' | 'credential' | 'none';

export interface BiometricStatus {
  /** 设备能弹系统解锁（有指纹/人脸或设了锁屏密码） */
  available: boolean;
  /** biometric = 已录生物识别；credential = 只有锁屏密码；none = 都没有 */
  kind: BiometricKind;
  /** 已经记住了登录密码（可以一键解锁） */
  saved: boolean;
}

export interface BiometricUnlockResult {
  ok: boolean;
  password?: string;
  /** 原生侧给的原因：canceled（用户取消）/ failed / unsupported / no-secret / busy */
  reason?: string;
}

/** 原生注入的桥（只有安卓本地端有） */
interface NativeBridge {
  status(): string;
  remember(password: string): string;
  forget(): void;
  unlock(requestId: string): void;
  openSecuritySettings(): void;
}

declare global {
  interface Window {
    EngramBiometric?: NativeBridge;
    __engramBiometricResult?: (requestId: string, payload: string) => void;
  }
}

/** 未解锁时等待用户操作的上限：超时就当取消，避免 Promise 永远挂着 */
const UNLOCK_TIMEOUT_MS = 3 * 60 * 1000;

const pending = new Map<string, (result: BiometricUnlockResult) => void>();
let handlerInstalled = false;
let sequence = 0;

function bridge(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  return window.EngramBiometric ?? null;
}

/** 设备有没有系统解锁能力（网页自己不需要知道是哪种） */
export function hasBiometricBridge(): boolean {
  return bridge() !== null;
}

function installHandler() {
  if (handlerInstalled || typeof window === 'undefined') return;
  handlerInstalled = true;
  window.__engramBiometricResult = (requestId: string, payload: string) => {
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    let parsed: BiometricUnlockResult = { ok: false, reason: 'failed' };
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : (payload as BiometricUnlockResult);
    } catch {
      parsed = { ok: false, reason: 'failed' };
    }
    resolve(parsed);
  };
}

/** 读一次能力与「有没有记住密码」；非安卓端返回 null */
export function biometricStatus(): BiometricStatus | null {
  const native = bridge();
  if (!native) return null;
  try {
    const raw = native.status();
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const kind: BiometricKind = parsed?.kind === 'biometric' || parsed?.kind === 'credential' ? parsed.kind : 'none';
    return {
      available: Boolean(parsed?.available) && kind !== 'none',
      kind,
      saved: Boolean(parsed?.saved),
    };
  } catch {
    return { available: false, kind: 'none', saved: false };
  }
}

/** 开启：把这次输入的密码交给原生，用 Android Keystore 密封保存 */
export function rememberPassword(password: string): boolean {
  const native = bridge();
  if (!native || !password) return false;
  try {
    const raw = native.remember(password);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Boolean(parsed?.ok);
  } catch {
    return false;
  }
}

/** 关闭：改过密码、退出登录或用户在设置里关掉开关时调用 */
export function forgetPassword(): void {
  try {
    bridge()?.forget();
  } catch {
    // 桥异常时忽略：最坏情况是下次解锁失败，登录页会回退到密码输入
  }
}

/** 弹系统解锁；成功时把记住的密码带回给调用方 */
export function unlockWithSystem(): Promise<BiometricUnlockResult> {
  const native = bridge();
  if (!native) return Promise.resolve({ ok: false, reason: 'unsupported' });
  installHandler();
  const requestId = `bio-${Date.now()}-${(sequence += 1)}`;
  return new Promise<BiometricUnlockResult>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      resolve({ ok: false, reason: 'timeout' });
    }, UNLOCK_TIMEOUT_MS);
    pending.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      native.unlock(requestId);
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve({ ok: false, reason: 'failed' });
    }
  });
}

/** 没有可用解锁方式时，给用户一个去系统设置录入的台阶 */
export function openSystemSecuritySettings(): void {
  try {
    bridge()?.openSecuritySettings();
  } catch {
    // 忽略：个别 ROM 没有这个入口
  }
}

/** 按钮文案按设备能力取，不写死「指纹」（人脸设备上也叫得通） */
export function biometricButtonLabel(kind: BiometricKind): string {
  return kind === 'credential' ? '用锁屏密码解锁' : '用指纹 / 人脸解锁';
}
