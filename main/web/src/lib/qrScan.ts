/**
 * 摄像头扫码：把 `<video>` 里的画面切片交给 jsqr 解码，读出一条邀请链接。
 *
 * 分工：
 *  - 本模块管「开流 → 抽帧 → 解码 → 收尾」，不认识二维码里装的是什么；
 *  - 界面（components/ui/QrScannerOverlay.vue）只管画取景框、按钮和提示；
 *  - 权限：安卓壳层的 WebView 由 Capacitor 的 WebChromeClient 按需向系统申请 CAMERA
 *    （见 mobile/android 的 AndroidManifest），浏览器则由系统弹权限框——本模块只负责把
 *    「被拒绝」「没有摄像头」「不是安全上下文」翻译成人话。
 *
 * 只在用户点了「扫码」时才动态 `import('jsqr')`：解码库不进主包，也不影响没用到扫码的页面。
 * 安全上下文要求（浏览器只允许 https / localhost 调摄像头）与本应用的两种运行形态天然吻合：
 * 桌面端/网页端开在 127.0.0.1 或局域网 https，安卓端开在 Capacitor 的 https://localhost。
 */

export type QrCameraFacing = 'environment' | 'user';

export interface QrCameraSession {
  /** 停止抽帧并关闭摄像头（务必在关闭浮层/组件卸载时调用，否则指示灯一直亮着） */
  stop(): void;
  /** 在前置/后置之间切换；没有第二个摄像头时抛错，由界面提示 */
  switchCamera(): Promise<void>;
  /** 当前朝向 */
  facing(): QrCameraFacing;
}

export interface QrCameraOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onResult: (text: string) => void;
  onError?: (message: string) => void;
}

/** 抽帧节奏：jsqr 解一张 720 宽的帧约 10–40ms，120ms 一帧既跟得上手也几乎不占 CPU */
const SCAN_INTERVAL_MS = 120;
/** 送进解码器的画面最长边：太大只是浪费 CPU，二维码在 720px 里已经足够清晰 */
const MAX_SCAN_EDGE = 720;

type JsQrDecoder = typeof import('jsqr').default;

let decoderPromise: Promise<JsQrDecoder> | null = null;

/** 懒加载解码器：第一次扫码时才把 jsqr 拉进包（同一会话里复用同一个 Promise） */
function loadDecoder(): Promise<JsQrDecoder> {
  if (!decoderPromise) {
    decoderPromise = import('jsqr').then((module) => module.default);
  }
  return decoderPromise;
}

/** 这台设备/这个页面能不能调摄像头（不能时界面给出原因，而不是渲染一个点了没反应的按钮） */
export function cameraScanSupport(): { supported: boolean; reason: string } {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      supported: false,
      reason: '当前打开方式不支持调用摄像头：浏览器只允许在 https 或 localhost 页面里使用摄像头，'
        + '请用 Engram 桌面端/手机 App，或通过中枢的 https 域名打开。',
    };
  }
  return { supported: true, reason: '' };
}

/** 把 getUserMedia 的失败原因翻译成人话（原始报错全是英文术语，界面上不能直接给用户看） */
export function cameraErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '没有拿到摄像头权限：请在系统设置里允许 Engram（或当前浏览器）使用摄像头，然后重试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '这台设备上没有找到可用的摄像头。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头被其他程序占用了（或被系统隐私开关禁用），请关掉占用它的程序后重试。';
  }
  if (name === 'OverconstrainedError') {
    return '这台设备的摄像头不满足扫码所需的分辨率，请在相机设置里检查后重试。';
  }
  const message = (error as { message?: string } | null)?.message;
  return message ? `打开摄像头失败：${message}` : '打开摄像头失败，请重试。';
}

/**
 * 打开摄像头并开始抽帧解码；返回的会话负责停止与切换。
 * 第一次取流失败会抛错（调用方用 cameraErrorMessage 显示原因）。
 */
export async function startCameraScan(options: QrCameraOptions): Promise<QrCameraSession> {
  const { video, canvas, onResult, onError } = options;
  let facing: QrCameraFacing = 'environment';
  let stream: MediaStream | null = null;
  let timer: number | null = null;
  let stopped = false;

  const openStream = async (want: QrCameraFacing): Promise<MediaStream> => {
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: { facingMode: { ideal: want }, width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      // 台式机/前置摄像头设备上 environment 可能选不出设备：退回「有哪个用哪个」
      if ((error as { name?: string } | null)?.name === 'OverconstrainedError' || (error as { name?: string } | null)?.name === 'NotFoundError') {
        return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      throw error;
    }
  };

  const attach = async (want: QrCameraFacing): Promise<void> => {
    const next = await openStream(want);
    stream = next;
    facing = want;
    video.srcObject = next;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    await video.play().catch(() => {
      // 自动播放被拦时也要继续：用户点一下取景框会触发 play（见组件里的提示）
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        const scale = Math.min(1, MAX_SCAN_EDGE / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context) {
          context.drawImage(video, 0, 0, width, height);
          const frame = context.getImageData(0, 0, width, height);
          const decoder = await loadDecoder();
          if (stopped) return;
          // dontInvert：屏幕对屏幕扫码不会出现反色二维码，省掉一次全图反转尝试
          const decoded = decoder(frame.data, width, height, { inversionAttempts: 'dontInvert' });
          if (decoded?.data) {
            stop();
            onResult(decoded.data);
            return;
          }
        }
      }
    } catch (error) {
      // 解码异常不该让循环停掉（坏帧继续下一张），但要告诉界面一次，避免静默失效
      onError?.(cameraErrorMessage(error));
    }
    if (!stopped) timer = window.setTimeout(() => { void tick(); }, SCAN_INTERVAL_MS);
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    const tracks = stream?.getTracks() || [];
    for (const track of tracks) track.stop();
    stream = null;
    if (video.srcObject) video.srcObject = null;
  };

  try {
    await attach(facing);
  } catch (error) {
    stop();
    throw error;
  }
  timer = window.setTimeout(() => { void tick(); }, 0);

  return {
    stop,
    facing: () => facing,
    switchCamera: async () => {
      if (stopped) return;
      const next: QrCameraFacing = facing === 'environment' ? 'user' : 'environment';
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      const tracks = stream?.getTracks() || [];
      for (const track of tracks) track.stop();
      stream = null;
      await attach(next);
      if (!stopped) timer = window.setTimeout(() => { void tick(); }, 0);
    },
  };
}
