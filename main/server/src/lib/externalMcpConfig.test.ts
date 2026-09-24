import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  externalMcpConfigPath,
  externalMcpConfigPaths,
  externalMcpInstalled,
  externalMcpStatus,
  registerExternalMcp,
  unregisterExternalMcp,
} from './externalMcpConfig.js';

// 这些环境变量由客户端启动器设置，跑测试时可能残留，统一在无变量前提下断言
const ENV_KEYS = ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'QODER_CONFIG_DIR', 'QODERCN_CONFIG_DIR'];
const SAVED_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function withCleanEnv<T>(run: () => T): T {
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = SAVED_ENV[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-'));
}

/** 真实客户端目录：除配置文件外还有客户端自己的产物（日志等） */
function clientDir(home: string, name: string, configFile: string, config: unknown = null): string {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  if (config !== null) fs.writeFileSync(path.join(dir, configFile), typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

/** Engram 早期版本凭 mkdirSync 造出来的空壳目录：只有它自己写的那份配置；返回该配置文件路径 */
function shellDir(home: string, name: string, configFile: string, config: unknown): string {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, configFile);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

function read(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('workbuddy：WORKBUDDY_CONFIG_DIR 优先于 CODEBUDDY_CONFIG_DIR，空白视为未设置', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    process.env.CODEBUDDY_CONFIG_DIR = path.join(home, 'from-codebuddy');
    process.env.WORKBUDDY_CONFIG_DIR = path.join(home, 'from-workbuddy');
    assert.deepEqual(externalMcpConfigPaths('workbuddy', home), [path.join(home, 'from-workbuddy', 'mcp.json')]);

    process.env.WORKBUDDY_CONFIG_DIR = '   ';
    assert.deepEqual(externalMcpConfigPaths('workbuddy', home), [path.join(home, 'from-codebuddy', 'mcp.json')]);

    delete process.env.CODEBUDDY_CONFIG_DIR;
    assert.deepEqual(externalMcpConfigPaths('workbuddy', home), []);
  });
});

test('workbuddy：国内版目录与真正装过的海外版目录都维护，Engram 自造的空壳目录不算', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.workbuddy', 'mcp.json', { mcpServers: {} });
    // 只有 Engram 写下的那份配置 → 说明这台机器没有海外版客户端，不该当成已安装
    shellDir(home, '.workbuddy-ai', 'mcp.json', { mcpServers: { engram: { url: 'http://127.0.0.1:18180/mcp' } } });
    assert.deepEqual(externalMcpConfigPaths('workbuddy', home), [path.join(home, '.workbuddy', 'mcp.json')]);

    // 海外版目录里出现客户端自己的东西后，两个变体一起维护
    fs.writeFileSync(path.join(home, '.workbuddy-ai', 'settings.json'), '{}\n');
    assert.deepEqual(externalMcpConfigPaths('workbuddy', home), [
      path.join(home, '.workbuddy', 'mcp.json'),
      path.join(home, '.workbuddy-ai', 'mcp.json'),
    ]);
  });
});

test('qoder：QODER_CONFIG_DIR / QODERCN_CONFIG_DIR 设定时只维护指定目录并去重', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.qoder', 'settings.json', {});
    clientDir(home, '.qoder-cn', 'settings.json', {});
    assert.deepEqual(externalMcpConfigPaths('qoder', home), [
      path.join(home, '.qoder', 'settings.json'),
      path.join(home, '.qoder-cn', 'settings.json'),
    ]);

    process.env.QODERCN_CONFIG_DIR = path.join(home, 'cn-custom');
    assert.deepEqual(externalMcpConfigPaths('qoder', home), [path.join(home, 'cn-custom', 'settings.json')]);

    process.env.QODER_CONFIG_DIR = path.join(home, 'intl-custom');
    assert.deepEqual(externalMcpConfigPaths('qoder', home), [
      path.join(home, 'intl-custom', 'settings.json'),
      path.join(home, 'cn-custom', 'settings.json'),
    ]);

    // 两个变量指向同一目录时只写一次
    process.env.QODER_CONFIG_DIR = path.join(home, 'cn-custom');
    assert.deepEqual(externalMcpConfigPaths('qoder', home), [path.join(home, 'cn-custom', 'settings.json')]);
  });
});

