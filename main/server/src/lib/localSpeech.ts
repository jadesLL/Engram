import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 本机离线语音识别（Windows SAPI，`System.Speech`）。
 *
 * 为什么需要它：内置 Agent 的默认模型多半只声明文本 / 图片输入（DeepSeek 就是），
 * 直接发音频会被上游拒绝。这里用 Windows 自带的语音识别器把 WAV 离线转成文字，
 * 再交给「插入正文」链路——不联网、不要 Key、不花钱。
 *
 * 边界：
 *  - 只在 Windows 桌面端可用（Docker/Linux 没有 SAPI；手机本身不跑转写）；
 *  - 识别质量取决于系统装的语言包，中文 Windows 一般自带 zh-CN 识别器；
 *  - 录音仍然由浏览器按用户选中的麦克风采（所以「换麦克风」照旧生效），
 *    这里只处理已经编码好的 WAV；
 *  - 临时 WAV / 结果文件在 finally 里删除，不进日志、不进同步。
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

export function localSpeechPlatformSupported(): boolean {
  return process.platform === 'win32';
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

/** 本机有没有可用的 SAPI 识别器（仅 Windows；结果缓存 5 分钟） */
export async function localSpeechAvailability(force = false): Promise<{ available: boolean; detail: string }> {
  if (!localSpeechPlatformSupported()) {
    return { available: false, detail: '本机离线识别只在 Windows 桌面端可用' };
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
    const detail = `本机离线识别不可用：${error?.message || '探测失败'}`;
    probeCache = { at: Date.now(), available: false, detail };
    return { available: false, detail };
  }
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
export async function transcribeLocalWav(wav: Buffer): Promise<{ text: string; culture: string }> {
  const availability = await localSpeechAvailability();
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
