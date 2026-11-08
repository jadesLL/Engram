// 发版就绪测试：对真实仓库跑 verify-release --rehearse，必须通过（CI 里的「发版彩排」）。
// 仓库状态由 Lead 维护：当前版本必须有 CHANGELOG 段落，若有「## 未发布」区则条目必须合法。
// Docker verify 镜像的构建上下文是 main/，仓库根的 CHANGELOG.md 不会进镜像（/app 也没有上一级），
// 此时跳过本测试；发版彩排由 ci.yml / release.yml 在宿主 node 上显式执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainDir = path.resolve(here, '..', '..', '..');
const cli = path.resolve(here, '..', 'verify-release.mjs');

/** CHANGELOG 可能位于 main/（镜像内不会有）或仓库根（本机/worktree/CI 检出）。 */
function hasChangelog() {
  return fs.existsSync(path.join(mainDir, 'CHANGELOG.md'))
    || fs.existsSync(path.join(mainDir, '..', 'CHANGELOG.md'));
}

test('发版就绪：真实仓库 verify-release --rehearse 必须通过', (t) => {
  if (!hasChangelog()) {
    t.diagnostic('跳过：当前构建上下文没有仓库根 CHANGELOG.md（发版彩排由 ci.yml / release.yml 在宿主机执行）');
    return;
  }
  const result = spawnSync(process.execPath, [cli, '--rehearse'], { cwd: mainDir, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 0, `verify-release --rehearse 未通过：\n${output}`);
  assert.ok(output.includes('[OK] 发版校验通过'), output);
  assert.ok(!output.includes('[FAIL]'), output);
});