test('qoder：国际版与国内版目录都存在时两个都注册，只维护 mcpServers.engram', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.qoder', 'settings.json', { mcpServers: { other: { url: 'http://other/mcp' } }, providers: { a: 1 } });
    clientDir(home, '.qoder-cn', 'settings.json', { enabledPlugins: ['p1'] });

    const written = registerExternalMcp('qoder', 'http://127.0.0.1:18180/mcp', 'tok-cn', home);
    assert.deepEqual(written, [
      path.join(home, '.qoder', 'settings.json'),
      path.join(home, '.qoder-cn', 'settings.json'),
    ]);

    const intl = read(written[0]);
    assert.deepEqual(intl.mcpServers.engram, {
      type: 'http',
      url: 'http://127.0.0.1:18180/mcp',
      headers: { Authorization: 'Bearer tok-cn' },
    });
    assert.deepEqual(intl.mcpServers.other, { url: 'http://other/mcp' }); // 别的 server 原样保留
    assert.deepEqual(intl.providers, { a: 1 });

    const cn = read(written[1]);
    assert.deepEqual(cn.mcpServers.engram, intl.mcpServers.engram);
    assert.deepEqual(cn.enabledPlugins, ['p1']); // 国内版原有的 enabledPlugins 保留

    const status = externalMcpStatus('qoder', home);
    assert.equal(status.installed, true);
    assert.equal(status.registered, true);
    assert.deepEqual(status.configPaths, written);
  });
});

test('未检测到客户端时：installed=false，注册直接报错', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    assert.equal(externalMcpInstalled('workbuddy', home), false);
    const status = externalMcpStatus('qoder', home);
    assert.equal(status.installed, false);
    assert.equal(status.registered, false);
    assert.equal(status.configPath, path.join(home, '.qoder', 'settings.json')); // 回落到默认路径供界面提示
    assert.equal(externalMcpConfigPath('workbuddy', home), path.join(home, '.workbuddy', 'mcp.json'));
    assert.throws(() => registerExternalMcp('workbuddy', 'http://127.0.0.1:18180/mcp', 'tok', home), /未检测到目标客户端/);
  });
});

test('workbuddy：目录里还没有 mcp.json 时新建文件，写入 streamableHttp 条目', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.workbuddy', 'mcp.json', null);
    const written = registerExternalMcp('workbuddy', 'http://127.0.0.1:18180/mcp', 'tok-wb', home);
    assert.deepEqual(written, [path.join(home, '.workbuddy', 'mcp.json')]);
    assert.deepEqual(read(written[0]).mcpServers.engram, {
      type: 'streamableHttp',
      url: 'http://127.0.0.1:18180/mcp',
      headers: { Authorization: 'Bearer tok-wb' },
    });
    assert.equal(externalMcpStatus('workbuddy', home).registered, true);
  });
});

test('workbuddy：清掉早期写错位置的 ~/.workbuddy-ai 空壳配置', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.workbuddy', 'mcp.json', { mcpServers: {} });
    const legacy = shellDir(home, '.workbuddy-ai', 'mcp.json', {
      mcpServers: { engram: { url: 'http://127.0.0.1:18180/mcp' } },
    });

    registerExternalMcp('workbuddy', 'http://127.0.0.1:18180/mcp', 'tok', home);
    assert.equal(fs.existsSync(legacy), false); // 条目清空 → 文件删除
    assert.equal(fs.existsSync(path.dirname(legacy)), false); // 目录随之收掉
    assert.ok(read(path.join(home, '.workbuddy', 'mcp.json')).mcpServers.engram);
  });
});

