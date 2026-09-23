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
    name: 'list_entity_names',
    group: '读',
    summary: '读取公司全名核验清单：已登记还没回填答复、等 Agent 回填、已办结（含「最终不是全名」的条目）。',
    params: 'status pending（还没回填答复）/ open（未办结）/ unresolved（最终不是全名）/ all（默认）。',
    notes: '换一轮作业先读这里；作业收尾用 status=unresolved 把仍未定全名的条目列给用户。',
    cli: 'engram names list [--status unresolved]',
  },
  {
    name: 'entity_name_audit',
    group: '读',
    summary: '全库公司页名称盘点：列出公司类实体页（客户/组织）里标题不是工商全名形态的页面及各自核验状态。',
    params: '无参数。',
    notes: '批量核验前看有哪些公司页没核验过；只按标题形态筛，不代替企查查/天眼查的实际核验。',
    cli: 'engram names audit',
  },
  {
    name: 'read_page_asset',
    group: '读',
    summary: '读取页面/资料正文里引用的图片原图（正文中的 `/media/<父项id>/<文件名>` 引用），图片以 image 内容返回供视觉识别。',
    params: 'path 正文里的图片引用，如 /media/<父项id>/xxx.png；也接受 assets/<父项id>/xxx.png。',
    notes: '图片是 md 父项的私有资产、没有全局清单：先 read_page 拿到正文里的引用，再把引用原样传进来。SVG 不作为图像内容下发。',
    cli: '（CLI 未提供）',
  },
  {
    name: 'list_inbox',
    group: '读',
    summary: '列出收集箱（收集箱/）里用户拖进来的待整理原件：大小、类型、是否已有转换产物与本机转换状态。',
    params: 'status all/pending/converted（可选，默认 all）；limit 最多返回条数（可选，默认 200）。',
    notes: '收集箱不属于知识库：这里的内容不得作为回答依据、不得进 evidence；入库后才成为可引用来源。',
    cli: '（CLI 未提供）',
  },
  {
    name: 'read_inbox_item',
    group: '读',
    summary: '读取收集箱里的一份原件内容（供按语义改写成 Markdown）：文本直出、图片以 image 内容返回、PDF/Office 给文字层。',
    params: 'path 收集箱内的相对路径（必填，如 收集箱/合同.pdf）；raw 取原文件（可选）。',
    notes: '只允许 收集箱/ 下的路径；压缩包等取不到文字层的格式会提示改用 raw=true 自行处理。',
    cli: '（CLI 未提供）',
  },
  {
    name: 'write_inbox_markdown',
    group: '写',
    summary: '把一份收集箱原件的语义转换结果写成 Markdown，落到 收集箱/转换结果/<原名>.md。',
    params: 'path 原件路径（必填）；markdown 转换后的完整正文（必填）；note 本次转换的补充说明（可选）。',
    notes: '作业规范先用 skill_guide("inbox-semantic-to-md") 取；产物仍留在收集箱（不建页面、不写检索索引、不触发入库），入库由用户在界面上确认。',
    cli: '（CLI 未提供）',
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
    name: 'entity_name_check',
    group: '写',
    summary: '公司全名核验（登记待核名称）：公司名称不是工商全名、资料库里也查不到时登记，随即在对话里问用户是否允许联网查企查查/天眼查——全库唯一允许问用户的事。',
    params: 'entity 材料里的名称写法（必填，通常是简称）；titleOrId 关联页面（可选，用户同意改用全名时据此自动改名）；note 说明（可选）。',
    notes: '服务端先自查资料库：页面标题 / 证据账本 / 原始资料提取文本、以及正文里写明全名的提法，都算已有全名，直接返回即可用 rename_page 改名，不问用户；正文里带「待核实/候选」标记的写法只作「疑似候选（未核实）」回给你，仍会登记这一问。返回文本会告诉你问法：内置 Agent 用 ask_user 弹底部选项，外部 Agent 用自带提问能力；答复用 entity_name_answer 回填。同一名称只登记一次。',
    cli: 'engram names check <名称> [--page <titleOrId>] [--note <说明>]',
  },
  {
    name: 'entity_name_answer',
    group: '写',
    summary: '回填用户在对话里给出的核验答复（allow/deny）：允许联网查询，或同意改用全名（同意即由服务端改名）。',
    params: 'id 核验 id（必填）；decision allow（同意）/ deny（不同意）；note 用户原话或补充（可选）。',
    notes: '前置是在对话里问过用户（内置 Agent 用 ask_user，外部 Agent 用自带提问能力）；不要替用户决定。allow 在查询许可阶段=去联网查、在改名阶段=服务端立刻改名（保持页面 ID、双链重定向、记日志）。',
    cli: 'engram names answer <核验id> --allow|--deny [--note <说明>]',
  },
  {
    name: 'ask_user',
    group: '写',
    summary: '在 Engram 对话里向用户提问并等他点选（仅内置 Agent）：问题弹在对话最下侧的选项框，用户点选后工具当场返回答复，Agent 同一轮继续。',
    params: 'questions 数组（1-5 个，每项 question 必填，可选 header / options[{label, description}] / multiSelect）；timeoutMs 等待上限（默认 10 分钟）。',
    notes: '只问只有用户能定的事（既定场景是公司工商全名核验）；外部 Agent 不要用（它等的是 Engram 界面），请用自带提问能力问在自己的对话里。没有正在跑的 Engram 对话时会立刻失败，那时把问题写进回复正文。',
    cli: '（CLI 未提供：提问是内置 Agent 在对话里的交互）',
  },
  {
    name: 'entity_name_propose',
    group: '写',
    summary: '回填联网查到的工商全名，然后在对话里问用户是否改用全名；用户同意后由服务端执行改名（保持页面 ID、双链重定向、自动记日志）。',
    params: 'id 核验 id（必填）；fullName 查到的工商登记全名（查不到就不传）；source 出处（企查查/天眼查 链接或说明）；note 补充说明。',
    notes: '前置：该核验已被用户允许联网查询。全名的界定是企查查等能否查到该名称，不得编造或推测；查到的是简称就继续查全称，查不到按「未找到全名」办结。',
    cli: 'engram names propose <核验id> [--full-name <全名>] [--source <出处>]',
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
    notes: '须用户明确指示才可调用，不得自行判断"这段有价值"就沉淀；已沉淀的对话属原始资料，可被后续提炼作业引用。',
    cli: 'engram chat save [--identifier <标识>] [--project <项目>] [--append]（正文走 stdin）',
  },
];

/** 读 / 写分组（保持 MCP_TOOLS 内的书写顺序） */
export function groupedMcpTools(): Array<{ label: string; items: McpToolDoc[] }> {
  return [
    { label: '读工具（不改动知识库）', items: MCP_TOOLS.filter((t) => t.group === '读') },
    { label: '写工具（带门禁与操作日志）', items: MCP_TOOLS.filter((t) => t.group === '写') },
  ];
}
