#!/usr/bin/env node
// 发版门禁体检：--rehearse（默认，发版彩排）/ --tag v<ver>（标签即发版前的严格校验）。
// 退出码：0 通过 / 1 有 FAIL（或 --strict 下有 WARN） / 2 参数错误。
import fs from 'node:fs';
import path from 'node:path';
import { readVersions, resolveMainDir } from './lib/versions.mjs';
import { readChangelog, parseChangelog, validateEntries, isValidDate, ANDROID_PLATFORMS } from './lib/changelog.mjs';
import { hashFile, parseSha256File, normalizeArtifactName } from './lib/receipt.mjs';

const USAGE = `用法：node scripts/release/verify-release.mjs [--repo <mainDir>] [--rehearse] [--tag v<ver>]
                                              [--artifacts <dir>] [--strict] [--json]

检查项：
  1. 版本号三处一致（desktop/package.json、web/src/version.ts、docker-compose.yml）
  2. 当前版本 CHANGELOG 段落存在、日期合法、正文非空
  3. 「## 未发布」区条目格式（无未发布区只 WARN，兼容老标签树）
  4. --tag 模式额外：标签格式与版本一致、未发布区已清空、安卓累计段齐备
  5. --artifacts <dir>：exe/apk/sha256 齐全，sha256 与实际文件一致

模式：缺省为 --rehearse；--strict 时 WARN 也视为失败。`;

