#!/usr/bin/env node
/**
 * 大产物下载器：默认 IPv6 优先、失败回退 IPv4，不依赖任何写死的 -4 / -6。
 *
 * 背景（2026-11-06 实测，同一台机器、同一个 130MB 安装器）：
 *   - Gitea 域名同时有 A / AAAA 记录时，IPv6 单流 46~61 MB/s，IPv4 单流 0.56~0.80 MB/s
 *     （4 并发合计也只有约 1.4 MB/s）；
 *   - 此前发布验证脚本里每个 curl 都写了 -4，130MB 下载用了约 8 分钟；
 *   - 用 IPv6 下载同一个文件约 3 秒。
 *
 * 因此验证 / 回填 / 分发大产物统一走本脚本：按「IPv6 -> IPv4」顺序逐个地址尝试，
 * 每个协议族内部可重试，证书校验与普通 HTTPS 一致；没有 IPv6 出口的机器自动落回 IPv4，
 * 行为与以前一样，只是不再每个请求都先撞一次 IPv6 超时。
 *
 * 用法：
 *   node scripts/download-artifact.cjs --url <URL> --out <文件> [--sha256 <hex>]
 *        [--family auto|ipv6|ipv4] [--attempts 2] [--timeout-ms 30000]
 *        [--header "K: V"]... [--resolve host=address]... [--force] [--dry-run] [--quiet]
 *
 * 退出码：0 成功 / 1 下载失败 / 2 参数错误 / 3 sha256 不匹配 / 4 输出文件已存在（需 --force）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  shaMismatch: 3,
  exists: 4,
};

const MAX_REDIRECTS = 5;
const PROGRESS_INTERVAL_MS = 2000;
const USER_AGENT = 'engram-download-artifact/1';

const USAGE = [
  '用法：',
  '  node scripts/download-artifact.cjs --url <URL> --out <文件> [选项]',
  '',
  '选项：',
  '  --url <URL>            要下载的地址（http/https）',
  '  --out <文件>           输出路径；父目录不存在会自动创建',
  '  --sha256 <hex>         下载完成后校验 sha256，不一致时保留 .part 并以退出码 3 失败',
  '  --family <auto|ipv6|ipv4>',
  '                         地址族策略，默认 auto（IPv6 优先 -> IPv4 回退）；',
  '                         ipv6/ipv4 只在排查时用，日常不要写死',
  '  --attempts <n>         每个协议族的尝试次数，默认 2（1-10）',
  '  --timeout-ms <n>       单次请求的空闲超时毫秒数，默认 30000（1000-600000）',
  '  --header "K: V"        追加请求头，可重复（私有 Release 用；注意别把令牌留在 shell 历史里）',
  '  --resolve host=address 固定某主机的地址，可重复（DNS 不可用或想指定地址时用）',
  '  --force                输出文件已存在时覆盖',
  '  --dry-run              只解析地址、打印尝试计划，不发请求',
  '  --quiet                不打印进度与逐次尝试，只保留最终 DONE / 错误',
  '  -h, --help             显示本帮助',
  '',
  '示例：',
  '  node scripts/download-artifact.cjs \\',
  '    --url https://github.com/jadesLL/Engram/releases/download/installer-latest/Engram-source-setup.exe \\',
  '    --out "$TEMP/Engram-source-setup.exe" --sha256 <sha256>',
  '',
].join('\n');

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

function usageError(message) {
  return new CliError(message + '\n\n' + USAGE, EXIT.usage);
}

function parseHeader(value) {
  const index = String(value).indexOf(':');
  if (index <= 0) throw usageError('--header 需要 "名称: 值" 形式，收到：' + value);
  const name = value.slice(0, index).trim();
  const headerValue = value.slice(index + 1).trim();
  if (!name || /[\r\n]/.test(name + headerValue)) {
    throw usageError('--header 的名称/值非法');
  }
  return [name, headerValue];
}

function parseResolve(value) {
  const index = String(value).indexOf('=');
  if (index <= 0) throw usageError('--resolve 需要 "主机=地址" 形式，收到：' + value);
  const host = value.slice(0, index).trim().toLowerCase();
  const address = value.slice(index + 1).trim();
  const family = net.isIP(address);
  if (!host || !family) throw usageError('--resolve 的主体或 IP 非法：' + value);
  return { host: host, address: address, family: family };
}

function parseArgs(argv) {
  const options = {
    url: null,
    out: null,
    sha256: null,
    family: 'auto',
    attempts: 2,
    timeoutMs: 30000,
    headers: [],
    resolve: [],
    force: false,
    dryRun: false,
    quiet: false,
  };
  const take = (index, flag) => {
    if (index + 1 >= argv.length) throw usageError(flag + ' 缺少值');
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--url':
        options.url = take(i, flag);
        i += 1;
        break;
      case '--out':
        options.out = take(i, flag);
        i += 1;
        break;
      case '--sha256':
        options.sha256 = take(i, flag).trim().toLowerCase();
        i += 1;
        break;
      case '--family': {
        const value = take(i, flag).toLowerCase();
        if (!['auto', 'ipv6', 'ipv4'].includes(value)) {
          throw usageError('--family 只能是 auto / ipv6 / ipv4，收到：' + value);
        }
        options.family = value;
        i += 1;
        break;
      }
      case '--attempts': {
        const value = Number(take(i, flag));
        if (!Number.isInteger(value) || value < 1 || value > 10) {
          throw usageError('--attempts 需要 1-10 的整数');
        }
        options.attempts = value;
        i += 1;
        break;
      }
      case '--timeout-ms': {
        const value = Number(take(i, flag));
        if (!Number.isInteger(value) || value < 1000 || value > 600000) {
          throw usageError('--timeout-ms 需要 1000-600000 的整数');
        }
        options.timeoutMs = value;
        i += 1;
        break;
      }
      case '--header':
        options.headers.push(parseHeader(take(i, flag)));
        i += 1;
        break;
      case '--resolve':
        options.resolve.push(parseResolve(take(i, flag)));
        i += 1;
        break;
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(EXIT.ok);
        break;
      default:
        throw usageError('未知参数：' + flag);
    }
  }
  if (!options.url) throw usageError('缺少 --url');
  if (!options.out) throw usageError('缺少 --out');
  let parsed;
  try {
    parsed = new URL(options.url);
  } catch {
    throw usageError('--url 不是合法地址：' + options.url);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw usageError('--url 只支持 http / https，收到：' + parsed.protocol);
  }
  if (options.sha256 && !/^[0-9a-f]{64}$/.test(options.sha256)) {
    throw usageError('--sha256 需要 64 位十六进制');
  }
  return options;
}

function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function requestPath(url) {
  return url.pathname + url.search;
}

function familyLabel(family) {
  return family === 6 ? 'IPv6' : 'IPv4';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? String(value) : value.toFixed(1)) + ' ' + units[unit];
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 MB/s';
  return (bytesPerSecond / 1024 / 1024).toFixed(1) + ' MB/s';
}

/** IPv6 地址排在 IPv4 前面；ipv6 / ipv4 策略只保留对应族（排查用） */
function orderAddresses(addresses, preference) {
  const mode = preference || 'auto';
  const unique = [];
  const seen = new Set();
  for (const item of addresses) {
    if (!item || !item.address) continue;
    const family = net.isIP(item.address);
    if (!family) continue;
    const key = family + ':' + item.address;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ address: item.address, family: family });
  }
  const ipv6 = unique.filter((item) => item.family === 6);
  const ipv4 = unique.filter((item) => item.family === 4);
  if (mode === 'ipv6') return ipv6;
  if (mode === 'ipv4') return ipv4;
  return ipv6.concat(ipv4);
}

