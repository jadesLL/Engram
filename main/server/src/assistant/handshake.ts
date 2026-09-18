/**
 * 内置 Agent 的 dsh 握手策略：超时预算 + 失败重试。
 *
 * 为什么需要这一层：`@deepseek-ai/dsh-sdk-client` 对 `initialize` 握手硬编码了 10s 默认预算
 * （`DEFAULT_INITIALIZE_TIMEOUT_MS = 10000`），而**冷启动**明显慢于热启动——升级/自动重启后
 * 第一次 spawn `dsh --profile sdk` 时，代码刚重建完、杀软还在扫新文件、页缓存是冷的、
 * 宿主自身启动也在抢 CPU/IO。本机实测热启动约 2.8s，冷启动会越过 10s，界面就直接报
 * `initialize timed out after 10000ms waiting for dsh profile "sdk"`；手动重启（第二次 spawn
 * 已经热了）即恢复。所以这里放宽首次预算，并对握手失败自动重试一次。
 *
 * 只重试握手，不重试整轮对话：`HarnessSession.run()` 内部就是先 `await harness.start()`
 * 再投 prompt，所以先显式 `start()`、再 `run()`，重试范围只覆盖握手，同一轮 prompt 不会被
 * 重复投递。SDK 的 `start()` 失败后会清掉 memo 并换一个全新 client，重试是官方支持路径。
 */

/** 握手超时预算（SDK 默认 10s 对升级后第一次 spawn 太紧；放宽到 60s） */
export const INITIALIZE_TIMEOUT_MS = 60_000;

/** 握手失败后的额外重试次数（首次 + 1 次重试） */
export const HANDSHAKE_RETRIES = 1;

/** 重试前的等待：给刚重启的宿主一点时间让文件与进程热起来 */
export const HANDSHAKE_RETRY_DELAY_MS = 1_000;

/** 只依赖 `start()`，便于单测注入假实现（不引入 SDK 依赖） */
export interface Startable {
  start(): Promise<unknown>;
}

export interface HandshakeRetryOptions {
  /** 额外重试次数，默认 {@link HANDSHAKE_RETRIES} */
  retries?: number;
  /** 每次重试前的等待毫秒数，默认 {@link HANDSHAKE_RETRY_DELAY_MS} */
  delayMs?: number;
  /** 等待实现（测试注入用） */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 显式完成一次握手：失败按 `retries` 重试，全部失败则抛出最后一次的错误。
 * 成功后 harness 内部的握手 memo 已就绪，随后的 `run()` 直接复用，不再重复握手。
 */
export async function startWithRetry(
  target: Startable,
  options: HandshakeRetryOptions = {}
): Promise<void> {
  const retries = Math.max(0, options.retries ?? HANDSHAKE_RETRIES);
  const delayMs = Math.max(0, options.delayMs ?? HANDSHAKE_RETRY_DELAY_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await target.start();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastError;
}
