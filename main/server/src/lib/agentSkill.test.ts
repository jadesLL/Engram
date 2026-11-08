import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  agentSkillInstalled,
  agentSkillPath,
  assertAgentSkillWritable,
  installAgentSkill,
  installAgentSkills,
  installedAgentSkills,
  isAgentSkillManaged,
  removeAgentSkill,
  removeAgentSkills,
} from './agentSkill.js';
import { CUSTOMER_RESEARCH_SKILL_NAME, ENGRAM_SKILL_NAME } from '../content/agentSkill.js';

const COMMAND = '"C:/node/node.exe" "C:/app/dist/cli/cli.js"';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-agent-skill-'));
}

test('安装两份 skill：frontmatter、管理标记、{{ENGRAM}} 换成实际命令、正文不含令牌', () => {
  const root = tempRoot();
  try {
    const files = installAgentSkills(root, COMMAND);
    assert.deepEqual(files, [
      agentSkillPath(root, ENGRAM_SKILL_NAME),
      agentSkillPath(root, CUSTOMER_RESEARCH_SKILL_NAME),
    ]);
    const engram = fs.readFileSync(files[0], 'utf8');
    assert.match(engram, /^---\nname: engram\n/);
    assert.match(engram, /<!-- engram-managed -->/);
    assert.ok(engram.includes(COMMAND + ' status'), '占位符必须替换成实际调用命令');
    assert.doesNotMatch(engram, /\{\{ENGRAM\}\}/);
    // 说明书是普通文件，任何 Agent 都能读：绝不能把令牌写进去
    assert.doesNotMatch(engram, /lwiki_|Bearer/);
    const research = fs.readFileSync(files[1], 'utf8');
    assert.match(research, /^---\nname: engram-customer-research\n/);
    assert.ok(research.includes(COMMAND + ' research begin'));
    assert.deepEqual(installedAgentSkills(root), { engram: true, customerResearch: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('安装幂等：内容没变不重写（保留 mtime），结果仍可读', () => {
  const root = tempRoot();
  try {
    const file = installAgentSkill(root, ENGRAM_SKILL_NAME, COMMAND);
    const first = fs.statSync(file).mtimeMs;
    const text = fs.readFileSync(file, 'utf8');
    installAgentSkill(root, ENGRAM_SKILL_NAME, COMMAND);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.ok(fs.statSync(file).mtimeMs >= first);
    // 命令变化时才重写（升级后客户端拿到的仍是当前命令）
    installAgentSkill(root, ENGRAM_SKILL_NAME, '"D:/node/node.exe" "D:/app/cli.js"');
    assert.ok(fs.readFileSync(file, 'utf8').includes('"D:/node/node.exe" "D:/app/cli.js" status'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('注销只删带管理标记的文件，目录空了顺手收掉', () => {
  const root = tempRoot();
  try {
    const files = installAgentSkills(root, COMMAND);
    const removed = removeAgentSkills(root);
    assert.deepEqual(removed.sort(), [...files].sort());
    assert.equal(agentSkillInstalled(root, ENGRAM_SKILL_NAME), false);
    assert.equal(agentSkillInstalled(root, CUSTOMER_RESEARCH_SKILL_NAME), false);
    assert.equal(fs.existsSync(path.join(root, ENGRAM_SKILL_NAME)), false, '空 skill 目录应一并删除');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同名 skill 不是 Engram 管理：拒绝覆盖、也不删除', () => {
  const root = tempRoot();
  try {
    const file = agentSkillPath(root, ENGRAM_SKILL_NAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '用户自己的 skill');
    assert.throws(() => installAgentSkill(root, ENGRAM_SKILL_NAME, COMMAND), /拒绝覆盖/);
    assert.equal(fs.readFileSync(file, 'utf8'), '用户自己的 skill');
    assert.throws(() => assertAgentSkillWritable(root, ENGRAM_SKILL_NAME), /拒绝覆盖/);
    assert.equal(removeAgentSkill(root, ENGRAM_SKILL_NAME), false, '用户文件不得被注销删除');
    assert.equal(fs.readFileSync(file, 'utf8'), '用户自己的 skill');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧版 engram-managed-customer-research: 标记视为 Engram 管理：可升级覆盖、可注销', () => {
  const root = tempRoot();
  try {
    const file = agentSkillPath(root, CUSTOMER_RESEARCH_SKILL_NAME);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: engram-customer-research\n---\n\n<!-- engram-managed-customer-research:v3 -->\n旧版正文');
    assert.equal(agentSkillInstalled(root, CUSTOMER_RESEARCH_SKILL_NAME), true);
    installAgentSkill(root, CUSTOMER_RESEARCH_SKILL_NAME, COMMAND);
    assert.match(fs.readFileSync(file, 'utf8'), /<!-- engram-managed -->/);
    assert.equal(removeAgentSkill(root, CUSTOMER_RESEARCH_SKILL_NAME), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('管理标记识别：新标记、旧标记前缀都认，普通文件不认', () => {
  assert.equal(isAgentSkillManaged('<!-- engram-managed -->\n正文'), true);
  assert.equal(isAgentSkillManaged('<!-- engram-managed-customer-research:v2 -->'), true);
  assert.equal(isAgentSkillManaged('name: engram\n正文'), false);
});
