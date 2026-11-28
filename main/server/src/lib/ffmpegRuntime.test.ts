import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-ffmpeg-runtime-'));
process.env.DATA_DIR = temp;

let mod: typeof import('./ffmpegRuntime.js');

before(async () => {
  mod = await import('./ffmpegRuntime.js');
});

after(() => {
  try {
    fs.rmSync(temp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

test('ffmpegPlatformKey / ffmpegSupported：只认已钉死的平台资产', () => {
  assert.equal(mod.ffmpegPlatformKey('win32', 'x64'), 'win32-x64');
  assert.equal(mod.ffmpegSupported('win32', 'x64'), true);
  assert.equal(mod.ffmpegSupported('linux', 'x64'), true);
  assert.equal(mod.ffmpegSupported('linux', 'arm64'), true);
  assert.equal(mod.ffmpegSupported('darwin', 'arm64'), false, '没提供构建的平台要降级为只放封面');
});

test('ffmpegBinaryName：Windows 加 .exe，其它平台不带后缀', () => {
  assert.equal(mod.ffmpegBinaryName('win32'), 'ffmpeg.exe');
  assert.equal(mod.ffmpegBinaryName('linux'), 'ffmpeg');
});

test('ffmpegRuntimeDir：落在 <数据目录>/runtime/ffmpeg/<平台>-<架构>', () => {
  const dir = mod.ffmpegRuntimeDir('linux', 'x64');
  assert.equal(dir, path.join(temp, 'runtime', 'ffmpeg', 'linux-x64'));
});

test('installedFfmpegPath：优先 VIDEO_FFMPEG_PATH，其次运行时目录；未安装返回 null', () => {
  const previous = process.env.VIDEO_FFMPEG_PATH;
  const override = path.join(temp, 'custom-ffmpeg');
  fs.writeFileSync(override, 'fake');
  process.env.VIDEO_FFMPEG_PATH = override;
  try {
    assert.equal(mod.installedFfmpegPath('linux', 'x64'), override);
    delete process.env.VIDEO_FFMPEG_PATH;
    assert.equal(mod.installedFfmpegPath('linux', 'x64'), null);

    const runtime = path.join(temp, 'runtime', 'ffmpeg', 'linux-x64');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'ffmpeg'), 'fake');
    assert.equal(mod.installedFfmpegPath('linux', 'x64'), path.join(runtime, 'ffmpeg'));
  } finally {
    if (previous === undefined) delete process.env.VIDEO_FFMPEG_PATH;
    else process.env.VIDEO_FFMPEG_PATH = previous;
  }
});

test('ensureFfmpeg：明确禁止下载且本机没有时返回 null，不联网', async () => {
  const previous = process.env.VIDEO_FFMPEG_PATH;
  delete process.env.VIDEO_FFMPEG_PATH;
  try {
    // 前面的用例在 linux-x64 运行时目录放了假文件；这里先清掉，确保「本机没有」
    fs.rmSync(path.join(temp, 'runtime'), { recursive: true, force: true });
    const result = await mod.ensureFfmpeg({ download: false });
    assert.equal(result, null);
  } finally {
    if (previous !== undefined) process.env.VIDEO_FFMPEG_PATH = previous;
  }
});