async function resolveAddresses(host, pinned) {
  const family = net.isIP(host);
  if (family) return [{ address: host, family: family }];
  const pinnedForHost = (pinned || []).filter((item) => item.host === host);
  if (pinnedForHost.length > 0) {
    return pinnedForHost.map((item) => ({ address: item.address, family: item.family }));
  }
  const records = await dns.promises.lookup(host, { all: true });
  return records.map((item) => ({ address: item.address, family: item.family }));
}

function lookupPinned(address) {
  return (hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'function') {
      lookupOptions(null, address.address, address.family);
      return;
    }
    if (lookupOptions && lookupOptions.all) {
      callback(null, [{ address: address.address, family: address.family }]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

/**
 * 单次请求：固定到某个具体地址（不走系统 happy-eyeballs），
 * 返回 { redirect } 或 { address, family, bytes, total, sha256 }。
 */
function requestOnce(url, address, options) {
  return new Promise((resolve, reject) => {
    const library = url.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    };
    for (const pair of options.headers) headers[pair[0]] = pair[1];
    const requestOptions = {
      protocol: url.protocol,
      hostname: hostOf(url),
      port: url.port || undefined,
      path: requestPath(url),
      method: 'GET',
      headers: headers,
      family: address.family,
      autoSelectFamily: false,
      lookup: lookupPinned(address),
    };
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = library.request(requestOptions, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        finish(resolve, { redirect: new URL(response.headers.location, url).toString() });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        const error = new Error('HTTP ' + status);
        error.statusCode = status;
        finish(reject, error);
        return;
      }
      const total = Number(response.headers['content-length']) || 0;
      const hash = crypto.createHash('sha256');
      const part = fs.createWriteStream(options.partPath, { flags: 'w' });
      let bytes = 0;
      let failed = false;
      const abort = (error) => {
        if (failed) return;
        failed = true;
        part.destroy();
        response.destroy();
        finish(reject, error);
      };
      response.on('data', (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
        if (options.onProgress) options.onProgress(bytes, total);
        if (!part.write(chunk)) response.pause();
      });
      part.on('drain', () => response.resume());
      response.on('end', () => {
        if (failed) return;
        if (total > 0 && bytes !== total) {
          abort(new Error('响应不完整：期望 ' + total + ' 字节，实际 ' + bytes + ' 字节'));
          return;
        }
        failed = true;
        part.end(() => {
          finish(resolve, {
            address: address.address,
            family: address.family,
            bytes: bytes,
            total: total,
            sha256: hash.digest('hex'),
          });
        });
      });
      response.on('error', abort);
      response.on('aborted', () => abort(new Error('响应被中断')));
      part.on('error', abort);
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error('空闲超时 ' + options.timeoutMs + 'ms'));
    });
    request.on('error', (error) => finish(reject, error));
    request.end();
  });
}

