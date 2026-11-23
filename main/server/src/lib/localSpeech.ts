import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  senseVoiceStatus,
  transcribeSenseVoice,
  type SenseVoiceStatus,
} from './senseVoice.js';
import { SENSEVOICE_TOTAL_BYTES } from './senseVoiceAssets.js';

/**
 * 本机离线语音识别：SenseVoice（首选）+ Windows SAPI（兼容兜底）。
 *
 * 为什么需要它：内置 Agent 的默认模型多半只声明文本 / 图片输入（DeepSeek 就是），
 * 直接发音频会被上游拒绝；有的用户也拿不到/不想配云端 API Key。本机识别让语音输入
 * 不依赖任何 Key 就能用。
 *
 * 引擎顺序：
 *  1. **SenseVoice**（随包 sherpa-onnx）：中文准确率高、带标点，Windows / Docker 都能用；
 *     模型首次需用户点「下载」（约 240MB），之后完全离线；
 *  2. **Windows SAPI**（`System.Speech`）：模型没下载时的兼容兜底，长句/真实麦克风
 *     经常只回几个字，界面必须标明「兼容模式」；
 *  3. 都没有 → 给可操作提示（下载模型 / 配置音频模型）。
 *
 * 边界：录音由浏览器按用户选中的麦克风采，这里只处理已编码的 WAV；临时文件在 finally
 * 删除，不进日志、不进同步。SAPI 只在 Windows 有；SenseVoice 覆盖 win32-x64 / linux / macOS。
 */

/** 探测结果的缓存时长：识别器是系统组件，进程生命周期内基本不变 */
const PROBE_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 180_000;

let probeCache: { at: number; available: boolean; detail: string } | null = null;

/** 删临时目录：Windows 上脚本/子进程可能还占着文件，删不掉不能影响主流程 */
function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 下次系统清理 */
  }
}

export type LocalSpeechEngine = 'sensevoice' | 'sapi' | 'none';

export interface LocalSpeechRuntime {
  available: boolean;
  engine: LocalSpeechEngine;
  /** 菜单/提示直接展示的引擎名 */
  label: string;
  /** 为什么用这个引擎 / 模型状态 */
  detail: string;
  /** SenseVoice 模型状态（含下载进度），界面据此显示「下载模型」 */
  model: SenseVoiceStatus;
}

export interface WavAudioLevel {
  /** 平均振幅（0..1，满幅 = 1） */
  rms: number;
  /** 峰值（0..1） */
  peak: number;
  channels: number;
  sampleRate: number;
  bits: number;
}

/**
 * 量一段 WAV 的音量（只认 PCM；解析失败 / 非 PCM 返回 null）。
 *
 * 为什么要量：语音输入真正常见的故障不是「识别不准」，而是麦克风根本没采到声音
 * （选错设备、被静音、远程串流用的虚拟麦克风）。这时 SAPI 只返回空串，界面只能报
 * 「没有识别到语音」，用户会以为是识别引擎坏了、反复重试。先量音量就能直接说清原因。
 */
export function wavAudioLevel(wav: Buffer): WavAudioLevel | null {
  if (wav.length < 44) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= wav.length) {
      format = wav.readUInt16LE(offset + 8);
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(size, wav.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (format !== 1 || !channels || !bits || !dataSize) return null;
  const bytes = bits / 8;
  if (![1, 2, 3, 4].includes(bytes)) return null;
  const frames = Math.floor(dataSize / (bytes * channels));
  if (!frames) return null;
  const sample = (at: number): number => {
    if (bits === 8) return (wav.readUInt8(at) - 128) / 128;
    if (bits === 16) return wav.readInt16LE(at) / 32768;
    if (bits === 24) return wav.readIntLE(at, 3) / 8388608;
    return wav.readInt32LE(at) / 2147483648;
  };
  let sum = 0;
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = sample(dataOffset + (frame * channels + channel) * bytes);
      sum += value * value;
      const abs = Math.abs(value);
      if (abs > peak) peak = abs;
    }
  }
  return { rms: Math.sqrt(sum / (frames * channels)), peak, channels, sampleRate, bits };
}

interface RunResult {
  stdout: string;
  stderr: string;
}

