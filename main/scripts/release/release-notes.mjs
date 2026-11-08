#!/usr/bin/env node
// 校验「## 未发布」区条目格式，或把它渲染成版本段落（含安卓累积段）并写回 CHANGELOG。
// 退出码：0 成功 / 1 检查或运行失败 / 2 参数错误。
import fs from 'node:fs';
import path from 'node:path';
import { readVersions, resolveMainDir, parseSemver } from './lib/versions.mjs';
import { readChangelog, parseChangelog, validateEntries, renderChangelog, todayLocal, isValidDate } from './lib/changelog.mjs';

const USAGE = `用法：
  node scripts/release/release-notes.mjs --check  [--repo <mainDir>]
  node scripts/release/release-notes.mjs --render [--write] [--version <v>] [--date YYYY-MM-DD]
                                               [--android-base <vX>] [--summary "<文字>"] [--repo <mainDir>]

说明：
  --check   校验「## 未发布」区条目格式（无未发布区只 WARN）
  --render  生成 ## v<版本>（日期）段落；默认版本 = desktop/package.json 当前版本，日期 = 本地今天
  --write   与 --render 一起用时真正写盘，否则只打印预览`;

function usageFail(message) {
  console.log(`[FAIL] ${message}`);
  console.log(USAGE);
  process.exit(2);
}

function stripV(value) {
  return String(value).replace(/^v/, '');
}

function printValidation(validation) {
  for (const warning of validation.warnings) console.log(`[WARN] ${warning.message}`);
  for (const error of validation.errors) console.log(`[FAIL] ${error.message}`);
}

function main() {
  const argv = process.argv.slice(2);
  let repoArg = null;
  let mode = null;
  let write = false;
  let versionArg = null;
  let dateArg = null;
  let androidBaseArg = null;
  let summary = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined) usageFail(`${name} 需要一个参数值`);
      i += 1;
      return value;
    };
    if (arg === '--check' || arg === '--render') {
      if (mode && mode !== arg.slice(2)) usageFail('--check 与 --render 只能选一个');
      mode = arg.slice(2);
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--repo') {
      repoArg = takeValue('--repo');
    } else if (arg.startsWith('--repo=')) {
      repoArg = arg.slice('--repo='.length);
      if (!repoArg) usageFail('--repo= 后面需要目录参数');
    } else if (arg === '--version') {
      versionArg = takeValue('--version');
    } else if (arg.startsWith('--version=')) {
      versionArg = arg.slice('--version='.length);
    } else if (arg === '--date') {
      dateArg = takeValue('--date');
    } else if (arg.startsWith('--date=')) {
      dateArg = arg.slice('--date='.length);
    } else if (arg === '--android-base') {
      androidBaseArg = takeValue('--android-base');
    } else if (arg.startsWith('--android-base=')) {
      androidBaseArg = arg.slice('--android-base='.length);
    } else if (arg === '--summary') {
      summary = takeValue('--summary');
    } else if (arg.startsWith('--summary=')) {
      summary = arg.slice('--summary='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else {
      usageFail(`未知参数：${arg}`);
    }
  }

  if (!mode) usageFail('需要 --check 或 --render');
  if (write && mode !== 'render') usageFail('--write 只能与 --render 一起使用');
  if (dateArg !== null && !isValidDate(dateArg)) usageFail(`--date 不是合法日期：${dateArg}`);
  if (androidBaseArg !== null && !parseSemver(stripV(androidBaseArg))) usageFail(`--android-base 不是合法版本号：${androidBaseArg}`);
  if (versionArg !== null && !parseSemver(stripV(versionArg))) usageFail(`--version 不是合法版本号：${versionArg}`);

  let repoDir;
  try {
    repoDir = resolveMainDir(repoArg);
  } catch (err) {
    console.log(`[FAIL] ${err.message}`);
    process.exit(err.exitCode === 2 ? 2 : 1);
  }

  let changelog;
  try {
    changelog = readChangelog(repoDir);
  } catch (err) {
    console.log(`[FAIL] ${err.message}`);
    process.exit(1);
  }
  const relative = path.relative(repoDir, changelog.path) || changelog.path;
  const parsed = parseChangelog(changelog.text);

  if (mode === 'check') {
    if (!parsed.unreleased) {
      console.log('[WARN] CHANGELOG 无「## 未发布」区（老标签树兼容），跳过格式检查');
      return;
    }
    const entries = parsed.unreleased.entries;
    if (entries.length === 0) {
      console.log('[WARN] 「## 未发布」区为空，没有条目需要检查');
      return;
    }
    const validation = validateEntries(entries);
    printValidation(validation);
    if (validation.errors.length > 0) {
      console.log(`[FAIL] 「## 未发布」区条目格式有误（${validation.errors.length} 处），请按 [平台影响: A|B|C|D|E|F|none] 修正`);
      process.exit(1);
    }
    console.log(`[PASS] 「## 未发布」区 ${entries.length} 条条目格式正确（${relative}）`);
    return;
  }

  // --render
  let version = versionArg !== null ? stripV(versionArg) : null;
  if (version === null) {
    const versions = readVersions(repoDir);
    if (!versions.version) {
      console.log('[FAIL] 读不到 desktop/package.json 的当前版本；请先 bump 或用 --version 指定');
      process.exit(1);
    }
    version = versions.version;
  }
  const date = dateArg !== null ? dateArg : todayLocal();
  let androidBase = androidBaseArg !== null ? stripV(androidBaseArg) : null;
  if (androidBase === null) androidBase = parsed.released.length > 0 ? parsed.released[0].version : null;

  let rendered;
  try {
    rendered = renderChangelog({ text: changelog.text, version, date, summary, androidBase });
  } catch (err) {
    console.log(`[FAIL] ${err.message}`);
    process.exit(1);
  }

  console.log(`----- v${version} 版本段落预览 -----`);
  console.log(rendered.section);
  console.log('----- 预览结束 -----');

  const lineCount = rendered.section.split('\n').length;
  const androidCount = rendered.android ? rendered.android.count : 0;
  const parts = [`${lineCount} 行`, `${rendered.movedEntries.length} 条未发布条目`];
  if (rendered.android) parts.push(`安卓累计 ${androidCount} 条（基线 v${rendered.android.baseVersion}）`);
  console.log(`[OK] 渲染出 v${version} 版本段落（${parts.join('，')}）`);

  if (!write) {
    console.log('[WARN] 未写盘：加 --write 才会修改 CHANGELOG.md');
    return;
  }
  try {
    fs.writeFileSync(changelog.path, rendered.text, 'utf8');
  } catch (err) {
    console.log(`[FAIL] 写入 CHANGELOG 失败：${err.message}`);
    process.exit(1);
  }
  console.log(`[OK] 已写入 ${relative}`);
}

main();
