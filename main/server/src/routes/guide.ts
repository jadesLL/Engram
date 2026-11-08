import { FastifyInstance } from 'fastify';
import { requireAssistantAccess } from '../assistant/access.js';
import { AGENT_GUIDE } from '../content/agentGuide.js';
import { SKILLS, findSkill } from '../content/skills/index.js';
import { INSTALLED_SKILLS, renderSkillText } from '../content/agentSkill.js';

/**
 * 外部 Agent 作业指南与内置 skill（CLI `engram guide` / `engram skill list|show` 的数据源）。
 *
 * v1.5.1：手机绑定中枢后，设置 → Agent 与自动化 → 工具与手册 要经同步成员令牌窄代理
 * 到中枢读这份只读指南，所以鉴权从 owner-only（requireAuth）放宽到
 * requireAssistantAccess（owner / Agent 令牌 / 同步成员令牌）。内容本身是静态文档，无敏感配置。
 *
 * skill 与指南同级但按需获取：`skill list` 只回元数据，`skill show <name>` 才回全文，
 * 因此 skill 增多不会一次性灌满 Agent 上下文。数据源 = content/skills 注册表 SKILLS
 * （作业手法）+ content/agentSkill.ts 的 INSTALLED_SKILLS（装在客户端 skills 目录的两份：
 * engram 命令参考、客户调研入口）。后者按 `engram` 泛化命令回显——它描述的是「PATH 里就有
 * engram」的通用用法，客户端安装时各自替换成自己的完整命令（见 lib/agentSkill.ts）。
 */
export async function guideRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAssistantAccess);

  app.get('/api/guide', async () => ({ guide: AGENT_GUIDE }));

  /** 两份安装型 skill 的元数据 + 正文（正文里的 {{ENGRAM}} 回显为通用 engram 命令） */
  const installedSkills = INSTALLED_SKILLS.map((skill) => ({
    name: skill.name,
    title: skill.title,
    description: skill.description,
    whenToUse: skill.whenToUse,
    version: skill.version,
    body: renderSkillText(skill.text, 'engram'),
  }));

  /** skill 元数据清单：先作业手法（content/skills），再安装型 skill（engram / engram-customer-research） */
  app.get('/api/agent/skills', async () => ({
    skills: [
      ...SKILLS.map((skill) => ({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        whenToUse: skill.whenToUse,
        version: skill.version,
      })),
      ...installedSkills.map((skill) => ({
        name: skill.name,
        title: skill.title,
        description: skill.description,
        whenToUse: skill.whenToUse,
        version: skill.version,
      })),
    ],
  }));

  /** 按名读取一份 skill 的全文；未找到返回 404（附带可用清单，便于 CLI 提示） */
  app.get('/api/agent/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const builtin = findSkill(name);
    if (builtin) {
      return {
        name: builtin.name,
        title: builtin.title,
        description: builtin.description,
        whenToUse: builtin.whenToUse,
        version: builtin.version,
        body: builtin.body,
      };
    }
    const installed = installedSkills.find((skill) => skill.name === name);
    if (!installed) {
      return reply.code(404).send({
        error: `未找到 skill: ${name}`,
        available: [...SKILLS.map((item) => item.name), ...installedSkills.map((item) => item.name)],
      });
    }
    return installed;
  });
}
