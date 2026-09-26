/**
 * 常驻问题（空会话推荐项）的作业手册。
 *
 * 推荐问题在界面上只是按钮文案，点下去就是一条普通用户消息。内置 Agent 要答得稳，得先知道
 * 「今天几号、下周是哪几天、去知识库的哪儿翻、按什么格式回」——这些随任务文本一起送进会话
 * （见 prompts.buildTask），不写进系统提示、也不进常驻约定：只有命中该问题才多花这几个 token。
 *
 * 界面文案与命中判定分开维护：文案在 web/src/lib/chatSuggestions.ts（同源提示写在那边），
 * 这里按关键词认问题，用户自己换个问法（「下周有什么活要干」）照样命中。
 */

/** 界面上的常驻推荐项原文（与 web/src/lib/chatSuggestions.ts 保持一致） */
export const WEEKLY_TASKS_QUESTION = '下周的工作任务有哪些';

/** 一句话问「下周」的信号词 */
const NEXT_WEEK = /(下周|下一周|下星期|下个星期|下礼拜|下个礼拜)/;
/** 「干活」的信号词：光有下周不一定是问任务（也可能是问天气式的闲聊或别的资料） */
const WORK_WORD = /(工作|任务|活|安排|计划|重点|事情|干什么|做什么|要干|要做|忙什么)/;
/** 关键词命中的长度上限：粘贴一份长文档顺带提「下周计划」时不要套这份手册 */
const KEYWORD_MATCH_LIMIT = 60;
/** 追问句式（「那下周呢」）单独认：短句里出现下周就是在问这件事 */
const FOLLOW_UP = /^(那|那么|然后|再)?(下周|下一周|下星期|下礼拜)呢?$/;

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 当地零点：跨时区/夏令时都按自然日算，不用 UTC 加减 */
function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

function addDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
}

