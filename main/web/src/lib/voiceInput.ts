import { api } from '../api';

/**
 * 编辑器「语音输入」的采集侧：设备枚举 / 录音 / WAV 编码 / 转写请求。
 *
 * 口径（2026-11）：
 *  - **默认跟随系统**：不传 deviceId 时由浏览器/Electron/WebView 走系统默认输入设备，
 *    与系统「声音设置」里的默认麦克风保持一致；用户也可以在这里换成指定设备。
 *  - 设备选择是本机偏好（localStorage），不参与多端同步——同一份设备 id 在另一台机器上没有意义。
 *  - 浏览器只允许安全上下文调用麦克风（https / localhost）；Docker 走 http 局域网地址时要明确告知。
 *  - 录音统一转成 **WAV 16k 单声道 PCM16** 再上送：Omni 模型只认常见音频格式，
 *    各端 MediaRecorder 产出的 webm/mp4 在服务端解码不可控，浏览器侧一次转好最稳。
 */

/** 本机麦克风偏好（'auto' = 跟随系统，不传 deviceId） */
export const VOICE_DEVICE_STORAGE_KEY = 'engram.voiceInput.deviceId';
/** 单次录音最长 120 秒（与服务端 SPEECH_UI_MAX_DURATION_SEC 对齐） */
export const VOICE_MAX_DURATION_SEC = 120;
/** 上送目标采样率 */
const TARGET_SAMPLE_RATE = 16000;

export type VoiceDevicePreference = 'auto' | string;

export interface VoiceInputDevice {
  deviceId: string;
  label: string;
}

export interface VoiceDeviceList {
  devices: VoiceInputDevice[];
  /** 没拿到麦克风权限时浏览器会把 label 清空，只能显示「麦克风 1/2」 */
  labelsAvailable: boolean;
}

export interface SpeechEngineOption {
  /** `local` 或 `model:<provider>:<model>` */
  id: string;
  kind: 'local' | 'model';
  label: string;
  detail: string;
  available: boolean;
}

export interface SpeechModelInfo {
  provider: string;
  providerName: string;
  model: string;
  modelName: string;
  supportsAudio: boolean;
  inputs: string[];
}

export interface SpeechStatus {
  configured: boolean;
  engines: SpeechEngineOption[];
  /** 自动选择结果（空串 = 没有可用引擎） */
  defaultEngine: string;
  /** 为什么自动选了它 */
  defaultEngineReason: string;
  defaultModel: SpeechModelInfo | null;
  localAvailable: boolean;
  localDetail: string;
  hint: string;
  maxDurationSec: number;
  maxBytes: number;
}

/** 这台设备/这个页面能不能录音；不能时给一句可读原因，而不是点下去没反应 */
export function voiceInputSupport(): { supported: boolean; reason: string } {
  if (typeof window === 'undefined') return { supported: false, reason: '当前环境不支持录音' };
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason:
        '当前打开方式不支持调用麦克风：浏览器只允许在 https 或 localhost 页面里录音。'
        + '请用 Engram 桌面端/手机 App，或通过中枢的 https 域名打开。',
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { supported: false, reason: '当前浏览器不支持录音（缺少 getUserMedia）' };
  }
  if (typeof MediaRecorder === 'undefined') {
    return { supported: false, reason: '当前浏览器不支持录音（缺少 MediaRecorder）' };
  }
  return { supported: true, reason: '' };
}

