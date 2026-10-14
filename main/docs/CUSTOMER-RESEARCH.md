# 客户调研

桌面版与 Docker 网页共用客户调研服务。主导航打开「客户调研」，输入客户全名或简称，选择「知识库 + 联网调研」或「仅知识库资料」，点击「调研并保存」。需先在「设置 → Agent 与自动化」配置内置 Agent。

## 流程与报告

按客户主体核对、库内资料回溯、公开资料补充、ACS 五看/联合创新/客户关系分析、机会风险与行动计划、报告校验推进。联网由执行 Agent 的工具完成；没有联网能力时必须写清限制，不能把库内旧资料称为最新。

「流程与模板」可修改流程正文和章节标题。内置与外部 Agent 每次开始任务都读取同一版本，已开始的任务保留自己的规则快照。报告固定保留：调研范围与执行摘要、客户概况、五看洞察、联合创新、决策链与关系、机会风险、90 天行动计划、资料缺口、系统生成的来源对照。无证据的栏目写资料不足，不补数字。

内置按钮明确授权生成并保存；报告经专用提交工具校验后写入 `原始资料/文档/YYYY.MM.DD_<客户>_客户调研_<任务标识>.md`。历史报告不覆盖，保存失败不标成功。执行过程保留在 Agent 会话，取消或失败的任务不能继续提交成品。

## 外部 Agent

统一 MCP 入口 `begin_customer_research` 返回任务 ID、流程、模板、版本和排期基准日；`submit_customer_research` 接收固定章节对象与来源列表，检查缺章、无效引用、重复来源、库内来源存在性、范围和保存路径。结构检查不证明事实真伪，网页来源仍需 Agent 实际阅读核查。

在「设置 → Agent 与自动化 → 外部 Agent 接入」重新注册：

| 客户端 | 客户调研触发入口 |
| --- | --- |
| Codex | 用户级 `.agents/skills/engram-customer-research/SKILL.md` |
| ZCode | `.zcode/skills/engram-customer-research/SKILL.md` |
| DeepSeek Harness（dsh） | `$DSH_HOME/skills/engram-customer-research/SKILL.md` |
| WorkBuddy | 用户级 `.codebuddy/skills/engram-customer-research/SKILL.md`（兼容其 CodeBuddy 配置） |
| Kimi Code CLI | `$KIMI_CODE_HOME/skills/engram-customer-research/SKILL.md`（默认 `.kimi-code`） |
| Kimi Work | Engram 个人插件的 `skillInstructions`；重新登记后仍需在 Kimi Work 安装插件 |

入口 skill 只包含何时使用和如何调用，不复制 ACS 全文，不含 Token。重新注册不会覆盖用户自行创建的同名技能；注销只删除带 Engram 管理标记的入口。Docker 的一键注册只作用于服务端所在机器，不能替远程电脑改配置；远程客户端使用配置片段，并复制或导入入口 SKILL.md。

外部聊天说「调研客户 A」时默认返回报告预览；说「调研并保存」或之后要求保存时，Agent 才提交 `save=true`。不自动更新客户实体页。自然语言自动触发依赖客户端是否加载了 skill 和模型是否遵循规则；可用客户端的显式 skill 命令减少漏选，不能把配置写入成功等同于真实模型已调用。

客户端路径依据：[Codex](https://learn.chatgpt.com/docs/build-skills)、[ZCode](https://zcode.network/cn/docs/skill/)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)、[WorkBuddy](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Setting)、[Kimi Code](https://moonshotai.github.io/kimi-code/en/customization/skills)。
