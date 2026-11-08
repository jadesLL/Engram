import { CUSTOMER_RESEARCH_TRIGGER } from './customerResearch.js';

/**
 * 安装到各客户端 skills 目录的两份说明书（单一来源）。
 *
 * 安装时把 {{ENGRAM}} 替换成实际调用命令（见 renderSkillText）：本机内置 Agent 用 PATH 里的
 * engram（shim 由 lib/cliShim.ts 写入并把目录注入 PATH），外置客户端用带引号的
 * "<node>" "<cli.js>" 完整命令。正文里绝不放 token——skill 是普通文件，任何 Agent 都能读。
 */

export const ENGRAM_SKILL_NAME = 'engram';
export const CUSTOMER_RESEARCH_SKILL_NAME = 'engram-customer-research';

/** 管理标记：带这个前缀（含旧版 engram-managed-customer-research:）的文件才允许覆盖/注销 */
export const SKILL_MARKER = '<!-- engram-managed -->';
/** 旧版客户调研入口 skill 的标记前缀（升级时按前缀识别并覆盖） */
export const LEGACY_CUSTOMER_RESEARCH_MARKER = '<!-- engram-managed-customer-research:';
/** 管理标记的公共前缀：带它的文件视为 Engram 管理（新旧标记都从它开始） */
export const SKILL_MARKER_PREFIX = '<!-- engram-managed';

/** 命令占位符：安装/下发时替换成实际 CLI 调用命令 */
export const ENGRAM_COMMAND_PLACEHOLDER = '{{ENGRAM}}';

/** 把 {{ENGRAM}} 占位符替换成实际 CLI 调用命令（保留其余内容逐字不变） */
export function renderSkillText(text: string, command: string): string {
  const value = String(command || '').trim() || 'engram';
  return text.split(ENGRAM_COMMAND_PLACEHOLDER).join(value);
}

const HEADER = `---
name: ${ENGRAM_SKILL_NAME}
description: 读写 Engram 个人知识库时使用：检索、页面读写、原始资料、收集箱、名称核验与客户调研全部通过 engram 命令行完成；任何需要访问 Engram 知识库或 Engram 服务端能力的任务都先读本 skill。
---

${SKILL_MARKER}
# Engram 知识库（CLI）
`;

