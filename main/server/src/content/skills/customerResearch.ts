import type { SkillDoc } from './types.js';
import { CUSTOMER_RESEARCH_BRIDGE, CUSTOMER_RESEARCH_TRIGGER } from '../customerResearch.js';

export const SKILL: SkillDoc = {
  name: 'customer-research', title: '客户调研', version: 3,
  description: '内置与外部 Agent 共用的客户调研入口：先核验客户主体，再按证据量取报告模式；完整报告自动入库、简报只反馈，重复客户先问新版本或覆盖。',
  whenToUse: CUSTOMER_RESEARCH_TRIGGER,
  body: CUSTOMER_RESEARCH_BRIDGE,
};