/** 2026-09-26（周六） */
function formatDay(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}（${WEEKDAYS[at.getDay()]}）`;
}

/**
 * 「下周」的时间窗：下周一零点到下一个周日。
 *
 * 按自然周（周一至周日）算，不按「今天 + 7 天」：周六周日问同一件事都该是同一周，
 * 周一问也是下一周（不是本周剩下的六天）。
 */
export function nextWeekRange(at: Date): { start: Date; end: Date } {
  const today = startOfDay(at);
  const day = today.getDay(); // 0 = 周日
  const toNextMonday = (8 - day) % 7 || 7;
  const start = addDays(today, toNextMonday);
  return { start, end: addDays(start, 6) };
}

export interface Playbook {
  /** 稳定标识（测试与排障用） */
  id: string;
  /** 命中判定：自己按需要的信号词认，拿到的原文不做规范化 */
  match: (message: string) => boolean;
  /** 生成随任务下发的作业手册文本 */
  build: (now: Date) => string;
}

/** 认定「这条消息就是在问下周要干的活」 */
export function isWeeklyTasksQuestion(message: string): boolean {
  const text = String(message || '').replace(/\s+/g, '');
  if (!text) return false;
  if (FOLLOW_UP.test(text)) return true;
  if (text.length > KEYWORD_MATCH_LIMIT) return false;
  return NEXT_WEEK.test(text) && WORK_WORD.test(text);
}

/** 时间窗抬头（两份手册共用：同一个「下周」口径） */
function taskWindowLines(now: Date): string[] {
  const { start, end } = nextWeekRange(now);
  return [`今天是 ${formatDay(startOfDay(now))}；「下周」= ${formatDay(start)} 至 ${formatDay(end)}。`];
}

/**
 * 翻库次序与收录口径：常驻问题与任务看板共用。
 * 两份手册必须用同一套取数口径——同一个问题在聊天里和看板里给出不同的活就砸了。
 */
function taskScanSteps(): string[] {
  return [
    '1. 先看最近的原始资料（list_raw_files；文件名以 `YYYY.MM.DD_` 开头，按名字就能看出时间先后，重点最近 3-4 周）：日课三条复盘、双周工作复盘、专题会与客户会见纪要里的「待办事项」、行程安排、行动计划、SP/BP。',
    '2. 再用 search 搜「待办」「下周」「本周内」「下一步」「跟进」「截止」「安排」等词，把有明确时间点或明确在办的片段捞全。',
    '3. 读相关实体页的时间线（Wiki/实体/ 里的客户、区域、团队页常写明「拟下周…」「已约定…」这类下一步安排）。',
    '4. 收进清单的只限三类：①时间明确落在下周窗口内的事；②按资料写的周期一定会发生的例行事项（周会、周报、周重点提交、月度碰头等，用周期推算到下周）；③资料里写明「未完成 / 停滞 / 待推进」但没有新时间的——这类单独成节，不要假装它就在下周。',
  ];
}

/** 下周工作任务：作业手册（今天 + 时间窗 + 翻库次序 + 收口格式） */
function weeklyTasksPlaybook(now: Date): string {
  return [
    '【常驻问题：下周的工作任务有哪些】',
    ...taskWindowLines(now),
    '按下面的次序从知识库里提炼，只写读到的内容，不要凭印象补：',
    ...taskScanSteps(),
    '5. 输出：先用一句话概览（几条、集中在哪）；再分「客户与项目」「团队与例行」「时间待定或逾期」三节，每条写成 `- [ ] 事项 —— 责任人/时间（依据：原始资料/xxx.md 或《页面标题》）`；最后写「资料缺口」：哪些环节库里没有记录、要你自己补。',
    '6. 每条都要能指回原文，指不回去的不要列；没有依据就直说库里没写，不要编。',
  ].join('\n');
}

/** 任务看板：界面按显式 id 指定（同一个问题在聊天里走常驻手册，看板走这份带机器可读清单的） */
export const TASK_BOARD_PLAYBOOK = 'task-board';

/** 看板渲染要的机器可读清单：字段名与 web/src/lib/taskBoard.ts 的解析器一一对应 */
function boardJsonLines(): string[] {
  return [
    '6. 正文之后必须再给一个 ```json 代码块（界面用它渲染看板：按天排、按人物/客户/端组筛、逾期单独一列，字段名逐字照抄，不要改名、不要加注释）：',
    '```json',
    '{"version":2,"summary":"一句话概览","groups":[{"title":"客户与项目","cards":[{"text":"事项","owner":"责任人","when":"材料里的时间写法","date":"2026-09-30","kind":"fixed","repeat":"","customer":"锐洁","team":"北京组","source":"原始资料/xxx.md 或《页面标题》"}]},{"title":"团队与例行","cards":[]},{"title":"时间待定或逾期","cards":[]}],"gaps":["资料缺口"]}',
    '```',
    '   规则：version 固定 2；groups 就这三节、title 逐字用「客户与项目」「团队与例行」「时间待定或逾期」（没有内容就给空数组）；每张卡只写一件事，text 一句话说清做什么。',
    '   - date：具体要做这件事的那一天，`YYYY-MM-DD`（「9/30 前」就填 2026-09-30，把截止日当那天；「本周五」按上面的今天推算）。date 已经过去的照样填（界面会把它们归到「已逾期」），过去多久看得出来。',
    '   - kind：fixed＝有明确日期；periodic＝周期性事项（日课三条、每周一交周重点、每月碰头），date 填下一次发生的那天，repeat 写周期（如「每日」「每周一」「每月」）；undated＝实在没有日期（date 与 repeat 都留空）。',
    '   - 「逾期」不等于「没日期」：资料里写明「未完成 / 停滞 / 待推进 / 未闭环」的，只要材料给了时间（哪怕已经过去）就照填 date——界面会把它们归到「已逾期」，那正是要优先补的；真的只有月份或没有任何时间，才留空（落「时间待定」）。',
    '   - customer：客户名，用材料里的写法（如「锐洁」「京东乾石」）；内部工作、团队例行留空。',
    '   - team：端组，只能填「北京组」「天津组」「大区」（材料看不出或全大区的事情填「大区」）。',
    '   - owner / when / source 拿不到就写空串；source 必须能在你读到的原文里指出来；gaps 写库里没记录、要用户自己补的缺口。',
    '   每节最多 8 张卡（看板要一眼扫得完）：超出就按「时间明确 > 影响大」挑，同类的合并成一张（如「其余中风险客户推进」），不要为了凑数把细碎条目塞满一列。',
  ];
}

/** 任务看板：作业手册（取数口径与常驻问题共用，只多一段机器可读清单的约定） */
function taskBoardPlaybook(now: Date): string {
  return [
    '【任务看板：下周的工作任务】',
    ...taskWindowLines(now),
    '按下面的次序从知识库里提炼，只写读到的内容，不要凭印象补：',
    ...taskScanSteps(),
    '5. 正文照常写成给人看的三节（客户与项目 / 团队与例行 / 时间待定或逾期），每条注明依据。',
    ...boardJsonLines(),
    '7. 每条都要能指回原文，指不回去的不要列；没有依据就直说库里没写，不要编。',
  ].join('\n');
}

/** 常驻问题注册表：顺序即匹配顺序（一条消息只套第一份命中的手册） */
export const PLAYBOOKS: Playbook[] = [
  { id: 'weekly-tasks', match: isWeeklyTasksQuestion, build: weeklyTasksPlaybook },
];