const ENGRAM_BODY = `
Engram 不内置 AI：读、写、提炼全部由你（Agent）完成，Engram 只负责存储、解析、检索与写入门禁。
所有能力都通过一条命令调用：下面写作 {{ENGRAM}}（下文简写 engram）；加 --json 可得机器可读输出。

## 何时用

- 用户让你查、读、写、整理知识库（Wiki 页面、原始资料、证据账本、图谱关联）。
- 用户给你原始资料要求提炼成 Wiki 概念/实体页，或要求按最新规则重提炼旧页面。
- 用户要求把调研结果、对话记录存进知识库，或要求整理收集箱里的文件。
- 需要走 Engram 内置流程：客户调研（research）、公司全名核验（names）、收集箱转换（inbox）。
- 不确定当前连接、权限或知识库状态时，先跑 {{ENGRAM}} status。

## 连接

- 本机（桌面 / 源码 / Docker 本机）：零配置——服务端启动时已把地址与专用令牌写进 \`~/.engram/config.json\`，直接跑 {{ENGRAM}} status 即可。
- 远程客户端：先 \`{{ENGRAM}} login --url <服务地址> --token <Agent 令牌>\`（令牌在 Engram「设置 → Agent 与自动化 → 外部接入 → Agent 令牌」生成），之后照常使用；\`{{ENGRAM}} config show\` 查看当前连接（令牌脱敏）。
- 全局参数：\`--json\` 机器可读输出；\`--url/--token/--allow-private\` 临时覆盖连接（不写配置文件）。
- 出错时 stderr 输出原因并返回非 0 退出码：2 = 用法/配置错误，1 = 服务端拒绝或失败。

## 命令参考

### 基础

- \`{{ENGRAM}} status\` —— 健康检查 + 连接信息 + 计数
- \`{{ENGRAM}} config show\` —— 当前连接（令牌脱敏）
- \`{{ENGRAM}} guide\` —— 《Agent 作业指南》全文（知识库结构、页面契约、证据门禁、提炼八阶段）
- \`{{ENGRAM}} skill list\` —— 内置作业 skill 清单（名称 / 用途 / 何时用 / 版本）
- \`{{ENGRAM}} skill show <name>\` —— 取一份内置 skill 的全文
- \`{{ENGRAM}} login --url <url> --token <token>\` —— 登记远程连接

### 检索与页面（Wiki）

- \`{{ENGRAM}} search <query> [--limit N]\` —— 关键词检索（页面 + 原始资料提取文本）
- \`{{ENGRAM}} pages list [--outdated] [--tag T] [--path P]\` —— 目录树；--outdated 只列规则版本落后的页面
- \`{{ENGRAM}} pages read <ref>\` —— 按标题或页面 ID 读全文
- \`{{ENGRAM}} pages related <ref>\` —— 图谱关联（入链 / 出链、实体关系）
- \`{{ENGRAM}} pages evidence <ref>\` —— 证据账本（来源、版本、事实与逐字引文）
- \`{{ENGRAM}} pages write <path> --title T [--type concept|person|customer|org|project|other] [--tags a,b] [--evidence "原始资料/路径::逐字引文"]... [--file F|-]\` —— 新建 / 覆盖页面（只能写 Wiki/；正文用 --file 或 stdin）
- \`{{ENGRAM}} pages rename <ref> --title T\` —— 改名：文件随标题移动、[[旧标题]] 双链自动重定向，页面 ID 与图谱边不变
- \`{{ENGRAM}} pages move <ref> [--dir Wiki/实体] [--title T]\` —— 移到 Wiki 树内其他目录（页面 ID 与图谱边不变）
- \`{{ENGRAM}} pages delete <ref> [--reason R]\` —— 移入回收站（软删除、可恢复；不能删 AIWorks/）
- \`{{ENGRAM}} pages asset <ref> [--out F]\` —— 读页面正文引用的 /media/... 图片：默认落临时文件并打印路径（--json 含 path / mimeType）

### 原始资料

- \`{{ENGRAM}} files list [--pending] [--dir D]\` —— 原始资料清单（含提取状态与已提炼标记；--pending 只列待提炼）
- \`{{ENGRAM}} files read <path> [--out F]\` —— 提取文本；--out 时写入文件
- \`{{ENGRAM}} files raw <path> [--out F]\` —— 原件字节；图片 / 二进制必须给 --out（默认落临时文件并打印路径）
- \`{{ENGRAM}} files add <path> [--file F|-]\` —— 新建原始资料 Markdown（正文来自文件或 stdin；已有路径拒绝覆盖）

### 收集箱（不是知识库）

- \`{{ENGRAM}} inbox list [--status all|pending|converted|adopted] [--limit N]\` —— 待整理原件与转换状态
- \`{{ENGRAM}} inbox read <path> [--out F]\` —— 读一份原件；图片落临时文件（--json 含 path / mimeType）
- \`{{ENGRAM}} inbox raw <path> --out F\` —— 原件字节（图片）
- \`{{ENGRAM}} inbox add <path> [--file F|-]\` —— 把一段文本新建为收集箱原件
- \`{{ENGRAM}} inbox write <path> [--file F|-] [--title T] [--note N]\` —— 把语义转换结果写成 Markdown（落 收集箱/转换结果/）
- \`{{ENGRAM}} inbox convert <path>\` —— 服务端一键转换（稳定分块，可能耗时数分钟）

### 对话沉积

- \`{{ENGRAM}} chat save [--identifier I] [--project P] [--append] [--file F|-]\` —— 把对话保存到 原始资料/对话/（**须用户明确指示**）

### 名称核验（公司工商全名，全库唯一允许问用户的事）

- \`{{ENGRAM}} names check <名称> [--page R] [--note N]\` —— 登记待核名称；服务端先自查资料库
- \`{{ENGRAM}} names propose <id> [--full-name F] [--source S] [--note N]\` —— 回填联网查到的工商全名
- \`{{ENGRAM}} names answer <id> --allow|--deny [--note N]\` —— 回填用户在对话里的答复
- \`{{ENGRAM}} names list [--status pending|open|unresolved|all]\` —— 核验清单
- \`{{ENGRAM}} names audit\` —— 全库公司页名称盘点

### 客户调研

- \`{{ENGRAM}} research begin --customer C [--scope knowledge-web|knowledge-only] [--save] [--save-mode new|overwrite] [--overwrite-path P] [--client X] [--timezone TZ]\` —— 建立调研任务，返回流程 / 主体核验契约 / 报告模式 / 知识库已有报告
- \`{{ENGRAM}} research submit --task <taskId> [--file F|-]\` —— 提交报告 JSON（identity / sections / sources / save / saveMode / overwritePath）

### 提问（仅内置 Agent）

- \`{{ENGRAM}} ask --data '{"questions":[{"id":"q1","question":"…","header":"确认","options":[{"label":"允许","description":"…"}]}]}' [--file F|-] [--timeout-ms N]\` —— 在 Engram 对话最下侧弹出选项并阻塞等待用户点选，答复后同一轮继续；没有活跃对话轮次时返回 no_active_run。
- 外部 Agent（Claude Code / Codex 等）用自己的提问组件问在对话里，不要用 ask（它等的是 Engram 界面）。

## 操作纪律

1. **动手前先读日志**：\`{{ENGRAM}} pages read AIWorks/log/log.md\` 了解最近状态；写操作完成后服务端自动记日志，你无需重复记录，只有在做了合并、批量重整等复合动作时才手工补一条说明。
2. **页面写入只限 Wiki/**：write / rename / move / delete 只允许操作 Wiki/ 下的页面；AIWorks/ 是系统区（服务端自动生成，只读）。
3. **证据门禁**：新建概念 / 实体页必须带 evidence（≥2 个不同原始资料路径各 1 条逐字引文，或单一来源 ≥2 条）；引文必须逐字存在于来源，服务端会校验。已有页面增量更新不受此限。门禁报「来源必须在 原始资料/ 下」时跳过这条事实或改用库内来源，把缺口记进「待核实」，不要找旁路塞文件。
4. **原始资料默认只读**：只有用户明确要求保存时才用 \`files add\` 新建——调研成果写 原始资料/文档/、用户随口记的零散内容写 原始资料/灵感碎片/；已有路径拒绝覆盖，也不能写 原始资料/对话/（那是 chat save 专用）。收集箱入库必须由用户在界面确认，不能走 HTTP/CLI 旁路直接写资料区或代替用户入库。
5. **原始资料正文不写一级标题**：标题由文件名（YYYY.MM.DD_标题.md）与 frontmatter 承载，正文开头再写 # 标题 是重复（服务端会去掉）。
6. **保存对话须用户指示**：用户明确说「沉淀」才用 chat save；不要自行判断对话有价值就写。沉淀后的对话属于原始资料，可被后续提炼引用。
7. **删除是纠错手段而非整理手段**：误建页才 delete（只入回收站、可恢复）；已有页面优先增量改写，不要反复删建。改名 / 换目录用 rename / move（页面 ID 与双链保持不变），不要「新建 + 删除」。
8. **拿不准就自己定并标注依据**：只有用户才知道、资料里又查不到的信息，按证据取最可信的写法落页并在正文标注「待核实」与依据；不得编造，也不要停下来空等。**唯一例外是公司工商全名**，见下条。
9. **公司全名核验（全库唯一允许问用户的事）**：公司类实体的名称不是工商全名、资料库里也没有全名时：① \`names check\` 登记（服务端先自查资料库，找到全名就直接用 \`pages rename\` 改名，不问用户）；② 没有全名时在对话里问用户是否允许联网查企查查 / 天眼查——内置 Agent 用 \`{{ENGRAM}} ask\`，外部 Agent 用自带提问能力；③ 用户允许后用 \`names propose\` 回填全名与出处；④ 再问一次是否改用全名，同意后由服务端执行改名。查不到就不传 fullName；用户不允许或查不到时标题保持材料写法并标注「全称待确认」，继续作业、不反复请示；收尾用 \`names list --status unresolved\` 列出仍未定全名的条目。
10. **收集箱不是知识库**：inbox 里的原件只能用于「读懂它并按语义转成 Markdown」：优先 \`inbox convert\`（服务端稳定分块），自己按语义重写再用 \`inbox write\`；不要把它写进页面、不要当 evidence、不要在回答里当作事实依据。
11. **图片看原图**：pages asset / files raw / inbox read 默认把图片落到临时文件并打印路径，再用你自己的图片读取工具打开那个文件。图片是某个 md 父项的私有资产（正文以 /media/<父项id>/<文件名> 引用），没有全局图片清单，也不需要为图片建页。
12. **分点书写**：页面正文与对用户的说明都用列表 / 小标题分点，每点一个完整短句；正文 150-400 字 / 页，客户页可适当放宽，仍以分点、不堆砌为限。用户手写的章节永远保留。
13. **改写不搬运**：用你自己的话综合事实；单次纪要 / 速报不独立建页；[[双链]] 只指已有或本次新建的页面；时间线只记业务事件。
14. **内置 Agent 用 ask 提问，外置 Agent 用自带提问能力**：内置 Agent 的「弹选项问用户」只有 \`{{ENGRAM}} ask\`（会阻塞到用户点选 / 超时）；外部 Agent 没有这个通道，直接用自己的提问组件或在回复里列出编号问题并停下等待。

## 提炼作业流程（摘要，全文用 \`{{ENGRAM}} guide\`）

1. **Index**：\`{{ENGRAM}} files list --pending\` 取待提炼清单；已提炼的跳过，提取未完成的稍后再取。
2. **逐份串行**：一次只处理一份——读一份、提炼、\`pages write\` 提交成功，再取下一份；不要批量读完再统一写页。
3. 每份按 Map（抽取）→ Normalize（归并）→ Retrieve（查重）→ Plan（决策）→ Critic（自查）→ Compose（撰写）→ Verify（逐字核验引文）→ Commit（write）八阶段作业。
4. **规则更新重提炼**：\`{{ENGRAM}} pages list --outdated\` 列落后页面，逐页读原文 + 取既有证据后按最新指南重写；格式类规则只改排版不动事实。

## 质量红线

- 改写不搬运 | 无依据不编造 | 单次纪要 / 速报不独立建页 | [[双链]] 只指名录或本次新建页 | 时间线只记业务事件 | 分点书写、不堆大段。
- 引文逐字可溯是知识库的立身之本：宁可少写，不可编造。公司全名不编造、不推测、不绕过用户自行改名。
- 用户手写内容（页面中不属于标准章节的段落）永远保留，不被 AI 产出覆盖。
`;