const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function usageFail(message) {
  console.log(`[FAIL] ${message}`);
  console.log(USAGE);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  let repoArg = null;
  let tagArg = null;
  let artifactsArg = null;
  let strict = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined) usageFail(`${name} 需要一个参数值`);
      i += 1;
      return value;
    };
    if (arg === '--rehearse') {
      // 缺省就是彩排，显式给出时保持兼容
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--repo') {
      repoArg = takeValue('--repo');
    } else if (arg.startsWith('--repo=')) {
      repoArg = arg.slice('--repo='.length);
      if (!repoArg) usageFail('--repo= 后面需要目录参数');
    } else if (arg === '--tag') {
      tagArg = takeValue('--tag');
    } else if (arg.startsWith('--tag=')) {
      tagArg = arg.slice('--tag='.length);
      if (!tagArg) usageFail('--tag= 后面需要标签值');
    } else if (arg === '--artifacts') {
      artifactsArg = takeValue('--artifacts');
    } else if (arg.startsWith('--artifacts=')) {
      artifactsArg = arg.slice('--artifacts='.length);
      if (!artifactsArg) usageFail('--artifacts= 后面需要目录参数');
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      usageFail(`未知参数：${arg}`);
    }
  }

  let repoDir;
  try {
    repoDir = resolveMainDir(repoArg);
  } catch (err) {
    console.log(`[FAIL] ${err.message}`);
    process.exit(err.exitCode === 2 ? 2 : 1);
  }

  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const tagMode = Boolean(tagArg);
  const mode = tagMode ? 'tag' : 'rehearse';

  // 1. 版本号三处一致
  const versions = readVersions(repoDir);
  const currentVersion = versions.version;
  const unreadable = versions.sources.filter((source) => !source.ok);
  if (unreadable.length > 0) {
    add('版本号三处一致', 'FAIL', unreadable.map((source) => `${source.file}：${source.error}`).join('；'));
  } else if (!versions.consistent) {
    add('版本号三处一致', 'FAIL', versions.sources.map((source) => `${source.file}=${source.version}`).join('，'));
  } else {
    add('版本号三处一致', 'PASS', `${currentVersion}（desktop / web / docker-compose 一致）`);
  }

  // 解析 CHANGELOG（后续多项检查共用）
  let parsed = null;
  let changelogProblem = null;
  try {
    const changelog = readChangelog(repoDir);
    parsed = parseChangelog(changelog.text);
  } catch (err) {
    changelogProblem = err.message;
  }

  // 2. 当前版本 CHANGELOG 段落
  if (!currentVersion) {
    add('当前版本 CHANGELOG 段落', 'FAIL', '无法确定当前版本（三处版本号读取失败）');
  } else if (!parsed) {
    add('当前版本 CHANGELOG 段落', 'FAIL', changelogProblem);
  } else {
    const section = parsed.released.find((item) => item.version === currentVersion);
    if (!section) {
      add('当前版本 CHANGELOG 段落', 'FAIL', `CHANGELOG 缺少 ## v${currentVersion}（YYYY-MM-DD）段落；先运行 release-notes.mjs --render --write`);
    } else if (!isValidDate(section.date)) {
      add('当前版本 CHANGELOG 段落', 'FAIL', `v${currentVersion} 段落日期不是合法日历日期：${section.date}`);
    } else {
      const body = section.bodyLines.join('\n').trim();
      if (!body) {
        add('当前版本 CHANGELOG 段落', 'FAIL', `v${currentVersion} 段落正文为空`);
      } else {
        add('当前版本 CHANGELOG 段落', 'PASS', `v${currentVersion}（${section.date}），正文 ${body.split('\n').length} 行`);
      }
    }
  }

  // 3. 未发布区条目格式
  if (!parsed) {
    add('未发布区条目格式', 'WARN', 'CHANGELOG 不可读，跳过');
  } else if (!parsed.unreleased) {
    add('未发布区条目格式', 'WARN', '无「## 未发布」区（老标签树兼容）');
  } else if (parsed.unreleased.entries.length === 0) {
    add('未发布区条目格式', 'PASS', '「## 未发布」区为空');
  } else {
    const validation = validateEntries(parsed.unreleased.entries);
    if (validation.errors.length > 0) {
      add('未发布区条目格式', 'FAIL', validation.errors.map((error) => error.message).join('；'));
    } else {
      const warnText = validation.warnings.length > 0 ? `（${validation.warnings.length} 条警告）` : '';
      add('未发布区条目格式', 'PASS', `「## 未发布」区 ${parsed.unreleased.entries.length} 条格式正确${warnText}`);
    }
  }

  // 4. --tag 模式的额外检查
  if (tagMode) {
    if (!TAG_RE.test(tagArg)) {
      add('标签格式', 'FAIL', `标签必须是 v<主>.<次>.<修订>[-预发布]：${tagArg}`);
    } else {
      add('标签格式', 'PASS', tagArg);
    }
    if (currentVersion) {
      const expected = `v${currentVersion}`;
      if (tagArg === expected) {
        add('标签与版本一致', 'PASS', `${tagArg}`);
      } else {
        add('标签与版本一致', 'FAIL', `${tagArg} ≠ ${expected}（三处版本号）`);
      }
    } else {
      add('标签与版本一致', 'FAIL', '无法确定当前版本，无法比对标签');
    }

    if (!parsed) {
      add('未发布区已清空', 'WARN', 'CHANGELOG 不可读，跳过');
    } else if (!parsed.unreleased) {
      add('未发布区已清空', 'WARN', '无「## 未发布」区（老标签树兼容）');
    } else if (parsed.unreleased.entries.length > 0) {
      const preview = parsed.unreleased.entries.slice(0, 3).map((entry) => entry.description).join('；');
      add('未发布区已清空', 'FAIL', `还有 ${parsed.unreleased.entries.length} 条未发布条目（${preview}…）；先运行 release-notes.mjs --render --write`);
    } else {
      add('未发布区已清空', 'PASS', '「## 未发布」区已清空（只剩标题与模板注释）');
    }

    if (!parsed || !currentVersion) {
      add('安卓累计更新说明', 'WARN', 'CHANGELOG 或版本号不可用，跳过');
    } else {
      const index = parsed.released.findIndex((item) => item.version === currentVersion);
      if (index < 0) {
        add('安卓累计更新说明', 'WARN', `缺少 v${currentVersion} 段落，跳过安卓累积段检查`);
      } else {
        const baseVersion = index + 1 < parsed.released.length ? parsed.released[index + 1].version : null;
        const androidEntries = [];
        for (let i = 0; i <= index; i += 1) {
          for (const entry of parsed.released[i].entries) {
            if ((entry.platforms || []).some((platform) => ANDROID_PLATFORMS.includes(platform))) androidEntries.push(entry);
          }
        }
        if (!baseVersion) {
          add('安卓累计更新说明', 'WARN', '没有更早的已发布版本，跳过安卓累积区间检查');
        } else if (androidEntries.length === 0) {
          add('安卓累计更新说明', 'PASS', `v${baseVersion} 之后区间无 A/C/D/F 条目，无需安卓累积段`);
        } else {
          // 允许 --android-base 指定更早基线（RELEASE.md §3.3）：标题里的基线可以早于上一个已发布版本。
          const heading = `**安卓端：自 v${baseVersion} 以来的累计更新**`;
          const body = parsed.released[index].bodyLines.join('\n');
          const headingMatch = /\*\*安卓端：自 v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) 以来的累计更新\*\*/.exec(body);
          if (headingMatch) {
            add('安卓累计更新说明', 'PASS', `${headingMatch[0]}（区间 ${androidEntries.length} 条 A/C/D/F 条目）`);
          } else {
            add('安卓累计更新说明', 'FAIL', `区间存在 ${androidEntries.length} 条 A/C/D/F 条目，但 v${currentVersion} 段落缺少小标题 ${heading}`);
          }
        }
      }
    }
  }

  // 5. --artifacts 产物与 sha256
  if (artifactsArg) {
    const dir = path.resolve(artifactsArg);
    const version = currentVersion || (tagArg ? tagArg.replace(/^v/, '') : null);
    if (!version) {
      add('发版产物', 'FAIL', '无法确定版本号，无法核对产物');
    } else if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      add('发版产物', 'FAIL', `产物目录不存在：${dir}`);
    } else {
      const exe = `Engram Setup ${version}.exe`;
      const apk = `Engram ${version}.apk`;
      const shaFile = `sha256-${version}.txt`;
      const missing = [exe, apk, shaFile].filter((name) => !fs.existsSync(path.join(dir, name)));
      if (missing.length > 0) {
        add('发版产物', 'FAIL', `缺少：${missing.join('、')}`);
      } else {
        const problems = [];
        const records = parseSha256File(fs.readFileSync(path.join(dir, shaFile), 'utf8'));
        if (records.length === 0) problems.push(`${shaFile} 里没有可解析的 sha256 记录`);
        const recordMap = new Map(records.map((record) => [normalizeArtifactName(record.name), record.sha256]));
        const required = [exe, apk];
        for (const name of required) {
          const record = recordMap.get(normalizeArtifactName(name));
          if (!record) {
            problems.push(`${name} 未在 ${shaFile} 中记录`);
            continue;
          }
          const actual = hashFile(path.join(dir, name));
          if (actual !== record) {
            problems.push(`${name} sha256 不符（记录 ${record.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
          }
        }
        for (const record of records) {
          const name = normalizeArtifactName(record.name);
          if (required.includes(name)) continue;
          const filePath = path.join(dir, name);
          if (!fs.existsSync(filePath)) {
            problems.push(`${shaFile} 记录了不存在的文件：${record.name}`);
            continue;
          }
          if (hashFile(filePath) !== record.sha256) problems.push(`${record.name} sha256 不符`);
        }
        if (problems.length > 0) {
          add('发版产物', 'FAIL', problems.join('；'));
        } else {
          add('发版产物', 'PASS', `${exe}、${apk}、${shaFile} 齐全，sha256 校验通过`);
        }
      }
    }
  }

  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const check of checks) counts[check.status] += 1;
  const ok = counts.FAIL === 0 && (!strict || counts.WARN === 0);

  if (json) {
    console.log(JSON.stringify({ mode, strict, tag: tagArg, version: currentVersion, ok, checks }, null, 2));
  } else {
    for (const check of checks) console.log(`[${check.status}] ${check.name} — ${check.detail}`);
    if (ok) {
      console.log(`[OK] 发版校验通过（模式：${mode}，${counts.PASS} 项通过，${counts.WARN} 项警告）`);
    } else if (counts.FAIL > 0) {
      console.log(`[FAIL] 发版校验未通过（模式：${mode}，${counts.FAIL} 项失败，${counts.WARN} 项警告）`);
    } else {
      console.log(`[FAIL] 发版校验未通过（--strict 模式下 ${counts.WARN} 项警告视为失败）`);
    }
  }
  process.exit(ok ? 0 : 1);
}

main();
