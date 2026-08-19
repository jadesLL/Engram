import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'example-wiki-update-lib-'));
process.env.DATA_DIR = temp;

const { SWITCHER_SCRIPT, buildCreateBody, buildSwitcherCreateBody, OLD_CONTAINER_NAME } = await import(
  '../lib/updateSwitcher.js'
);
const { deriveDefaultImageRef, buildRegistryAuthHeader, parseEnv, writeUpdateEnv, readUpdateEnv } = await import(
  '../lib/updateConfig.js'
);
const { compareVersions, currentVersion } = await import('../lib/version.js');

test('switcher 内联脚本语法正确（node --check）', () => {
  const file = path.join(temp, 'switcher-check.js');
  fs.writeFileSync(file, SWITCHER_SCRIPT, 'utf8');
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
});

test('switcher 脚本引用注入的环境变量且不含镜像内路径依赖', () => {
  assert.ok(SWITCHER_SCRIPT.includes('WIKILLM_UPDATE_OLD_ID'));
  assert.ok(SWITCHER_SCRIPT.includes('WIKILLM_UPDATE_NEW_ID'));
  assert.ok(SWITCHER_SCRIPT.includes('/var/run/docker.sock'));
  // 回滚路径存在
  assert.ok(SWITCHER_SCRIPT.includes('rolling back'));
  assert.ok(SWITCHER_SCRIPT.includes("OLD_ID + '/start'"));
});

test('buildCreateBody 复制容器配置并替换镜像', () => {
  const inspect = {
    Id: 'abc123def456789',
    Name: '/example-wiki',
    Image: 'sha256:oldimage',
    Config: {
      Image: 'registry.example.com/example-wiki:1.1.5',
      Env: ['TZ=Asia/Shanghai', 'DEFAULT_PASSWORD=x'],
      Cmd: null,
      Labels: { 'com.docker.compose.project': 'exampleproject' },
      Healthcheck: { Test: ['CMD', 'node', '-e', '...'] },
    },
    HostConfig: {
      Binds: ['./data:/data'],
      PortBindings: { '8080/tcp': [{ HostPort: '8080' }] },
      RestartPolicy: { Name: 'unless-stopped' },
      Sysctls: { 'net.ipv4.tcp_mtu_probing': '1' },
      NetworkMode: 'exampleproject_default',
    },
    NetworkSettings: {
      Networks: {
        exampleproject_default: { Aliases: ['example-wiki', 'abc123def456'] },
      },
    },
  };
  const body = buildCreateBody(inspect as any, 'registry.example.com/example-wiki:latest');
  assert.equal((body as any).Image, 'registry.example.com/example-wiki:latest');
  assert.deepEqual((body as any).Env, ['TZ=Asia/Shanghai', 'DEFAULT_PASSWORD=x']);
  assert.deepEqual((body as any).HostConfig.Binds, ['./data:/data']);
  assert.deepEqual((body as any).HostConfig.PortBindings, { '8080/tcp': [{ HostPort: '8080' }] });
  assert.equal((body as any).HostConfig.RestartPolicy.Name, 'unless-stopped');
  // 网络别名保留（去掉容器短 ID 别名）
  assert.deepEqual((body as any).NetworkingConfig.EndpointsConfig['exampleproject_default'].Aliases, ['example-wiki']);
  // Hostname 不复制（由 Docker 重新分配）
  assert.equal((body as any).Hostname, undefined);
});

test('buildSwitcherCreateBody 用旧镜像 ID + sock + AutoRemove', () => {
  const body = buildSwitcherCreateBody('sha256:oldimage', 'oldid123', 'newid456') as any;
  assert.equal(body.Image, 'sha256:oldimage');
  assert.equal(body.HostConfig.NetworkMode, 'none');
  assert.equal(body.HostConfig.AutoRemove, true);
  assert.deepEqual(body.HostConfig.Binds, ['/var/run/docker.sock:/var/run/docker.sock']);
  assert.ok(String(body.Cmd[2]).includes('WIKILLM_UPDATE_OLD_ID'));
});

test('deriveDefaultImageRef 推导规则', () => {
  assert.equal(deriveDefaultImageRef('gitea.example.com:11111/example/exampleproject/example-wiki:1.1.5'), 'gitea.example.com:11111/example/exampleproject/example-wiki');
  assert.equal(deriveDefaultImageRef('registry.io/repo/app'), 'registry.io/repo/app');
  // 本地构建镜像无法推导
  assert.equal(deriveDefaultImageRef('example-wiki:1.1.5'), null);
  assert.equal(deriveDefaultImageRef('example-wiki'), null);
  // digest ref 去除 digest
  assert.equal(deriveDefaultImageRef('reg.io/app@sha256:abc'), 'reg.io/app');
});

test('buildRegistryAuthHeader base64 编码凭据', () => {
  const header = buildRegistryAuthHeader('gitea.example.com:11111/example/app', 'user', 'pass');
  assert.ok(header);
  const decoded = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'));
  assert.equal(decoded.username, 'user');
  assert.equal(decoded.password, 'pass');
  assert.equal(decoded.serveraddress, 'gitea.example.com:11111');
  assert.equal(buildRegistryAuthHeader('x', '', 'y'), undefined);
  assert.equal(buildRegistryAuthHeader('x', 'y', ''), undefined);
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

test('currentVersion 开发环境返回 dev', () => {
  assert.equal(currentVersion(), 'dev');
});
