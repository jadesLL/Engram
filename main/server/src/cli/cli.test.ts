import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RAW_DIR,
  clampInt,
  extensionForMime,
  extensionOf,
  formatKb,
  isPrivateAddress,
  maskToken,
  parseEvidenceItems,
  tempFilePath,
} from './cli.js';
import { isPrivateAddress as sharedIsPrivateAddress } from './net.js';
import { DEFAULT_RAW_DIR as serverDefaultRawDir } from '../lib/rawSections.js';

test('maskToken 保留可辨认前缀与末 4 位，不泄露完整令牌', () => {
  assert.equal(maskToken(''), '（未配置）');
  assert.equal(maskToken('short'), 'sh****');
  const masked = maskToken('lwiki_0123456789abcdef0123456789abcdef');
  assert.ok(!masked.includes('0123456789abcdef0123456789abcdef'));
  assert.match(masked, /^lwiki_/);
  assert.match(masked, /cdef$/);
});

test('parseEvidenceItems 支持 :: 与 | 两种分隔符，非法格式抛错', () => {
  assert.deepEqual(parseEvidenceItems(['原始资料/文档/a.md::逐字引文']), [
    { path: '原始资料/文档/a.md', quote: '逐字引文' },
  ]);
  assert.deepEqual(parseEvidenceItems(['原始资料/文档/a.md|逐字引文']), [
    { path: '原始资料/文档/a.md', quote: '逐字引文' },
  ]);
  assert.throws(() => parseEvidenceItems(['没有分隔符']), /证据格式无效/);
});

test('formatKb 与旧 MCP 文本口径一致（一律 KB 取整）', () => {
  assert.equal(formatKb(0), '0KB');
  assert.equal(formatKb(512), '1KB');
  assert.equal(formatKb(1024), '1KB');
  assert.equal(formatKb(1536), '2KB');
});

test('extensionForMime / extensionOf 覆盖落盘扩展名', () => {
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/jpeg; charset=binary'), 'jpg');
  assert.equal(extensionForMime('application/octet-stream'), 'bin');
  assert.equal(extensionOf('原始资料/文档/a.PDF'), 'pdf');
  assert.equal(extensionOf('/media/abc/x.png?x=1'), 'png');
  assert.equal(extensionOf('没有扩展名'), '');
});

test('tempFilePath 落在系统临时目录且带扩展名', () => {
  const file = tempFilePath('png', 1700000000000, 0.5);
  assert.equal(path.dirname(file), os.tmpdir());
  assert.match(path.basename(file), /^engram-1700000000000-[0-9a-f]{6}\.png$/);
});

test('clampInt 非法值回退默认、超界夹紧', () => {
  assert.equal(clampInt(undefined, 8, 1, 30), 8);
  assert.equal(clampInt('abc', 8, 1, 30), 8);
  assert.equal(clampInt('0', 8, 1, 30), 1);
  assert.equal(clampInt('99', 8, 1, 30), 30);
  assert.equal(clampInt('12.9', 8, 1, 30), 12);
});

test('CLI 内联的 DEFAULT_RAW_DIR 与 lib/rawSections 同值（单文件化后唯一允许的重复常量）', () => {
  assert.equal(DEFAULT_RAW_DIR, serverDefaultRawDir);
});

test('CLI 内联的 isPrivateAddress 与 server 共用副本判定一致（防止两处漂移）', () => {
  const samples = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '203.0.113.5', '224.0.0.1', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::1',
    '2001:db8::1', 'fe80::1', 'not-an-ip',
  ];
  for (const sample of samples) {
    assert.equal(isPrivateAddress(sample), sharedIsPrivateAddress(sample), 'IP 判定不一致: ' + sample);
  }
});

test('cli.ts 源码不引入任何相对导入（远程单文件下载的前提）', () => {
  const source = fs.readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
  const relativeImports = source
    .split('\n')
    .filter((line) => /^import\b.*from\s+['"]\.\.?\//.test(line));
  assert.deepEqual(relativeImports, []);
  assert.doesNotMatch(source, /require\(\s*['"]\.\.?\//);
});

const builtCli = [
  path.join(process.cwd(), 'dist', 'cli', 'cli.js'),
  path.join(process.cwd(), 'server', 'dist', 'cli', 'cli.js'),
].find((candidate) => fs.existsSync(candidate));

test('dist/cli/cli.js 构建产物不含相对 import/require（未构建时跳过）', {
  skip: builtCli ? false : '未找到 dist/cli/cli.js（本地离线兜底先 test 后 build 时跳过）',
}, () => {
  const source = fs.readFileSync(builtCli as string, 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node/);
  const relativeImports = source
    .split('\n')
    .filter((line) => /^\s*import\b.*from\s+['"]\.\.?\//.test(line));
  assert.deepEqual(relativeImports, []);
  assert.doesNotMatch(source, /require\(\s*['"]\.\.?\//);
  // 远程单文件运行所需的模块都在：Node 内置导入 + 内联实现
  assert.match(source, /function validateTarget\(/);
  assert.match(source, /function maskToken\(/);
});
