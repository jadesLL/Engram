import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-update-lib-'));
process.env.DATA_DIR = temp;

const { SWITCHER_SCRIPT, buildCreateBody, buildSwitcherCreateBody, OLD_CONTAINER_NAME } = await import(
  '../lib/updateSwitcher.js'
);
const { deriveDefaultImageRef, deriveDefaultImageTag, parseEnv, writeUpdateEnv, readUpdateEnv } = await import(
  '../lib/updateConfig.js'
);
const { compareVersions, currentVersion } = await import('../lib/version.js');

test('switcher 内联脚本语法正确（node --check）', () => {
  const file = path.join(temp, 'switcher-check.js');
  fs.writeFileSync(file, SWITCHER_SCRIPT, 'utf8');
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
});

test('switcher 脚本引用注入的环境变量且不含镜像内路径依赖', () => {
  assert.ok(SWITCHER_SCRIPT.includes('ENGRAM_UPDATE_OLD_ID'));
  assert.ok(SWITCHER_SCRIPT.includes('ENGRAM_UPDATE_NEW_ID'));
  assert.ok(SWITCHER_SCRIPT.includes('ENGRAM_UPDATE_NAME'), '回滚还原容器名所需的原名变量');
  assert.ok(SWITCHER_SCRIPT.includes('/var/run/docker.sock'));
  // 回滚路径存在且会 rename 回原名
  assert.ok(SWITCHER_SCRIPT.includes('rolling back'));
  assert.ok(SWITCHER_SCRIPT.includes("OLD_ID + '/start'"));
  assert.ok(SWITCHER_SCRIPT.includes('rename?name='));
});

test('buildCreateBody 复制容器配置并替换镜像', () => {
  const inspect = {
    Id: 'abc123def456789',
    Name: '/engram',
    Image: 'sha256:oldimage',
    Config: {
      Image: 'registry.xxx.com/engram:1.1.5',
      Env: ['TZ=Asia/Shanghai', 'DEFAULT_PASSWORD=x'],
      Cmd: null,
      Labels: { 'com.docker.compose.project': 'engram' },
      Healthcheck: { Test: ['CMD', 'node', '-e', '...'] },
    },
    HostConfig: {
      Binds: ['./data:/data'],
      PortBindings: { '8080/tcp': [{ HostPort: '8080' }] },
      RestartPolicy: { Name: 'unless-stopped' },
      Sysctls: { 'net.ipv4.tcp_mtu_probing': '1' },
      NetworkMode: 'engram_default',
    },
    NetworkSettings: {
      Networks: {
        engram_default: { Aliases: ['engram', 'abc123def456'] },
      },
    },
  };
  const body = buildCreateBody(inspect as any, 'registry.xxx.com/engram:latest');
  assert.equal((body as any).Image, 'registry.xxx.com/engram:latest');
  assert.deepEqual((body as any).Env, ['TZ=Asia/Shanghai', 'DEFAULT_PASSWORD=x']);
  assert.deepEqual((body as any).HostConfig.Binds, ['./data:/data']);
  assert.deepEqual((body as any).HostConfig.PortBindings, { '8080/tcp': [{ HostPort: '8080' }] });
  assert.equal((body as any).HostConfig.RestartPolicy.Name, 'unless-stopped');
  // 网络别名保留（去掉容器短 ID 别名）
  assert.deepEqual((body as any).NetworkingConfig.EndpointsConfig['engram_default'].Aliases, ['engram']);
  // Hostname 不复制（由 Docker 重新分配）；Cmd/Healthcheck 不复制（新镜像自己的生效）
  assert.equal((body as any).Hostname, undefined);
  assert.equal((body as any).Cmd, undefined);
  assert.equal((body as any).Healthcheck, undefined);
});

test('buildSwitcherCreateBody 用目标镜像 + sock + AutoRemove', () => {
  const body = buildSwitcherCreateBody('registry.xxx.com/engram:latest', 'oldid123', 'newid456', 'engram') as any;
  assert.equal(body.Image, 'registry.xxx.com/engram:latest');
  assert.equal(body.HostConfig.NetworkMode, 'none');
  assert.equal(body.HostConfig.AutoRemove, true);
  assert.deepEqual(body.HostConfig.Binds, ['/var/run/docker.sock:/var/run/docker.sock']);
  assert.ok(String(body.Cmd[2]).includes('ENGRAM_UPDATE_OLD_ID'));
});