export const ENGRAM_SKILL = HEADER + ENGRAM_BODY;

const CUSTOMER_RESEARCH_HEADER = `---
name: ${CUSTOMER_RESEARCH_SKILL_NAME}
description: 调研客户、分析目标公司、客户背景调查和客户洞察报告时使用；先核验主体，再从 Engram 获取统一流程与模板。不用于单个事实查询或报告改写。
---

${SKILL_MARKER}
# Engram 客户调研
`;

const CUSTOMER_RESEARCH_BODY = `
${CUSTOMER_RESEARCH_TRIGGER}

## 用法

1. 建立任务：\`{{ENGRAM}} research begin --customer "<客户名>" [--scope knowledge-web|knowledge-only]\`
   - 默认 knowledge-web（知识库 + 联网调研）；knowledge-only = 只查知识库、不联网。
   - 只在用户要求保存时加 \`--save\`；知识库已有该客户报告（返回 existingReports）且用户要求保存时，必须先问用户「生成新版本还是覆盖旧报告」，再传 \`--save-mode new\` 或 \`--save-mode overwrite --overwrite-path <已有报告 path>\`。
   - 返回 taskId、workflow、identityContract、reportContract、modeRules；按返回执行，不要凭记忆复用流程。
2. 先核验客户主体：用公开工商 / 官方渠道（企查查、天眼查、国家企业信用信息公示系统、公司官网、年报 / 公告）或知识库原始资料核对输入名称，记录查过的渠道与关键词（attempts）。公开渠道与知识库都确认不了主体时，identity.status 填 not-found——必须质疑客户是否存在或名称写错，只交「主体核验」短报告，不写客户分析。知识库里只有名称提法、名单条目、Wiki 页面不算主体证据。
3. 按证据量选模式（服务端校验）：完整报告（8 章，仅 knowledge-web + verified，外部来源 ≥2、来源总数 ≥3 且至少 1 条工商 / 官方来源）／资料不足简报（summary / facts / gaps）／主体核验短报告（summary / gaps）。达不到就降级，不要用行业泛论凑章节。
4. 报告写成 JSON 后提交：\`{{ENGRAM}} research submit --task <taskId> --file report.json\`（或 \`--file -\` 从 stdin 读）
   - sections 键随模式：完整 8 章全部；简报 summary / facts / gaps；主体核验 summary / gaps。
   - sources 每条写 id、title、url 或 path、kind（registry / official / media / kb-doc / kb-page）、publishedAt（未知写「未标注」）、accessedAt（YYYY-MM-DD）。
   - 校验失败按返回问题修正，不要绕过；来源不足如实降级，不声称已联网或获得最新信息。
5. 保存与入库：完整报告自动入库；资料不足简报只留在客户洞察页、不自动导入（不要声称已保存）；主体核验不保存。外部对话只有用户明确要求保存才 save=true。

## 写作纪律

结论先行；只写与该客户直接相关、能指回来源的事实；推断标「推断」，不确定写「待核实」；禁止方法论、能力声明、检索过程、免责声明等元叙述；禁止空话套话；每章不超过 reportContract 的长度上限，超了会被拒收。
`;