test('workbuddy：错位目录里还有别的 server 时只删 engram，保留文件', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.workbuddy', 'mcp.json', { mcpServers: {} });
    const legacy = shellDir(home, '.workbuddy-ai', 'mcp.json', {
      mcpServers: { engram: { url: 'http://127.0.0.1:18180/mcp' }, keep: { url: 'http://keep/mcp' } },
    });

    registerExternalMcp('workbuddy', 'http://127.0.0.1:18180/mcp', 'tok', home);
    const config = read(legacy);
    assert.equal(config.mcpServers.engram, undefined);
    assert.deepEqual(config.mcpServers.keep, { url: 'http://keep/mcp' });
  });
});

test('workbuddy：海外版目录确实装了客户端时照常写入，不做错位清理', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.workbuddy', 'mcp.json', { mcpServers: {} });
    clientDir(home, '.workbuddy-ai', 'mcp.json', { mcpServers: {} });

    const written = registerExternalMcp('workbuddy', 'http://127.0.0.1:18180/mcp', 'tok', home);
    assert.equal(written.length, 2);
    assert.ok(read(path.join(home, '.workbuddy-ai', 'mcp.json')).mcpServers.engram);
  });
});

test('注销：清掉各变体里的 engram，保留其他键，且可重复注册', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    clientDir(home, '.qoder', 'settings.json', { providers: { a: 1 } });
    clientDir(home, '.qoder-cn', 'settings.json', { enabledPlugins: [] });
    registerExternalMcp('qoder', 'http://127.0.0.1:18180/mcp', 'tok', home);

    unregisterExternalMcp('qoder', home);
    assert.equal(externalMcpStatus('qoder', home).registered, false);
    const intl = read(path.join(home, '.qoder', 'settings.json'));
    assert.deepEqual(intl.mcpServers, {});
    assert.deepEqual(intl.providers, { a: 1 });
    assert.deepEqual(read(path.join(home, '.qoder-cn', 'settings.json')).enabledPlugins, []);

    unregisterExternalMcp('qoder', home); // 幂等
    registerExternalMcp('qoder', 'http://127.0.0.1:18080/mcp', 'tok-2', home);
    assert.equal(externalMcpStatus('qoder', home).registered, true);
    assert.equal(read(path.join(home, '.qoder-cn', 'settings.json')).mcpServers.engram.url, 'http://127.0.0.1:18080/mcp');
  });
});

test('某个变体配置坏掉时：状态按未注册处理，注册报出具体文件且不动坏文件', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    const broken = path.join(clientDir(home, '.qoder', 'settings.json', '{ 这不是 JSON'), 'settings.json');
    clientDir(home, '.qoder-cn', 'settings.json', { enabledPlugins: [] });

    const status = externalMcpStatus('qoder', home);
    assert.equal(status.installed, true);
    assert.equal(status.registered, false); // 坏文件不该让状态接口整体失败

    assert.throws(
      () => registerExternalMcp('qoder', 'http://127.0.0.1:18180/mcp', 'tok', home),
      (error: any) => error.message.includes('部分写入失败') && error.message.includes(broken),
    );
    assert.equal(fs.readFileSync(broken, 'utf8'), '{ 这不是 JSON'); // 用户手写的坏配置内容原样保留
    assert.ok(read(path.join(home, '.qoder-cn', 'settings.json')).mcpServers.engram); // 另一个变体已注册
  });
});

test('mcpServers 不是对象时按错误处理，不覆盖用户配置', () => {
  withCleanEnv(() => {
    const home = tmpHome();
    const file = path.join(clientDir(home, '.workbuddy', 'mcp.json', { mcpServers: [] }), 'mcp.json');
    assert.equal(externalMcpStatus('workbuddy', home).registered, false);
    assert.throws(
      () => registerExternalMcp('workbuddy', 'http://127.0.0.1:18180/mcp', 'tok', home),
      /mcpServers 必须是 JSON 对象/,
    );
    assert.deepEqual(read(file).mcpServers, []);
  });
});
