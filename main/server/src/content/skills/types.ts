/**
 * 内置 skill 的类型定义。
 *
 * skill 与《Agent 作业指南》同级：都由服务端内置、经 MCP 下发给外部 Agent，
 * Agent 读到的是工具返回值，不是安装目录里的文件。
 * 与指南的区别是「按需」——skill_list 只回元数据，Agent 需要时才 skill_guide 取全文，
 * 因此 skill 增多不会一次性灌满上下文。
 */

/** 一份内置 skill：元数据 + 正文 */
export interface SkillDoc {
  /** kebab-case 标识，MCP 工具与界面清单共用；一经发布即对外契约，不改名 */
  name: string;
  /** 中文标题 */
  title: string;
  /** 一句话用途 */
  description: string;
  /** 何时该用（写进 skill_list 返回值，供 Agent 自行判断） */
  whenToUse: string;
  /**
   * skill 版本，独立于 agentGuide 的 GUIDE_VERSION。
   * 改 skill 不改抽取口径，因此不触发「全库规则落后」，不动 GUIDE_VERSION。
   */
  version: number;
  /** markdown 正文 */
  body: string;
}
