#!/usr/bin/env node
// 一次改三处版本号（desktop/package.json、web/src/version.ts、docker-compose.yml）并回读校验。
// 退出码：0 成功 / 1 检查或运行失败 / 2 参数错误。
import { readVersions, writeVersions, nextVersion, parseSemver, formatSemver, resolveMainDir } from './lib/versions.mjs';

const USAGE = `用法：node scripts/release/bump-version.mjs <major|minor|patch|x.y.z> [--repo <mainDir>] [--dry-run]

示例：
  node scripts/release/bump-version.mjs --dry-run 1.5.11   # 只打印将发生的改动
  node scripts/release/bump-version.mjs 1.5.11
  node scripts/release/bump-version.mjs patch`;

function usageFail(message) {
  console.log(`[FAIL] ${message}`);
  console.log(USAGE);
  process.exit(2);
}

function printNextSteps(version) {
  console.log('下一步：');
  console.log('  1) node scripts/release/release-notes.mjs --render --write');
  console.log(`  2) git add -A && git commit -m "release: prepare v${version}"`);
  console.log('  3) bash scripts/platform-parity-check.sh --since <上次 tag> --strict');
  console.log(`  4) git push gitea main && git tag v${version} && git push gitea v${version}`);
}

function printChanges(changes) {
  for (const change of changes) {
    console.log(`   ${change.file}: ${change.from} -> ${change.to}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  let request = null;
  let repoArg = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--repo') {
      repoArg = argv[i + 1];
      if (repoArg === undefined) usageFail('--repo 需要一个目录参数');
      i += 1;
    } else if (arg.startsWith('--repo=')) {
      repoArg = arg.slice('--repo='.length);
      if (!repoArg) usageFail('--repo= 后面需要目录参数');
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      usageFail(`未知参数：${arg}`);
    } else if (request !== null) {
      usageFail(`多余的参数：${arg}`);
    } else {
      request = arg;
    }
  }
  if (!request) usageFail('缺少版本参数');

  let repoDir;
  try {
    repoDir = resolveMainDir(repoArg);
  } catch (err) {
    console.log(`[FAIL] ${err.message}`);
    process.exit(err.exitCode === 2 ? 2 : 1);
  }

  const current = readVersions(repoDir);
  if (!current.consistent || !current.version) {
    console.log('[FAIL] 三处版本号不一致（或读取失败），请先人工对齐：');
    for (const source of current.sources) {
      const value = source.ok ? source.version : `读取失败（${source.error}）`;
      console.log(`   ${source.id}（${source.file}）：${value}`);
    }
    process.exit(1);
  }

  const keyword = request.trim();
  if (!['major', 'minor', 'patch'].includes(keyword) && !parseSemver(keyword)) {
    usageFail(`版本参数无效：${request}（只支持 major|minor|patch 或显式 x.y.z）`);
  }

  let target;
  try {
    target = nextVersion(current.version, keyword);
  } catch (err) {
    console.log(`[FAIL] ${err.message}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[OK] ${current.version} -> ${target}（dry-run，未写盘）`);
    printChanges(current.sources.map((source) => ({ file: source.file, from: source.version, to: target })));
    printNextSteps(target);
    return;
  }

  let changes;
  try {
    changes = writeVersions(repoDir, target);
  } catch (err) {
    console.log(`[FAIL] 写入失败：${err.message}`);
    process.exit(1);
  }
  console.log(`[OK] ${current.version} -> ${target}`);
  printChanges(changes);
  printNextSteps(target);
}

main();
