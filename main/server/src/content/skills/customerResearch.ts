import type { SkillDoc } from './types.js';
import { CUSTOMER_RESEARCH_BRIDGE, CUSTOMER_RESEARCH_TRIGGER } from '../customerResearch.js';

export const SKILL: SkillDoc = {
  name: 'customer-research', title: '客户调研', version: 1,
  description: '内置与外部 Agent 共用的客户调研入口，取得 ACS 流程与固定报告模板。',
  whenToUse: CUSTOMER_RESEARCH_TRIGGER,
  body: CUSTOMER_RESEARCH_BRIDGE,
};
