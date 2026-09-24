import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function kimiPaths() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const bundle = path.join(appData, 'kimi-desktop', 'daimon-bundle');
  const share = path.join(appData, 'kimi-desktop', 'daimon-share');
  const source = path.join(share, 'plugin-sources', 'personal', 'engram-knowledge-base');
  return {
    bundle,
    share,
    source,
    cli: path.join(bundle, 'app', 'daimon', 'dist', 'src', 'runner', 'cli.js'),
    node: path.join(localAppData, 'Programs', 'Kimi', 'Kimi.exe'),
    registry: path.join(share, 'daimon', 'plugin-market', 'personal', 'engram-knowledge-base.json'),
  };
}

export function getKimiWorkStatus() {
  const paths = kimiPaths();
  return {
    installed: process.platform === 'win32' && fs.existsSync(paths.cli) && fs.existsSync(paths.node),
    registered: fs.existsSync(paths.registry),
    pluginPath: paths.source,
    installUrl: 'kimi-work://plugin?id=engram-knowledge-base',
  };
}

/** 通过 Kimi Work 自带的官方 kimi-plugin CLI 登记个人插件；安装仍由 Kimi Work 用户确认。 */
export function registerKimiWorkPlugin(url: string, token: string): string {
  const paths = kimiPaths();
  if (!getKimiWorkStatus().installed) throw new Error('未检测到 Kimi Work 桌面端');
  const marker = path.join(paths.source, '.engram-managed');
  if (fs.existsSync(paths.source) && !fs.existsSync(marker)) {
    throw new Error('同名插件目录已存在，Engram 不会覆盖');
  }
  fs.mkdirSync(paths.source, { recursive: true });
  let patch = 0;
  const manifestPath = path.join(paths.source, 'kimi.plugin.json');
  if (fs.existsSync(manifestPath)) {
    const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: string };
    patch = Number(current.version?.match(/^0\.1\.(\d+)$/)?.[1] || 0) + 1;
  }
  const manifest = {
    $schema: 'https://catalog.msh.team/misc/kimi.plugin.schema.json',
    name: 'engram-knowledge-base',
    version: `0.1.${patch}`,
    description: '通过 MCP 检索、阅读和整理 Engram 知识库',
    keywords: ['engram', 'knowledge-base'],
    author: 'Engram',
    license: 'MIT',
    skillInstructions: '',
    interface: {
      displayName: 'Engram 知识库',
      shortDescription: '检索、阅读和整理 Engram 知识库',
      longDescription: '在 Kimi Work 中通过 MCP 使用本机 Engram 知识库。',
      developerName: 'Engram',
      websiteURL: '',
      iconUrl: '',
      category: 'PRODUCTIVITY',
    },
    mcpServers: { engram: { url, headers: { Authorization: `Bearer ${token}` } } },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(marker, 'Created by Engram Agent 接入\n');

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DAIMON_BUNDLE_NODE_BIN: paths.node,
    DAIMON_RUNTIME_BINARY_PATH: path.join(paths.bundle, 'bin', 'kimi-daimon.cmd'),
    DAIMON_ADAPTER_PACKAGE_ROOT: path.join(paths.bundle, 'app', 'daimon'),
    DAIMON_UV_PATH: path.join(paths.bundle, 'runtime', 'uv', 'uv.exe'),
    DAIMON_PYTHON_BASE_PATH: path.join(paths.bundle, 'runtime', 'python', 'cpython-3.12', 'python.exe'),
  };
  const result = spawnSync(paths.node, [paths.cli, 'kimi-plugin', 'register-personal', paths.source,
    '--share-dir', paths.share, '--json'], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0 || !fs.existsSync(paths.registry)) {
    throw new Error('Kimi Work 插件登记失败，请在 Kimi Work 中检查插件中心');
  }
  return paths.source;
}