test('deriveDefaultImageRef 推导规则', () => {
  assert.equal(deriveDefaultImageRef('gitea.xxx.com:11111/example/Engram/engram:1.1.5'), 'gitea.xxx.com:11111/example/Engram/engram');
  assert.equal(deriveDefaultImageRef('registry.io/repo/app'), 'registry.io/repo/app');
  // 本地构建镜像无法推导
  assert.equal(deriveDefaultImageRef('engram:1.1.5'), null);
  assert.equal(deriveDefaultImageRef('engram'), null);
  // digest ref 去除 digest
  assert.equal(deriveDefaultImageRef('reg.io/app@sha256:abc'), 'reg.io/app');
});

test('deriveDefaultImageTag 只继承滚动 tag，钉住的版本号回退 latest', () => {
  // 容器跑在哪个滚动通道上就继续跟哪个
  assert.equal(deriveDefaultImageTag('gitea.xxx.com:11111/example/engram:main'), 'main');
  assert.equal(deriveDefaultImageTag('gitea.xxx.com:11111/example/engram:latest'), 'latest');
  assert.equal(deriveDefaultImageTag('engram:dev'), 'dev');
  // 版本号 tag 是发布快照，继续跟踪会永远"已是最新"，回退 latest
  assert.equal(deriveDefaultImageTag('gitea.xxx.com:11111/example/engram:1.2.5'), 'latest');
  // 无 tag（registry 端口冒号不算 tag）
  assert.equal(deriveDefaultImageTag('gitea.xxx.com:11111/example/engram'), 'latest');
  assert.equal(deriveDefaultImageTag('engram'), 'latest');
});

test('writeUpdateEnv 保留无关行、空值清除', () => {
  const file = path.join(temp, '.env');
  fs.writeFileSync(file, '# 我的注释\nOTHER_KEY=keep\nUPDATE_GITEA_URL=https://a.com\n', 'utf8');
  writeUpdateEnv({ giteaUrl: 'https://b.com', giteaToken: 't1' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('OTHER_KEY=keep'));
  assert.ok(text.includes('# 我的注释'));
  assert.ok(text.includes('UPDATE_GITEA_URL=https://b.com'));
  assert.ok(text.includes('UPDATE_GITEA_TOKEN=t1'));

  writeUpdateEnv({ giteaToken: '' });
  const text2 = fs.readFileSync(file, 'utf8');
  assert.ok(!text2.includes('UPDATE_GITEA_TOKEN='));
  assert.ok(text2.includes('UPDATE_GITEA_URL=https://b.com'));

  // 更新通道同样是可保留写入的普通键
  writeUpdateEnv({ imageTag: 'main' });
  assert.ok(fs.readFileSync(file, 'utf8').includes('UPDATE_IMAGE_TAG=main'));
  assert.equal(readUpdateEnv().imageTag, 'main');
  writeUpdateEnv({ imageTag: '' });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('UPDATE_IMAGE_TAG='));
  assert.equal(readUpdateEnv().imageTag, '');

  const cfg = readUpdateEnv();
  assert.equal(cfg.giteaUrl, 'https://b.com');
  assert.equal(cfg.giteaToken, '');
});

test('parseEnv 容忍引号与注释', () => {
  const parsed = parseEnv('A=1\nB="two words"\n# c\nD=\'sq\'');
  assert.equal(parsed.A, '1');
  assert.equal(parsed.B, 'two words');
  assert.equal(parsed.D, 'sq');
  assert.equal(parsed['# c'], undefined);
});

test('compareVersions 语义化比较', () => {
  assert.ok(compareVersions('1.1.6', '1.1.5') > 0);
  assert.ok(compareVersions('1.1.5', '1.1.6') < 0);
  assert.ok(compareVersions('v1.2', '1.1.9') > 0);
  assert.equal(compareVersions('1.1.5', 'v1.1.5'), 0);
  assert.ok(compareVersions('2.0', '1.9.9') > 0);
  assert.ok(compareVersions('dev', '1.0.0') < 0);
});

test('currentVersion 环境变量注入优先', () => {
  // 不直接断言「返回 dev」：CI 的 verify 容器里 /app/VERSION 存在（值为构建版本号），
  // 该函数的环境行为依赖运行位置；这里只验证可控的 env 优先级维度
  const prev = process.env.ENGRAM_APP_VERSION;
  process.env.ENGRAM_APP_VERSION = '9.9.9-test';
  try {
    assert.equal(currentVersion(), '9.9.9-test');
  } finally {
    if (prev === undefined) delete process.env.ENGRAM_APP_VERSION;
    else process.env.ENGRAM_APP_VERSION = prev;
  }
});
