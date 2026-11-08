/**
 * engram CLI 命令清单——设置 → Agent 与自动化 →「外部接入」「工具与手册」的数据源。
 * 与 docs/AGENT-CLI-SKILL.md 第 3 节的命令面一一对应；命令增删时两处同步，
 * 避免设置页说明与实际能力脱节（MCP 已下线，Agent 只经 engram 命令读写知识库）。
 */

export interface CliCommandDoc {
  /** 完整命令（不含 engram 前缀），与 --help 的写法一致 */
  command: string;
  /** 读命令不改动知识库；写命令带门禁并自动记入操作日志；系统命令管连接 / 说明 / 交互 */
  group: '读' | '写' | '系统';
  /** 一句话功能 */
  summary: string;
  /** 使用要点与限制 */
  notes: string;
}

/** 分组顺序即「工具与手册」页面上的顺序：先读、再写、最后连接与说明 */
export const CLI_GROUPS: ReadonlyArray<{ group: CliCommandDoc['group']; label: string }> = [
  { group: '读', label: '读命令（不改动知识库）' },
  { group: '写', label: '写命令（带门禁与操作日志）' },
  { group: '系统', label: '系统命令（连接、指南与提问）' },
];

/** 全局选项：所有命令通用（来自契约第 3 节） */
export const CLI_GLOBAL_OPTIONS: string[] = [
  '--json：机器可读的 JSON 输出（不带时是人类可读文本）',
  '--url / --token / --allow-private：本次调用的临时连接，不写入连接配置',
];

/** 出错约定：stderr 打原因，退出码非 0 */
export const CLI_EXIT_NOTE = '出错时 stderr 打原因、退出码非 0（2 = 用法 / 配置错误，1 = 服务端拒绝或失败）';