/** 跑一段 PowerShell（脚本写临时 .ps1，UTF-8 BOM，避免 5.1 把中文读成 ANSI） */
function runPowerShell(script: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-speech-'));
    const scriptPath = path.join(dir, 'run.ps1');
    try {
      fs.writeFileSync(scriptPath, '\ufeff' + script.replace(/\r?\n/g, '\r\n'), 'utf8');
    } catch (error) {
      removeTempDir(dir);
      reject(error);
      return;
    }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      removeTempDir(dir);
      reject(new Error('本机语音识别超时'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeTempDir(dir);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeTempDir(dir);
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
        reject(new Error(detail || `本机语音识别退出码 ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$infos = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if ($infos.Count -eq 0) { Write-Output '0'; exit 0 }
Write-Output ('1|' + (($infos | ForEach-Object { $_.Culture.Name }) -join ','))
`;

/** Windows SAPI 探测（仅 Windows；结果缓存 5 分钟） */
async function sapiAvailability(force = false): Promise<{ available: boolean; detail: string }> {
  if (process.platform !== 'win32') {
    return { available: false, detail: 'Windows 语音识别只在 Windows 可用' };
  }
  if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return { available: probeCache.available, detail: probeCache.detail };
  }
  try {
    const { stdout } = await runPowerShell(PROBE_SCRIPT, [], PROBE_TIMEOUT_MS);
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const available = line.startsWith('1|');
    const cultures = available ? line.slice(2).split(',').filter(Boolean) : [];
    const detail = available
      ? `Windows 语音识别（${cultures.join(' / ') || '已安装'}）`
      : 'Windows 没有安装语音识别语言包';
    probeCache = { at: Date.now(), available, detail };
    return { available, detail };
  } catch (error: any) {
    const detail = `Windows 语音识别不可用：${error?.message || '探测失败'}`;
    probeCache = { at: Date.now(), available: false, detail };
    return { available: false, detail };
  }
}

/** 本机识别当前用哪个引擎：SenseVoice 优先，Windows SAPI 兼容兜底 */
export async function localSpeechRuntime(): Promise<LocalSpeechRuntime> {
  const model = await senseVoiceStatus();
  if (model.supported && model.ready) {
    return {
      available: true,
      engine: 'sensevoice',
      label: '本机离线识别（SenseVoice）',
      detail: '本地模型，离线可用',
      model,
    };
  }
  const sapi = await sapiAvailability();
  if (sapi.available) {
    const percent = Math.floor((model.downloadedBytes / SENSEVOICE_TOTAL_BYTES) * 100);
    const why = model.phase === 'preparing'
      ? `SenseVoice 模型正在下载（${percent}%）`
      : 'SenseVoice 模型还没下载';
    return {
      available: true,
      engine: 'sapi',
      label: 'Windows 语音识别（兼容模式）',
      detail: `系统自带识别，准确率有限；${why}`,
      model,
    };
  }
  const detail = model.error
    || (model.supported
      ? '本机识别模型还没下载（约 240MB）'
      : '当前平台没有可用的本机识别运行时');
  return { available: false, engine: 'none', label: '本机离线识别', detail, model };
}

const TRANSCRIBE_SCRIPT = `
param([string]$WavePath, [string]$OutPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$infos = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if ($infos.Count -eq 0) { throw 'NO_RECOGNIZER' }
$preferred = $infos | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
if (-not $preferred) { $preferred = $infos | Select-Object -First 1 }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($preferred)
$engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(10)
$engine.BabbleTimeout = [TimeSpan]::FromSeconds(10)
$engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(600)
$engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(800)
$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$engine.SetInputToWaveFile($WavePath)
$parts = New-Object System.Collections.Generic.List[string]
while ($true) {
  $result = $null
  try { $result = $engine.Recognize() } catch { break }
  if ($null -eq $result) { break }
  if ($result.Text) { $parts.Add($result.Text) }
}
$engine.Dispose()
$json = ConvertTo-Json @{ text = ($parts -join ''); culture = $preferred.Culture.Name } -Compress
[System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'OK'
`;

/** 用本机 SAPI 识别一段 WAV（16k 单声道 PCM）；没识别到内容返回空串 */
async function transcribeSapiWav(wav: Buffer): Promise<{ text: string; culture: string }> {
  const availability = await sapiAvailability();
  if (!availability.available) throw new Error(availability.detail);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-speech-'));
  const wavPath = path.join(dir, 'input.wav');
  const outPath = path.join(dir, 'result.json');
  try {
    fs.writeFileSync(wavPath, wav);
    await runPowerShell(TRANSCRIBE_SCRIPT, ['-WavePath', wavPath, '-OutPath', outPath], TRANSCRIBE_TIMEOUT_MS);
    let parsed: any = null;
    try {
      parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch {
      throw new Error('本机语音识别没有返回结果');
    }
    return { text: String(parsed?.text || ''), culture: String(parsed?.culture || '') };
  } finally {
    removeTempDir(dir);
  }
}

/** 本机识别的可操作提示：模型没下载 / 正在下载 / 平台不支持 */
function localPrepareHint(runtime: LocalSpeechRuntime): string {
  if (runtime.model.phase === 'preparing') {
    const percent = Math.floor((runtime.model.downloadedBytes / SENSEVOICE_TOTAL_BYTES) * 100);
    return `本机识别模型正在下载（${percent}%），完成后即可使用；也可以先配置一个支持音频的模型`;
  }
  if (!runtime.model.supported) {
    return `当前平台没有可用的本机识别运行时${runtime.model.error ? `：${runtime.model.error}` : ''}`;
  }
  return '本机识别模型还没下载（约 240MB）：在语音输入菜单点「下载模型」，或到 设置 → 外设接入 → 语音输入';
}

/** 本机转写：SenseVoice 优先，SAPI 兼容兜底 */
export async function transcribeLocalWav(wav: Buffer): Promise<{ text: string; culture: string }> {
  const runtime = await localSpeechRuntime();
  if (runtime.engine === 'sensevoice') {
    const result = await transcribeSenseVoice(wav);
    return { text: result.text, culture: 'auto' };
  }
  if (runtime.engine === 'sapi') return transcribeSapiWav(wav);
  throw new Error(localPrepareHint(runtime));
}