export const CUSTOMER_RESEARCH_SKILL = CUSTOMER_RESEARCH_HEADER + CUSTOMER_RESEARCH_BODY;

/** 一份要安装到客户端 skills 目录的 skill 定义 */
export interface InstalledSkill {
  /** 目录名（也是 frontmatter name） */
  name: string;
  /** 元数据标题（engram skill list 展示用） */
  title: string;
  /** 一句话说明（设置页与 skill list 展示用） */
  description: string;
  /** 何时用（skill list 展示用） */
  whenToUse: string;
  /** skill 版本，独立于 GUIDE_VERSION */
  version: number;
  /** 原始正文（含 {{ENGRAM}} 占位符与 <!-- engram-managed --> 管理标记） */
  text: string;
}

/** 本机需要安装的两份 skill（顺序即安装顺序） */
export const INSTALLED_SKILLS: InstalledSkill[] = [
  {
    name: ENGRAM_SKILL_NAME,
    title: 'Engram 知识库（CLI）',
    description: '知识库读写命令参考与作业纪律（engram CLI）',
    whenToUse: '需要访问 Engram 知识库（检索、读写页面、原始资料、收集箱、名称核验、客户调研）时先读本 skill。',
    version: 1,
    text: ENGRAM_SKILL,
  },
  {
    name: CUSTOMER_RESEARCH_SKILL_NAME,
    title: '客户调研入口',
    description: '客户调研入口（engram research begin/submit）',
    whenToUse: '用户要求调研客户、分析目标公司、客户背景调查或生成客户洞察报告时。',
    version: 1,
    text: CUSTOMER_RESEARCH_SKILL,
  },
];

/** 按名取要安装的 skill（未知名称返回 undefined） */
export function findInstalledSkill(name: string): InstalledSkill | undefined {
  return INSTALLED_SKILLS.find((skill) => skill.name === name);
}