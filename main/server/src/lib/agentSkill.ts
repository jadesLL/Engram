import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOMER_RESEARCH_SKILL_NAME,
  ENGRAM_SKILL_NAME,
  INSTALLED_SKILLS,
  LEGACY_CUSTOMER_RESEARCH_MARKER,
  SKILL_MARKER,
  SKILL_MARKER_PREFIX,
  findInstalledSkill,
  renderSkillText,
} from '../content/agentSkill.js';

/**
 * 客户端 skills 目录里两份 skill 的安装 / 注销 / 状态。
 *
 * 目录约定：`<root>/engram/SKILL.md` 与 `<root>/engram-customer-research/SKILL.md`。
 * 只碰带管理标记（<!-- engram-managed -->，含旧版 engram-managed-customer-research: 前缀）的文件：
 * 用户自己写的同名 skill 一律不覆盖、不删除——那是用户的文件，插进一句话就把人家的说明书改掉了。
 */

/** 文本是否由 Engram 管理（新标记或旧版客户调研入口标记） */
export function isAgentSkillManaged(text: string): boolean {
  return text.includes(SKILL_MARKER) || text.includes(LEGACY_CUSTOMER_RESEARCH_MARKER) || text.includes(SKILL_MARKER_PREFIX);
}

/** skill 文件路径：<root>/<name>/SKILL.md */
export function agentSkillPath(root: string, name: string): string {
  return path.join(root, name, 'SKILL.md');
}

/** 安装状态：文件存在且带 Engram 管理标记（旧版本装的也算已装，便于升级覆盖/注销） */
export function agentSkillInstalled(root: string, name: string): boolean {
  try {
    return isAgentSkillManaged(fs.readFileSync(agentSkillPath(root, name), 'utf8'));
  } catch {
    return false;
  }
}

/** 两份 skill 的安装情况（设置页展示用） */
export function installedAgentSkills(root: string): { engram: boolean; customerResearch: boolean } {
  return {
    engram: agentSkillInstalled(root, ENGRAM_SKILL_NAME),
    customerResearch: agentSkillInstalled(root, CUSTOMER_RESEARCH_SKILL_NAME),
  };
}

/** 同名 skill 已存在但不是 Engram 管理的：拒绝覆盖（沿用旧 assert...Writable 语义） */
export function assertAgentSkillWritable(root: string, name: string): void {
  const file = agentSkillPath(root, name);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // 文件不存在 = 可写
  }
  if (!isAgentSkillManaged(text)) throw new Error(`同名 skill 非 Engram 管理，拒绝覆盖：${file}`);
}

/**
 * 安装一份 skill（幂等）：把 {{ENGRAM}} 替换成实际调用命令后原子写入。
 * command 省略时用 PATH 里的 engram（内置 Agent 的 shim 目录已注入 PATH）。
 */
export function installAgentSkill(root: string, name: string, command = 'engram'): string {
  const skill = findInstalledSkill(name);
  if (!skill) throw new Error(`未知 skill：${name}`);
  assertAgentSkillWritable(root, name);
  const file = agentSkillPath(root, name);
  const text = renderSkillText(skill.text, command);
  try {
    if (fs.readFileSync(file, 'utf8') === text) return file;
  } catch {
    /* 首次安装 */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return file;
}

/** 注销一份 skill：只删带管理标记的文件；目录空了顺手收掉。返回是否删除 */
export function removeAgentSkill(root: string, name: string): boolean {
  const file = agentSkillPath(root, name);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  if (!isAgentSkillManaged(text)) return false;
  fs.unlinkSync(file);
  const dir = path.dirname(file);
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* 目录里有别的文件或删不掉：保留 */
  }
  return true;
}

/** 安装两份 skill（engram + engram-customer-research），返回写入的文件路径 */
export function installAgentSkills(root: string, command = 'engram'): string[] {
  return INSTALLED_SKILLS.map((skill) => installAgentSkill(root, skill.name, command));
}

/** 注销两份 skill，返回实际删除的文件路径 */
export function removeAgentSkills(root: string): string[] {
  return INSTALLED_SKILLS
    .filter((skill) => removeAgentSkill(root, skill.name))
    .map((skill) => agentSkillPath(root, skill.name));
}