/** 本机记住的麦克风；读不到（隐私模式 / 老版本）按「自动」处理 */
export function loadVoiceDevicePreference(): VoiceDevicePreference {
  try {
    const raw = localStorage.getItem(VOICE_DEVICE_STORAGE_KEY) || '';
    return raw && raw !== 'auto' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

/** 记住麦克风；写不进去（隐私模式）时至少本次会话仍然按内存里的值走 */
export function saveVoiceDevicePreference(preference: VoiceDevicePreference): void {
  try {
    if (!preference || preference === 'auto') localStorage.removeItem(VOICE_DEVICE_STORAGE_KEY);
    else localStorage.setItem(VOICE_DEVICE_STORAGE_KEY, preference);
  } catch {
    /* 存不住不影响本次录音 */
  }
}

/**
 * 列出输入设备。Chrome/Electron 会额外给 default / communications 两个伪设备（指向同一支麦克风），
 * 统一过滤掉——「跟随系统」就是 default 的语义，真正的设备只留物理设备。
 */
export async function listVoiceDevices(): Promise<VoiceDeviceList> {
  if (!navigator.mediaDevices?.enumerateDevices) return { devices: [], labelsAvailable: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter(
    (device) =>
      device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications'
  );
  const devices = inputs.map((device, index) => ({
    deviceId: device.deviceId,
    label: device.label || `麦克风 ${index + 1}`,
  }));
  return { devices, labelsAvailable: inputs.some((device) => Boolean(device.label)) };
}

/** 录音约束：auto 不传 deviceId（= 系统默认），指定设备用 exact（设备被拔掉时调用方退回 auto） */
export function audioConstraintsFor(preference: VoiceDevicePreference): MediaStreamConstraints {
  if (!preference || preference === 'auto') return { audio: true };
  return {
    audio: {
      deviceId: { exact: preference },
      // 语音输入不需要立体声/高采样率，让系统先降到单声道语音档，省带宽也少噪声
      channelCount: { ideal: 1 },
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
    },
  };
}

/** getUserMedia / 录音失败的原始英文术语 → 界面能给人看的中文 */
export function voiceInputErrorMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '没有拿到麦克风权限：请在系统设置里允许 Engram（或当前浏览器）使用麦克风，然后重试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '这台设备上没有找到可用的麦克风。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被其他程序占用了（或被系统隐私开关禁用），请关掉占用它的程序后重试。';
  }
  if (name === 'OverconstrainedError') {
    return '选中的麦克风已经不在了（可能被拔出或禁用），已切回「自动（跟随系统）」。';
  }
  if (name === 'NotSupportedError') {
    return '当前环境不支持这种录音格式，请用 Engram 桌面端/手机 App 或较新的浏览器。';
  }
  const message = (error as { message?: string } | null)?.message;
  return message ? `录音失败：${message}` : '录音失败，请重试。';
}

/** 一段录音的产物：WAV blob + 实际时长 */
export interface VoiceRecording {
  blob: Blob;
  durationSec: number;
}

export interface VoiceRecordHandlers {
  /** 音量 0..1（已做平滑），用于面板上的电平条 */
  onLevel?: (level: number) => void;
  /** 每秒一次：已录秒数 */
  onTick?: (seconds: number) => void;
  /** 到了最长时长自动停止（调用方在这里走正常的 stop 流程） */
  onMaxDuration?: () => void;
}

/* ------------------------------------------------------------------ *
 * WAV 编码
 * ------------------------------------------------------------------ */

/** Float32 [-1,1] → 16bit PCM WAV */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** 解码任意浏览器能解的音频 → 降混单声道 + 线性重采样到 16k → WAV */
export async function toWavBlob(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtor) throw new Error('当前环境不支持音频处理');
  const ctx: AudioContext = new AudioCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    void ctx.close().catch(() => {});
  }
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    channels.push(decoded.getChannelData(channel));
  }
  const srcRate = decoded.sampleRate || TARGET_SAMPLE_RATE;
  const frames = Math.max(1, Math.round(decoded.duration * TARGET_SAMPLE_RATE));
  const out = new Float32Array(frames);
  const ratio = srcRate / TARGET_SAMPLE_RATE;
  const last = decoded.length - 1;
  for (let i = 0; i < frames; i += 1) {
    const pos = i * ratio;
    const i0 = Math.min(Math.floor(pos), last);
    const i1 = Math.min(i0 + 1, last);
    const frac = pos - i0;
    let sum = 0;
    for (const channel of channels) {
      sum += channel[i0] * (1 - frac) + channel[i1] * frac;
    }
    out[i] = sum / channels.length;
  }
  return encodeWav(out, TARGET_SAMPLE_RATE);
}

/* ------------------------------------------------------------------ *
 * 录音器
 * ------------------------------------------------------------------ */