export const CLI_COMMANDS: CliCommandDoc[] = [
  /* ---------- 读：只读知识库 ---------- */
  {
    command: 'search <query> [--limit N]',
    group: '读',
    summary: '关键词检索知识库：Wiki 页面 + 原始资料提取文本，返回命中片段与出处。',
    notes: '默认 8 条（范围 1–30）；无命中时明确返回「（无结果）」。',
  },
  {
    command: 'pages list [--outdated] [--tag T] [--path P]',
    group: '读',
    summary: '列出知识库目录树，每个页面附带提炼规则版本，便于发现需按新规则重提炼的页面。',
    notes: '三种过滤可叠加（只列落后页面 / 按标签 / 按路径前缀）；过滤后为空的目录自动裁剪。',
  },
  {
    command: 'pages read <ref>',
    group: '读',
    summary: '按标题或页面 ID 读取页面全文（markdown），同时给出路径、类型与标签。',
    notes: '标题匹配忽略大小写；页面不存在或文件缺失时返回明确提示。',
  },
  {
    command: 'pages related <ref>',
    group: '读',
    summary: '读取页面的图谱关联：相邻页面（入链 / 出链）与实体关系。',
    notes: '写「相关页面」章节、校验 [[双链]] 目标、发现反向引用前先看它；无关联时明确说明。',
  },
  {
    command: 'pages evidence <ref>',
    group: '读',
    summary: '读取概念 / 实体页的证据账本：来源路径、来源版本、事实与逐字引文。',
    notes: '写页前先读这里，避免重复或冲突证据；非概念 / 实体页返回「无证据账本」。',
  },
  {
    command: 'pages asset <ref> [--out F]',
    group: '读',
    summary: '读取页面 / 资料正文里引用的图片原图（正文中的 /media/<父项id>/<文件名>）。',
    notes: '默认落到临时文件并打印路径（--json 含 path / mimeType），再用自己的图片读取工具看；图片是 md 父项的私有资产，没有全局清单。',
  },
  {
    command: 'files list [--pending] [--dir D]',
    group: '读',
    summary: '列出 原始资料/ 全部文件，含提取状态与「已提炼」标记，是提炼作业的索引入口。',
    notes: '--pending 只列尚未提炼的文件；一个大目录可用 --dir 分批读。',
  },
  {
    command: 'files read <path> [--out F]',
    group: '读',
    summary: '读取一份原始资料的提取文本（md 直接返回正文）。',
    notes: '尚无提取文本时会提示改用 files raw；--out 把文本写入指定文件。',
  },
  {
    command: 'files raw <path> [--out F]',
    group: '读',
    summary: '取一份原始资料的原件字节（图片 / PDF 等二进制用它）。',
    notes: '图片 / 二进制必须给 --out：文件落盘后用自己的图片工具看，不依赖工具返回图像内容。',
  },
  {
    command: 'inbox list [--status all|pending|converted|adopted] [--limit N]',
    group: '读',
    summary: '列出收集箱（收集箱/）里用户拖进来的待整理原件：大小、类型、是否已有转换产物。',
    notes: '收集箱不属于知识库：这里的内容不得作为回答依据、不得进 evidence；入库后才成为可引用来源。',
  },
  {
    command: 'inbox read <path> [--out F]',
    group: '读',
    summary: '读取收集箱里的一份原件内容（供按语义改写成 Markdown）：文本直出、Office 给文字层、图片落文件。',
    notes: '只允许 收集箱/ 下的路径；压缩包等取不到文字层的格式改用 inbox raw 自行处理。',
  },
  {
    command: 'inbox raw <path> --out F',
    group: '读',
    summary: '取收集箱里一份原件的原始字节（图片等二进制）。',
    notes: '必须给 --out；落盘后用图片工具看，不要指望文本通道。',
  },
  {
    command: 'names list [--status pending|open|unresolved|all]',
    group: '读',
    summary: '读取公司全名核验清单：已登记还没回填答复、等回填、已办结（含「最终不是全名」的条目）。',
    notes: '换一轮作业先读这里；收尾用 --status unresolved 把仍未定全名的条目列给用户。',
  },
  {
    command: 'names audit',
    group: '读',
    summary: '全库公司页名称盘点：列出公司类实体页（客户 / 组织）里标题不是工商全名形态的页面及核验状态。',
    notes: '批量核验前看有哪些公司页没核验过；只按标题形态筛，不代替企查查 / 天眼查的实际核验。',
  },

  /* ---------- 写：改动知识库（带门禁与日志） ---------- */
  {
    command: 'pages write <path> --title T [--type] [--tags a,b] [--evidence "<路径>::<引文>"]... [--file F|-]',
    group: '写',
    summary: '创建或覆盖知识库页面；保存后自动建索引、建图谱边并记入操作日志。',
    notes: '只能写 Wiki/ 下，原始资料与 AIWorks 对 Agent 是只读区。新建概念 / 实体页必须带 evidence（≥2 个不同原始资料路径各 1 条逐字引文，或单一来源 ≥2 条），引文由服务端逐字校验；已有页面增量更新不受限。正文可用 --file 或 stdin（-）。',
  },
  {
    command: 'pages rename <ref> --title T',
    group: '写',
    summary: '重命名页面：文件随标题移动、正文 H1 同步，并把其他页面引用的 [[旧标题]] 双链重定向到新标题。',
    notes: '保持页面 ID 与图谱边不断；只能操作 Wiki/ 页面，操作记入日志。',
  },
  {
    command: 'pages move <ref> [--dir Wiki/实体] [--title T]',
    group: '写',
    summary: '把页面移动到 Wiki/ 树内的目标目录，可顺带改标题，保持页面 ID 与图谱边。',
    notes: '顺带改标题不重定向引用双链——需要重定向请用 pages rename。',
  },
  {
    command: 'pages delete <ref> [--reason R]',
    group: '写',
    summary: '把单个页面移入回收站（软删除、可恢复），可在 设置 → 知识库数据 → 回收站 还原。',
    notes: '只能删 Wiki/ 页面；原始资料/ 与 AIWorks/ 是只读区，拒绝删除；不提供永久删除或清空回收站能力。',
  },
  {
    command: 'files add <path> [--file F|-]',
    group: '写',
    summary: '新建一份原始资料 Markdown（调研成果用 原始资料/文档/，随口记的零散内容用 原始资料/灵感碎片/）。',
    notes: '仅在用户明确要求保存时调用；只新建、不覆盖已有文件；正文走 --file 或 stdin，不写 YAML frontmatter 和一级标题。',
  },
  {
    command: 'inbox add <path> [--file F|-]',
    group: '写',
    summary: '往收集箱新建一份文本原件（如把一段内容先放着等用户整理）；只写收集箱，不建页面、不进检索。',
    notes: '只收文本类扩展名；不覆盖已有文件、不写 收集箱/转换结果/；正式入库仍由用户在收集箱界面确认。',
  },
  {
    command: 'inbox write <path> [--file F|-] [--title T] [--note N]',
    group: '写',
    summary: '把收集箱原件的语义转换结果写成 Markdown（文件名按转换日期 + 核心内容生成）。',
    notes: '产物仍留在收集箱：不建页面、不写检索索引、不触发入库；同一原件只保留最新一份产物。',
  },
  {
    command: 'inbox convert <path>',
    group: '写',
    summary: '用服务端管道稳定分块转换收集箱原件（大表格 / 长文档优先，可能耗时数分钟）。',
    notes: '产物仍在收集箱，入库由用户界面确认；图片 / 音视频等 Agent-only 格式会被拒绝，改用 inbox read / raw 自行处理。',
  },
  {
    command: 'chat save [--identifier I] [--project P] [--append] [--file F|-]',
    group: '写',
    summary: '把一段与外部 Agent 的对话沉积到 原始资料/对话/（按时间 + 标识命名，可按项目归子目录）。',
    notes: '须用户明确指示才可执行，不得自行判断「这段有价值」就沉淀；已沉淀的对话属原始资料，可被后续提炼引用。',
  },
  {
    command: 'names check <名称> [--page R] [--note N]',
    group: '写',
    summary: '公司全名核验（登记待核名称）：名称不是工商全名、资料库里也查不到时登记，随即在对话里问用户是否允许联网查企查查 / 天眼查。',
    notes: '全库唯一允许问用户的事。服务端先自查资料库（页面标题 / 证据账本 / 原始资料），查到全名就直接返回；带「待核实 / 候选」标记的写法只算疑似候选，仍会登记。同一名称只登记一次。',
  },
  {
    command: 'names propose <id> [--full-name F] [--source S] [--note N]',
    group: '写',
    summary: '回填联网查到的工商全名，再问用户是否改用全名（同意后由服务端改名）。',
    notes: '前置：该核验已被用户允许联网查询。全名的界定是企查查等能否查到；查不到就不传 full-name，按「未找到全名」办结，不得编造或推测。',
  },
  {
    command: 'names answer <id> --allow|--deny [--note N]',
    group: '写',
    summary: '回填用户在对话里给出的核验答复：允许联网查询，或同意改用全名（同意即由服务端改名）。',
    notes: '前置是在对话里问过用户；不要替用户决定。allow 在查询许可阶段 = 去联网查，在改名阶段 = 立刻改名（保持页面 ID、双链重定向、记日志）。',
  },
  {
    command: 'research begin --customer C [--scope knowledge-web|knowledge-only] [--save] [--save-mode new|overwrite] [--overwrite-path P] [--client X] [--timezone TZ]',
    group: '写',
    summary: '客户调研统一入口：建立任务，读取最新流程、主体核验契约、报告模式与该客户已有报告。',
    notes: '内置与外部 Agent 共用。第一步永远核验客户主体：公开工商与知识库都查不到时必须质疑客户是否存在，只出主体核验结论，不写分析。existingReports 非空且用户要求保存时，先问用户「新版本还是覆盖」再带 save-mode。',
  },
  {
    command: 'research submit --task <taskId> [--file F|-]',
    group: '写',
    summary: '提交调研报告 JSON：先校验主体核验，再按证据量落完整报告 / 资料不足简报 / 主体核验短报告。',
    notes: '报告 JSON 含 identity / sections / sources / save / saveMode / overwritePath 等字段。完整报告自动入库；资料不足简报只留在客户洞察页、不自动导入；主体核验不保存。完整报告须 verified 且外部来源 ≥2。',
  },

  /* ---------- 系统：连接、指南与交互 ---------- */
  {
    command: 'login --url <url> --token <token>',
    group: '系统',
    summary: '远程连接登记：把服务端地址与 Agent 令牌写进连接配置（默认 ~/.engram/config.json）。',
    notes: '本机服务启动时已自动登记本机连接；远程客户端下载 cli.js 后先 login 再使用其它命令。也可以用全局 --url / --token 做一次性调用。',
  },
  {
    command: 'status',
    group: '系统',
    summary: '健康 + 连接 + 计数：一次看清 CLI 连的是哪个知识库、服务是否可用。',
    notes: '接好之后先跑它确认链路；--json 输出结构化结果，便于脚本判断。',
  },
  {
    command: 'config show',
    group: '系统',
    summary: '显示当前连接配置（Token 脱敏）。',
    notes: '排查「连错地址 / 用了哪个令牌」时先看它；不会打印明文 Token。',
  },
  {
    command: 'guide',
    group: '系统',
    summary: '下发《Engram 知识库 Agent 作业指南》全文：知识库结构、八阶段提炼流程、页面契约与证据门禁规则。',
    notes: '提炼作业开工前先取一次，按指南执行八阶段流程；作业方法论都以它为准。',
  },
  {
    command: 'skill list',
    group: '系统',
    summary: '列出服务端内置的作业 skill 元数据（名称 / 用途 / 何时用 / 版本），不含正文。',
    notes: 'skill 与《Agent 作业指南》同级但按需获取：先看清单，需要时再用 skill show 取全文。',
  },
  {
    command: 'skill show <name>',
    group: '系统',
    summary: '按名读取一份内置 skill 的全文（作业手法与纪律）。',
    notes: '正文是命令输出，无需访问软件安装目录；名称不存在时会返回可用清单。',
  },
  {
    command: "ask --data '<json>' [--timeout-ms N]",
    group: '系统',
    summary: '内置 Agent 在 Engram 对话里弹选项并阻塞等待用户点选，答复后同一轮继续。',
    notes: '只问只有用户能定的事（既定场景是公司工商全名核验）；外部 Agent 请用自带提问能力问在自己的对话里。没有正在跑的 Engram 对话时立刻失败并给出原因。',
  },
];

/** 按分组摊平命令（保持 CLI_COMMANDS 内的书写顺序） */
export function groupedCliCommands(): Array<{ label: string; items: CliCommandDoc[] }> {
  return CLI_GROUPS.map(({ group, label }) => ({
    label,
    items: CLI_COMMANDS.filter((item) => item.group === group),
  }));
}

/** 页面上展示的完整命令：统一带 engram 前缀 */
export function formatCliCommand(command: string): string {
  return `engram ${command}`;
}