function isFatal(error) {
  const status = error && error.statusCode;
  if (status && status >= 400 && status < 500) return status !== 408 && status !== 429;
  return false;
}

function describeAttempt(address, error) {
  const reason = error && error.message ? error.message : String(error);
  return familyLabel(address.family) + ' ' + address.address + ' → ' + reason;
}

function makeProgressPrinter(enabled) {
  let lastAt = 0;
  return (bytes, total) => {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = now;
    const percent = total > 0 ? ' (' + Math.floor((bytes / total) * 100) + '%)' : '';
    const totalText = total > 0 ? ' / ' + formatBytes(total) : '';
    process.stderr.write('  已下载 ' + formatBytes(bytes) + totalText + percent + '\n');
  };
}

function printPlan(url, addresses, options) {
  const host = hostOf(url);
  process.stdout.write('PLAN host=' + host + '\n');
  for (const item of addresses) {
    process.stdout.write('ADDR ' + familyLabel(item.family) + ' ' + item.address + '\n');
  }
  const ordered = orderAddresses(addresses, options.family).map((item) => familyLabel(item.family));
  process.stdout.write('ORDER ' + (ordered.length > 0 ? ordered.join(' -> ') : '(无可用地址)') + '\n');
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 文件不存在就算了 */
  }
}