/** 梦境思考：定时后台作业（不是常驻问题，由调度器显式指定 id） */
export const DREAM_PLAYBOOK = 'dream-cycle';

/**
 * 梦境思考的作业手册：一轮里做两件事——把没提炼的资料提炼掉，再做一次全库纠错。
 *
 * 与聊天里的手册不同，这份是**无人值守**的：没有用户在场，所以明确禁止 ask_user
 * （问了只会白等到超时），公司全名核验改成登记后留给用户下次答复。
 * 待办信号由任务正文带进来（见 dreamCycle.buildDreamMessage），这里只写做法与收口口径。
 */
function dreamCyclePlaybook(now: Date): string {
  return [
    '【梦境思考：自动整理 + 纠错（无人值守后台作业）】',
    `今天是 ${formatDay(startOfDay(now))}。这一轮由 Engram 按计划自动发起，用户不在场；请自己做完，不要停下来等待提问。`,
    '',
    '一、提炼未整理的原始资料（逐份串行）',
    '1. 待提炼清单：`list_raw_files` 传 `pending=true`（返回里没标「已提炼」的就是要整理的）。任务末尾的「本轮待办信号」已给出一份样例，以清单工具的实时结果为准。',
    '2. 一次只处理一份：读一份（`read_raw_file`；图片或无文字层的扫描件传 `raw=true` 自己识别）→ 按 `kb_guide` 的作业流程与页面契约提炼 → `write_page` 提交成功后，再读下一份。不要批量读完统一写页。',
    '3. 提取状态还没完成的文件先跳过（服务端会自动提取，下一轮再处理）；单份失败记下原因继续下一份，不要卡住整批。',
    '4. 证据引文必须逐字来自原文；新建概念/实体页遵守两来源门禁；已有页面增量更新不受限；资料里查不到又必须有说法的，按证据取最可信的写法并在正文标注「待核实」，不要编造。',
    '',
    '二、全库纠错（这一轮做一次）',
    '5. 按任务末尾的待办信号逐类核查，需要时自己用 `list_pages` / `search` / `related_pages` / `page_evidence` 再查一遍：',
    '   - 死链：`[[双链]]` 指向的标题没有页面。该建页的按契约建页；写错标题的改成正确标题；拿不准的不要硬建。',
    '   - 疑似重复：标题撞名的页面组（信号里给出路径）。读原文确认是不是同一个对象：是就合并——把内容并进保留页、`write_page` 覆盖，再用 `delete_page` 把多余页移入回收站（只软删除）；不是就在页面里写清区分口径。',
    '   - 规则落后：`guide_version` 低于当前《Agent 作业指南》的概念/实体页，按最新契约重写（用户手写章节永远保留）。',
    '   - 页面契约：实体页固定 `## 当前理解 / ## 相关页面 / ## 时间线`，概念页 `概述 / 核心要点 / 实践应用`；`[[双链]]` 只指已有或本次新建的页面；标题口径按指南（公司类实体用工商全名，查不到就标注「全称待确认」）。',
    '6. 只做有据可依的修改；拿不准的把依据与候选写进相关页面的「待核实」，不要为了「修完」而硬改或删页。',
    '7. 无人值守：不要用 `mcp__engram__ask_user` 提问（用户不在，提问只会白等到超时）。公司全名核验照常 `entity_name_check` 登记，等用户下次在对话里答复；其余按证据自己定并标注「待核实」。',
    '',
    '三、收尾',
    '8. 一轮时间有限（通常 10~30 分钟）：按「先做最该做的」排序，做不完的把剩余清单写进小结。',
    '9. 最后一段正文写成给用户看的小结（不要复述逐条日志、不要贴工具输出）：本次处理了几份资料、新建/更新了哪些页面、纠错改了什么、哪些遗留要用户自己补。写短，一眼看完。',
  ].join('\n');
}

/** 按 id 取手册（界面/调度器显式指定：任务看板、梦境思考都不靠关键词命中）；未知 id 返回 null */
export function findPlaybookById(id?: string): Playbook | null {
  const key = String(id || '').trim();
  if (key === TASK_BOARD_PLAYBOOK) {
    return { id: key, match: () => false, build: taskBoardPlaybook };
  }
  if (key === DREAM_PLAYBOOK) {
    return { id: key, match: () => false, build: dreamCyclePlaybook };
  }
  return PLAYBOOKS.find((playbook) => playbook.id === key) ?? null;
}

/** 命中当前消息的作业手册；没有命中返回 null */
export function findPlaybook(message: string): Playbook | null {
  return PLAYBOOKS.find((playbook) => playbook.match(message)) ?? null;
}
