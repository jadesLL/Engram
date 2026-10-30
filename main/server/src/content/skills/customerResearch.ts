import type { SkillDoc } from './types.js';
import { CUSTOMER_RESEARCH_BRIDGE, CUSTOMER_RESEARCH_TRIGGER } from '../customerResearch.js';

export const SKILL: SkillDoc = {
  name: 'customer-research', title: '客户调研', version: 2,
  description: '内置与外部 Agent 共用的客户调研入口：先核验客户主体，再按证据量取得完整/简报/主体核验流程与模板。',
  whenToUse: CUSTOMER_RESEARCH_TRIGGER,
  body: CUSTOMER_RESEARCH_BRIDGE,
};