/** 优先 opus/webm；Chromium 系都支持。取不到时让浏览器自己选默认容器 */
function recorderMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* 忽略 */
    }
  }
  return '';
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuffer: Float32Array | null = null;
  private raf = 0;
  private maxTimer = 0;
  private tickTimer = 0;
  private startedAt = 0;
  private stopped = false;
  private resolveStop: ((recording: VoiceRecording) => void) | null = null;
  private rejectStop: ((error: unknown) => void) | null = null;
  /** 实际使用的设备（指定设备被占/被拔时可能是系统默认） */
  usedDeviceLabel = '';

  get active(): boolean {
    return Boolean(this.recorder && this.recorder.state !== 'inactive');
  }

  get elapsedSec(): number {
    return this.startedAt ? Math.min(VOICE_MAX_DURATION_SEC, (Date.now() - this.startedAt) / 1000) : 0;
  }

  /**
   * 开始录音。指定设备被拔掉时会自动退回「跟随系统」（与用户选择保持一致：面板显示回 auto）。
   * 返回是否退回了默认设备（调用方据此把下拉框改回 auto）。
   */
  async start(
    preference: VoiceDevicePreference,
    handlers: VoiceRecordHandlers = {},
    maxDurationSec = VOICE_MAX_DURATION_SEC
  ): Promise<{ fellBackToAuto: boolean }> {
    this.stopped = false;
    this.chunks = [];
    this.startedAt = 0;
    let fellBackToAuto = false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(audioConstraintsFor(preference));
    } catch (error: any) {
      if (error?.name === 'OverconstrainedError' && preference !== 'auto') {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        fellBackToAuto = true;
      } else {
        throw error;
      }
    }
    const track = this.stream.getAudioTracks()[0];
    this.usedDeviceLabel = track?.label || '';

    // 电平条：AnalyserNode 取时域 RMS，再做一个衰减平滑
    try {
      const AudioCtor = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioCtor();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);
      this.levelBuffer = new Float32Array(this.analyser.fftSize);
      let smoothed = 0;
      const pump = () => {
        if (!this.analyser || this.stopped) return;
        this.analyser.getFloatTimeDomainData(this.levelBuffer!);
        let sum = 0;
        for (let i = 0; i < this.levelBuffer!.length; i += 1) sum += this.levelBuffer![i] * this.levelBuffer![i];
        const rms = Math.sqrt(sum / this.levelBuffer!.length);
        const level = Math.min(1, rms * 6);
        smoothed = smoothed * 0.6 + level * 0.4;
        handlers.onLevel?.(smoothed);
        this.raf = requestAnimationFrame(pump);
      };
      this.raf = requestAnimationFrame(pump);
    } catch {
      // 电平条拿不到不影响录音本身
    }

    const mimeType = recorderMimeType();
    this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = (event: any) => {
      this.rejectStop?.(event?.error || new Error('录音失败'));
      this.cleanup();
    };
    this.recorder.onstop = () => {
      void this.finish();
    };
    this.recorder.start(250);
    this.startedAt = Date.now();

    handlers.onTick?.(0);
    this.tickTimer = window.setInterval(() => {
      handlers.onTick?.(Math.floor(this.elapsedSec));
    }, 500);
    this.maxTimer = window.setTimeout(() => {
      handlers.onMaxDuration?.();
    }, Math.max(1, maxDurationSec) * 1000);
    return { fellBackToAuto };
  }

  /** 停止并拿到 WAV；没在录时抛错 */
  stop(): Promise<VoiceRecording> {
    if (!this.recorder) return Promise.reject(new Error('还没有开始录音'));
    if (this.stopped) return Promise.reject(new Error('录音已经结束'));
    // 时长以开始/停止的实际间隔为准，不用 MediaRecorder 的容器元数据
    this.pendingDuration = this.elapsedSec;
    this.stopped = true;
    return new Promise<VoiceRecording>((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
      try {
        this.recorder?.stop();
      } catch (error) {
        this.cleanup();
        reject(error);
      }
    });
  }

  private pendingDuration = 0;

  /** 外部强制收尾（关闭面板/切页面）：不产出结果 */
  cancel(): void {
    this.stopped = true;
    this.resolveStop = null;
    this.rejectStop = null;
    try {
      this.recorder?.stop();
    } catch {
      /* 忽略 */
    }
    this.cleanup();
  }

  private async finish(): Promise<void> {
    const resolve = this.resolveStop;
    const reject = this.rejectStop;
    const durationSec = this.pendingDuration || this.elapsedSec;
    this.resolveStop = null;
    this.rejectStop = null;
    const chunks = this.chunks;
    this.cleanup();
    if (!resolve) return;
    try {
      const raw = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
      if (!raw.size) throw new Error('没有录到声音');
      const blob = await toWavBlob(raw);
      resolve({ blob, durationSec });
    } catch (error) {
      reject?.(error);
    }
  }

  private cleanup(): void {
    this.stopped = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = 0;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = 0;
    try {
      this.analyser?.disconnect();
      void this.audioCtx?.close().catch(() => {});
    } catch {
      /* 忽略 */
    }
    this.analyser = null;
    this.audioCtx = null;
    this.levelBuffer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }
}

/* ------------------------------------------------------------------ *
 * 服务端接口
 * ------------------------------------------------------------------ */

export async function fetchSpeechStatus(): Promise<SpeechStatus> {
  const { data } = await api.get<SpeechStatus>('/api/speech/status');
  return data;
}

/** 识别引擎偏好（本机）：'auto' 跟随服务端自动选择，其余是引擎 id（local / model:…） */
export const VOICE_ENGINE_STORAGE_KEY = 'engram.voiceInput.engine';

export function loadVoiceEnginePreference(): string {
  try {
    return localStorage.getItem(VOICE_ENGINE_STORAGE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

export function saveVoiceEnginePreference(engine: string): void {
  try {
    if (!engine || engine === 'auto') localStorage.removeItem(VOICE_ENGINE_STORAGE_KEY);
    else localStorage.setItem(VOICE_ENGINE_STORAGE_KEY, engine);
  } catch {
    /* 存不住不影响本次 */
  }
}

/** 把 WAV 上送转写；失败时把服务端的中文原因原样抛出（HUD 直接展示） */
export async function transcribeVoice(blob: Blob, engine = 'auto'): Promise<{ text: string; engineLabel: string }> {
  const form = new FormData();
  form.append('audio', blob, 'voice.wav');
  if (engine && engine !== 'auto') form.append('engine', engine);
  try {
    const { data } = await api.post<{ text: string; engineLabel?: string }>('/api/speech/transcribe', form, {
      timeout: 180_000,
    });
    return { text: String(data?.text || '').trim(), engineLabel: String(data?.engineLabel || '') };
  } catch (error: any) {
    const detail = error?.response?.data?.error || error?.message;
    throw new Error(detail || '语音识别失败，请重试');
  }
}
