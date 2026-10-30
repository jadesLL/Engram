import fs from 'node:fs';
import path from 'node:path';
import { CUSTOMER_RESEARCH_SKILL_FILE } from '../content/customerResearch.js';

/**
 * Engram 管理标记前缀：v1/v2 都认。版本号写在标记里、内容会随契约升级（v2 起正文带主体核验流程），
 * 用前缀判断才能把旧版本装过的入口 skill 当成自己的——否则升级后既覆盖不了也注销不掉。
 */
const MARKER = '<!-- engram-managed-customer-research:';
export function customerResearchSkillPath(root: string): string {
  return path.join(root, 'engram-customer-research', 'SKILL.md');
}
export function customerResearchSkillInstalled(root: string): boolean {
  try { return fs.readFileSync(customerResearchSkillPath(root), 'utf8') === CUSTOMER_RESEARCH_SKILL_FILE; }
  catch { return false; }
}
export function assertCustomerResearchSkillWritable(root: string): void {
  const file = customerResearchSkillPath(root);
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARKER)) throw new Error(`同名 skill 非 Engram 管理，拒绝覆盖：${file}`);
}
/** Only a launcher is installed: no credentials or frozen research workflow in clients. */
export function installCustomerResearchSkill(root: string): string {
  const file = customerResearchSkillPath(root);
  assertCustomerResearchSkillWritable(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, CUSTOMER_RESEARCH_SKILL_FILE); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return file;
}
export function removeCustomerResearchSkill(root: string): void {
  const file = customerResearchSkillPath(root);
  if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(MARKER)) return;
  fs.unlinkSync(file);
  const folder = path.dirname(file);
  if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
}
