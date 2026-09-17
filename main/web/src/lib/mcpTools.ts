/**
 * MCP 工具清单——设置 → Agent 接入 → 查看工具 的数据源。
 * 与 server/src/mcp/server.ts 中 server.tool(...) 的注册项一一对应；
 * 新增/改名工具时两处同步，避免界面说明与实际能力脱节。
 */

export interface McpToolDoc {
  /** 工具名（模型侧完整名称 mcp__engram__<name>） */
  name: string;
  /** 读工具不改动知识库；写工具带门禁并自动记入操作日志 */
  group: '读' | '写';
  /** 一句话功能 */
  summary: string;
  /** 参数说明 */
  params: string;
  /** 使用要点与限制 */
  notes: string;
  /** CLI（engram）等价命令 */
  cli: string;
}

export const MCP_TOOLS: McpToolDoc[] = [
  {
    name: 'search',
    group: '读',
    summary: '关键词检索知识库：Wiki 页面 + 原始资料提取文本，返回命中片段与出处。',
    params: 'query 检索词（必填）；limit 返回条数（可选，默认 8，范围 1–30）。',
    notes: '结果形如「[序号] 标题 (类型:路径) + 命中片段」；无命中时明确返回「（无结果）」。',
    cli: 'engram search "<关键词>"',
  },
  {
    name: 'list_pages',
    group: '读',
    summary: '列出知识库目录树，每个页面附带提炼规则版本，便于发现需按新规则重提炼的页面。',
    params: 'outdated 只列规则版本落后于当前指南的概念/实体页（可选）；path 路径前缀过滤（如 Wiki/实体）；tag 按标签精确过滤（可选）。',
    notes: '三种过滤可叠加，过滤后为空的目录自动裁剪；页面显示「规则vN」，落后时标注当前版本。',
    cli: 'engram pages list [--outdated] [--tag <标签>]',
  },
  {
    name: 'read_page',
    group: '读',
    summary: '按标题或页面 ID 读取页面全文（markdown），同时给出路径、类型与标签。',
    params: 'titleOrId 页面标题或页面 ID（必填）。',
    notes: '标题匹配忽略大小写；页面不存在或文件缺失时返回明确提示。',
    cli: 'engram pages read <标题|ID>',
  },
  {
    name: 'page_evidence',
    group: '读',
    summary: '读取概念/实体页的证据账本：来源路径、来源版本、事实与逐字引文。',
    params: 'titleOrId 页面标题或页面 ID（必填）。',
    notes: '写页前先读这里，避免重复或冲突证据；非概念/实体页返回「无证据账本」。',
    cli: 'engram pages evidence <标题|ID>',
  },
  {
    name: 'related_pages',
    group: '读',
    summary: '读取页面的图谱关联：相邻页面（入链/出链）与实体关系，用于写「相关页面」章节、校验 [[双链]] 目标、发现反向引用。',
    params: 'titleOrId 页面标题或页面 ID（必填）。',
    notes: '返回 JSON（neighbors + entities）；无关联时明确说明。',
    cli: '（CLI 未提供，可用 REST /api/pages/<id>/related）',
  },
  {
    name: 'list_raw_files',
    group: '读',
    summary: '列出 原始资料/ 全部文件，含提取状态与「已提炼」标记，是提炼作业的索引入口。',
    params: 'pending 只返回尚未提炼的文件（可选）。',
    notes: '单次最多 500 条，按目录分批读取；图片与无文字层文件需再用 read_raw_file 取原文件自行识别。',
    cli: 'engram files list [--pending]',
  },
  {
    name: 'read_raw_file',
    group: '读',
    summary: '读取一份原始资料：默认返回提取文本（md 直接返回正文），raw=true 返回原文件。',
    params: 'path 原始资料路径（必填，须在 原始资料/ 下）；raw 取原文件（可选）。',
    notes: '图片以 MCP image 内容返回，模型可直接视觉识别；PDF 等以 base64 返回；尚无提取文本时提示改用 raw=true。',
    cli: 'engram files read <路径> [--raw]',
  },
  {
    name: 'kb_guide',
    group: '读',
    summary: '下发《Engram 知识库 Agent 作业指南》全文：知识库结构、八阶段提炼流程、页面契约与证据门禁规则。',
    params: '无参数。',
    notes: '提炼作业开工前先取一次，按指南执行八阶段流程。',
    cli: 'engram guide',
  },
  {
    name: 'skill_list',
    group: '读',
    summary: '列出服务端内置的作业 skill 元数据（名称 / 用途 / 何时用 / 版本），不含正文。',
    params: '无参数。',
    notes: 'skill 与《Agent 作业指南》同级但按需获取：先看清单，需要时再用 skill_guide 取全文；skill 版本独立于指南版本，改 skill 不会把已有页面标为规则落后。',
    cli: '（CLI 未提供，用 MCP skill_list）',
  },
  {
    name: 'skill_guide',
    group: '读',
    summary: '按名读取一份内置 skill 的全文（作业手法与纪律）。',
    params: 'name skill 名称（必填，如 docx-meeting-to-md；名称见 skill_list）。',
    notes: '读到的正文是工具返回值，无需访问软件安装目录；名称不存在时返回可用清单。',
    cli: '（CLI 未提供，用 MCP skill_guide）',
  },
  {
    name: 'write_page',
    group: '写',
    summary: '创建或覆盖知识库页面；保存后自动建索引、建图谱边并记入操作日志。',
    params: 'path 页面路径（必填，如 Wiki/概念/xxx.md）；title 标题（必填）；content markdown 正文（必填）；type 类型（concept/person/customer/org/project/other/note）；tags 标签数组；evidence 证据数组 {path, quote}。',
    notes: '只能写 Wiki/ 下，原始资料与 AIWorks 对 Agent 是只读区。新建概念/实体页必须带 evidence（≥2 个不同原始资料路径各 1 条逐字引文，或单一来源 ≥2 条），引文由服务端逐字校验；已有页面增量更新不受此限。',
    cli: 'engram pages write <路径> --title <标题> [--type concept] [--tags a,b] [--evidence "路径::引文"]',
  },
  {
    name: 'rename_page',
    group: '写',
    summary: '重命名页面：文件随标题移动、正文 H1 同步，并把其他页面引用的 [[旧标题]] 双链重定向到新标题。',
    params: 'titleOrId 标题/ID/路径（必填）；newTitle 新标题（必填）。',
    notes: '保持页面 ID 与图谱边不断；只能操作 Wiki/ 页面，操作记入日志。',
    cli: 'engram pages rename <标题|ID> --title <新标题>',
  },
  {
    name: 'move_page',
    group: '写',
    summary: '把页面移动到 Wiki/ 树内的目标目录，可顺带改标题，保持页面 ID 与图谱边。',
    params: 'titleOrId 标题/ID/路径（必填）；dir 目标目录（可选，如 Wiki/实体）；newTitle 顺带改标题（可选）。',
    notes: '只能操作 Wiki/ 页面；顺带改标题不重定向引用双链——需要重定向请用 rename_page。',
    cli: 'engram pages move <标题|ID> [--dir Wiki/实体] [--title <新标题>]',
  },
  {
    name: 'delete_page',
    group: '写',
    summary: '把单个页面移入回收站（软删除、可恢复），可在 设置 → 存储空间 → 回收站 还原。',
    params: 'titleOrId 标题/ID/路径（必填，标题不唯一时请用 ID 或路径）；reason 删除原因（可选，写入操作日志便于复核）。',
    notes: '只能删 Wiki/ 页面；原始资料/ 与 AIWorks/ 是只读区，拒绝删除；不提供永久删除或清空回收站能力。',
    cli: 'engram pages delete <标题|ID|路径> [--reason <原因>]',
  },
  {
    name: 'save_chat',
    group: '写',
    summary: '把一段与外部 Agent 的对话沉积到 原始资料/对话/，按时间 + 标识命名。',
    params: 'content 对话正文 markdown（必填）；identifier 标识（可选，用于文件名与标题）；project 项目维度（可选，归到子目录）；append 追加合并到当日最近一条（可选）。',
    notes: '须用户明确指示（或先问并得到同意）才可调用，不得自行判断"这段有价值"就沉淀；已沉淀的对话属原始资料，可被后续提炼作业引用。',
    cli: 'engram chat save [--identifier <标识>] [--project <项目>] [--append]（正文走 stdin）',
  },
  {
    name: 'ask_user',
    group: '写',
    summary: '登记一条「待确认问题」给用户：只有用户才知道的信息（公司工商全名、同名主体区分、客户身份口径等）资料里查不到时用。',
    params: 'question 一句话问题（必填）；context 背景与已查到什么（可选）；options 候选答案数组（可选，用户可直接点选）。',
    notes: '问题出现在 Engram 左侧「待确认」并即时提示；能自查的不要问，也不要用它代替征求操作授权；登记后不要空等，下次作业先 list_questions 读答复。',
    cli: 'engram ask --question "..." [--context "..."] [--options "候选1,候选2"]',
  },
  {
    name: 'list_questions',
    group: '读',
    summary: '读取待确认问题与用户答复（默认全部，最新在前）。',
    params: 'status open 只列待答复 / answered 只列已答复 / all 全部（可选，默认 all）。',
    notes: '提问后的下一次作业先读这里再继续；答复属用户提供的口径，写进正文标注「用户确认」，不要为它编造引文。',
    cli: 'engram questions [--status open|answered|all]',
  },
];

/** 读 / 写分组（保持 MCP_TOOLS 内的书写顺序） */
export function groupedMcpTools(): Array<{ label: string; items: McpToolDoc[] }> {
  return [
    { label: '读工具（不改动知识库）', items: MCP_TOOLS.filter((t) => t.group === '读') },
    { label: '写工具（带门禁与操作日志）', items: MCP_TOOLS.filter((t) => t.group === '写') },
  ];
}