async function downloadArtifact(options) {
  const headers = options.headers || [];
  const pinned = options.resolve || [];
  const outPath = path.resolve(options.out);
  if (fs.existsSync(outPath) && !options.force) {
    throw new CliError('输出文件已存在：' + outPath + '（要覆盖请加 --force）', EXIT.exists);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const partPath = outPath + '.part';
  const progress = makeProgressPrinter(!options.quiet);
  let currentUrl = options.url;
  let lastError = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = new URL(currentUrl);
      const host = hostOf(url);
      let addresses;
      try {
        addresses = await resolveAddresses(host, pinned);
      } catch (error) {
        throw new CliError('解析失败：' + host + ' → ' + error.message, EXIT.failed);
      }
      if (options.dryRun) {
        printPlan(url, addresses, options);
        return { dryRun: true, url: currentUrl, addresses: addresses };
      }
      const plan = orderAddresses(addresses, options.family);
      if (plan.length === 0) {
        const resolved = addresses.length > 0
          ? '；解析到 ' + addresses.map((item) => familyLabel(item.family) + ' ' + item.address).join('、')
          : '';
        throw new CliError('没有可用地址（family=' + options.family + '）：' + host + resolved, EXIT.failed);
      }
      if (!options.quiet) {
        process.stdout.write(
          '[try] ' + host + ' 按 ' + plan.map((item) => familyLabel(item.family) + ' ' + item.address).join(' -> ') +
            ' 尝试（每族最多 ' + options.attempts + ' 次）\n',
        );
      }
      let result = null;
      const failures = [];
      for (const address of plan) {
        for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
          try {
            result = await requestOnce(url, address, {
              headers: headers,
              timeoutMs: options.timeoutMs,
              partPath: partPath,
              onProgress: progress,
            });
            break;
          } catch (error) {
            lastError = error;
            failures.push(describeAttempt(address, error));
            if (isFatal(error)) {
              throw new CliError(
                '下载失败：HTTP ' + error.statusCode + '（' + familyLabel(address.family) + ' ' + address.address + '）',
                EXIT.failed,
              );
            }
            if (attempt < options.attempts) await delay(500 * attempt);
          }
        }
        if (result) break;
      }
      if (!result) {
        throw new CliError(
          '下载失败：' + currentUrl + '\n  尝试记录：' + (failures.join('；') || '无'),
          EXIT.failed,
        );
      }
      if (result.redirect) {
        currentUrl = result.redirect;
        continue;
      }
      if (options.sha256 && result.sha256 !== options.sha256) {
        throw new CliError(
          'sha256 不匹配：期望 ' + options.sha256 + '，实际 ' + result.sha256 +
            '\n  已保留未校验的临时文件：' + partPath,
          EXIT.shaMismatch,
        );
      }
      fs.renameSync(partPath, outPath);
      return {
        address: result.address,
        family: result.family,
        bytes: result.bytes,
        sha256: result.sha256,
        out: outPath,
      };
    }
    throw new CliError('重定向次数过多（>' + MAX_REDIRECTS + '）：' + options.url, EXIT.failed);
  } catch (error) {
    if (error && error.exitCode !== EXIT.shaMismatch) removeQuietly(partPath);
    throw error;
  }
}

function formatDone(result) {
  const elapsedSeconds = (result.elapsedMs || 0) / 1000;
  const speed = elapsedSeconds > 0 ? result.bytes / elapsedSeconds : 0;
  return (
    'DONE family=' + familyLabel(result.family) + ' remote=' + result.address +
    ' bytes=' + result.bytes + ' time=' + elapsedSeconds.toFixed(1) + 's' +
    ' speed=' + formatSpeed(speed) + ' sha256=' + result.sha256
  );
}

async function main(argv) {
  const options = parseArgs(argv);
  const startedAt = Date.now();
  const result = await downloadArtifact(options);
  if (result.dryRun) return EXIT.ok;
  result.elapsedMs = Date.now() - startedAt;
  process.stdout.write(formatDone(result) + '\n');
  process.stdout.write('SAVED ' + result.out + '\n');
  return EXIT.ok;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      const exitCode = error && error.exitCode ? error.exitCode : EXIT.failed;
      process.stderr.write((error && error.message ? error.message : String(error)) + '\n');
      process.exit(exitCode);
    });
}

module.exports = {
  EXIT,
  parseArgs,
  parseHeader,
  parseResolve,
  orderAddresses,
  resolveAddresses,
  downloadArtifact,
  formatDone,
  hostOf,
  isFatal,
};
