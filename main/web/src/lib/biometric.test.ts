import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * 系统解锁桥的契约测试（2026-09-29）。
 *
 * 这套东西在真机上才跑得起来，但最容易坏的恰恰是**网页这一侧**的胶水：
 * 原生是同步字符串接口 + 一次性回调，网页要把它包成 Promise，并且
 *  - 桌面/网页端没有桥时不能假装有（否则登录页会出现点了没反应的按钮）；
 *  - 回调按 requestId 对上号（连点两次不会串台）；
 *  - 用户取消与失败要区分开（取消不该报错）。
 *
 * 这里用假 window 模拟原生桥，只测契约，不碰真实 Android。
 */

type Win = {
  EngramBiometric?: {
    status(): string;
    remember(password: string): string;
    forget(): void;
    unlock(requestId: string): void;
    openSecuritySettings(): void;
  };
  __engramBiometricResult?: (requestId: string, payload: string) => void;
};

const fakeWindow = (globalThis as { window?: Win }).window ?? {};
(globalThis as { window?: Win }).window = fakeWindow;

const mod = await import('./biometric.ts');

function installBridge(overrides: Partial<NonNullable<Win['EngramBiometric']>> = {}) {
  const calls: string[] = [];
  fakeWindow.EngramBiometric = {
    status: () => JSON.stringify({ available: true, kind: 'biometric', saved: true }),
    remember: (password: string) => {
      calls.push(`remember:${password}`);
      return JSON.stringify({ ok: true });
    },
    forget: () => calls.push('forget'),
    unlock: (requestId: string) => calls.push(`unlock:${requestId}`),
    openSecuritySettings: () => calls.push('settings'),
    ...overrides,
  };
  return calls;
}

function removeBridge() {
  delete fakeWindow.EngramBiometric;
}

test('没有原生桥（桌面/网页端）：能力查询返回 null，不假装可用', () => {
  removeBridge();
  assert.equal(mod.hasBiometricBridge(), false);
  assert.equal(mod.biometricStatus(), null);
  assert.equal(mod.rememberPassword('x'), false);
  // 不抛错即可：调用方（登录页）据此整块隐藏
  mod.forgetPassword();
  mod.openSystemSecuritySettings();
});

test('有桥时按原生返回的能力与已记住状态解析', () => {
  installBridge();
  const status = mod.biometricStatus();
  assert.deepEqual(status, { available: true, kind: 'biometric', saved: true });
  // 只有锁屏密码的设备：文案要换成「锁屏密码」，不能写死指纹
  assert.equal(mod.biometricButtonLabel('credential'), '用锁屏密码解锁');
  assert.equal(mod.biometricButtonLabel('biometric'), '用指纹 / 人脸解锁');
  removeBridge();
});

test('原生返回坏 JSON 时按「不可用」处理，不把异常抛进登录页', () => {
  installBridge({ status: () => 'not-json' });
  assert.deepEqual(mod.biometricStatus(), { available: false, kind: 'none', saved: false });
  removeBridge();
});

test('解锁：Promise 由原生回调 resolve，取消与失败都能落地', async () => {
  let lastRequestId = '';
  installBridge({
    unlock: (requestId: string) => {
      lastRequestId = requestId;
      // 模拟系统解锁成功：原生回传记住的密码
      setTimeout(() => fakeWindow.__engramBiometricResult?.(requestId, JSON.stringify({ ok: true, password: 'p@ss' })), 0);
    },
  });
  const ok = await mod.unlockWithSystem();
  assert.deepEqual(ok, { ok: true, password: 'p@ss' });
  assert.ok(lastRequestId.startsWith('bio-'));

  installBridge({
    unlock: (requestId: string) => {
      setTimeout(() => fakeWindow.__engramBiometricResult?.(requestId, JSON.stringify({ ok: false, reason: 'canceled' })), 0);
    },
  });
  const canceled = await mod.unlockWithSystem();
  assert.equal(canceled.ok, false);
  assert.equal(canceled.reason, 'canceled');
  removeBridge();
});

test('解锁回调按 requestId 对上号：并发两次不会串台', async () => {
  const resolvers: Array<() => void> = [];
  installBridge({
    unlock: (requestId: string) => {
      resolvers.push(() => fakeWindow.__engramBiometricResult?.(requestId, JSON.stringify({ ok: true, password: requestId })));
    },
  });
  const first = mod.unlockWithSystem();
  const second = mod.unlockWithSystem();
  resolvers[1]();
  resolvers[0]();
  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.password, b.password);
  assert.equal(a.password?.startsWith('bio-'), true);
  assert.equal(b.password?.startsWith('bio-'), true);
  removeBridge();
});

test('桥抛异常（原生方法不可用）时解锁以失败收场，不留挂起的 Promise', async () => {
  installBridge({
    unlock: () => {
      throw new Error('bridge gone');
    },
  });
  const result = await mod.unlockWithSystem();
  assert.deepEqual(result, { ok: false, reason: 'failed' });
  removeBridge();
});
