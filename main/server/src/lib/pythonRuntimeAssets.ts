/**
 * Engram 共享 Python 运行时的发布物身份（python-build-standalone）。
 *
 * 为什么由 Engram 自己提供解释器：讯飞办公本的官方客户端是 Python 脚本（官方 meta.json
 * 要求 3.8+），Windows 桌面端与源码模式都没有系统 Python，让用户自己去官网下载安装既
 * 容易被「Add to PATH」漏勾，也和「装好 Engram 就能用」的预期冲突。这里固定一份可直接
 * 解压运行的独立 CPython：不写注册表、不改系统 PATH、卸载 Engram 时随数据目录一起走。
 *
 * 为什么选 install_only_stripped：完整 CPython（stdlib + pip + ssl/sqlite 等扩展模块），
 * 只去掉调试符号，Windows x64 约 21MB；同一份运行时供所有需要 Python 的接入共用
 * （办公本只是第一个使用者），升级 Python 版本时只改这份清单。
 *
 * 资产身份即安全边界：URL 固定到 release + 文件名，下载后校验字节数与 SHA-256；
 * 镜像/内网部署可用 ENGRAM_PYTHON_RUNTIME_URL 覆盖下载地址（校验值不变）。
 */
export interface PythonRuntimeAsset {
  /** `${process.platform}-${process.arch}` */
  platform: string;
  /** 固定修订的上游下载地址 */
  url: string;
  bytes: number;
  sha256: string;
}

/** 运行时版本（与发布修订一起决定目录名与展示版本） */
export const PYTHON_RUNTIME_VERSION = '3.12.16';
/** python-build-standalone 的发布修订 */
export const PYTHON_RUNTIME_RELEASE = '20261110';

const RELEASE_BASE =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RUNTIME_RELEASE}`;

function asset(platform: string, target: string, bytes: number, sha256: string): PythonRuntimeAsset {
  return {
    platform,
    url: `${RELEASE_BASE}/cpython-${PYTHON_RUNTIME_VERSION}+${PYTHON_RUNTIME_RELEASE}-${target}-install_only_stripped.tar.gz`,
    bytes,
    sha256,
  };
}

/**
 * 各平台固定资产。只覆盖 Engram 实际运行的组合：
 * - win32-x64：Windows 桌面端 / 源码模式（唯一没有系统 Python 的形态）；
 * - linux-x64 / linux-arm64：Docker 运行镜像已内置 python3，这里只作为「镜像没带 Python」时的
 *   兜底（同一套下载与解压逻辑，不额外维护第二份实现）；
 * - darwin-x64 / darwin-arm64：macOS 源码模式。
 */
export const PYTHON_RUNTIME_ASSETS: Record<string, PythonRuntimeAsset> = {
  'win32-x64': asset(
    'win32-x64',
    'x86_64-pc-windows-msvc',
    22365213,
    '355ee61b8207b91574491b1c6dc9b0ebb4408fc56bfafe498f3ef439314b52dc',
  ),
  'linux-x64': asset(
    'linux-x64',
    'x86_64-unknown-linux-gnu',
    34709145,
    '6a9e62dad033790aef722dbd370e0ce76ce17b73627ba3ae679f537049350b39',
  ),
  'linux-arm64': asset(
    'linux-arm64',
    'aarch64-unknown-linux-gnu',
    29440910,
    'b6a41defec4975d94b4ff1950236e7383e5c02ba40ea48c9ec33c66087a35aab',
  ),
  'darwin-x64': asset(
    'darwin-x64',
    'x86_64-apple-darwin',
    24957926,
    'b78a4c479f1964ec484880bee567568266f68da102269fb93a05fe8716b45f91',
  ),
  'darwin-arm64': asset(
    'darwin-arm64',
    'aarch64-apple-darwin',
    25237581,
    '2f11b8aa3726bdbd87dd9eb76568412faddf4f47e26913fa45d6a2e424972acd',
  ),
};

/** 当前平台是否在清单内 */
export function pythonRuntimeAssetFor(platform: string): PythonRuntimeAsset | undefined {
  return PYTHON_RUNTIME_ASSETS[platform];
}

/** 下载地址：ENGRAM_PYTHON_RUNTIME_URL 覆盖（内网镜像 / 离线测试），资产校验值不变 */
export function pythonRuntimeUrl(
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const spec = pythonRuntimeAssetFor(platform);
  if (!spec) return undefined;
  const override = (env.ENGRAM_PYTHON_RUNTIME_URL || '').trim();
  return override || spec.url;
}
