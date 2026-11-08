# Android 本地优先版

Engram Android 端不是远程网页壳。APK 打包与桌面/服务器相同的 Vue 界面，并在应用进程内启动只监听 `127.0.0.1:18182` 的 Kotlin/Ktor 服务；WebView 始终访问这个本地入口。知识内容保存在应用私有目录，断网时页面编辑、搜索、图谱、附件、归档、回收站和备份恢复均可使用。

## 能力边界

- Android 只能作为同步成员，不能签发成员令牌或充当中枢。
- 同步由冷启动/回到前台、本机写入、用户手动全量对账、**前台心跳**和**周期自愈对账**触发；没有同步 SSE、WorkManager、常驻前台服务或通知。**前台心跳**：App 在前台时每 30 秒检查一次，距上次成功同步满 90 秒就补一轮轻量增量同步（窄代理写中枢成功后也会立刻排一轮，转换/入库/记灵感的结果能马上回流）；退到后台立即停止，不新增后台调度。**周期自愈**：与桌面 / Docker 成员端 15 分钟一轮的 `HEAL_INTERVAL_MS` 同口径，挂在「前台事件触发的一轮同步」上顺带跑（不另起后台定时器）——改名 / 移动 / 删除这类「没有内容 op」的缺口只有全量清单能补齐；发现「中枢已无此内容」时会把自愈时间清零，下一次前台同步先补一轮，避免手机停在旧路径。**退到后台后有一个最多 5 分钟的宽限窗口**：若还有在途请求、待推队列或已排队的下一轮，就把这些工作跑完再停（窗口内不排新的失败重试、不凭空发起无关的新一轮；一轮收敛且待推队列清空就提前结束）。窗口到期立即取消在途请求，SQLite 待推队列保留到下次前台继续。
- 页面、附件、删除、移动和证据快照沿用 Node 中枢的 `/api/sync/*` 协议；首次绑定同路径以中枢内容为准，本机独有内容上传。页面并发由中枢按现有三方合并与冲突副本规则裁决。
- **图片资产单独走增量同步**：贴图 / 拖图写入 `assets/<父项id>/<内容哈希>-原名` 时，图片文件本身也进待推队列（`file` op），删除 / 挂载同样入队；中枢侧的资产上传、外链图本地化、删除、挂载也都发同步变更。只靠父项正文的 page op 传过去会让对端 `![](/media/…)` 破图（2026-11 用户实测「附件没上去」）。回收站「恢复」同样入队，否则中枢仍当它已删除。
- **单条坏变更不再卡住整轮**：推送 / 拉取 / 全量对账都逐项容错——某条推不上去或应用失败时记一条 warn 并继续处理其余项，本轮结束按退避重试；拉取跳过旧路径后会安排下一次全量对账补齐，同一路径每轮只记一条。中枢在 compact 回放里会把「该路径已不存在」的旧 op 标成 `missing`，手机直接跳过、不再逐条换 404（补积压时这类旧 op 可能连片出现几百条）。中枢本来就没有某路径时的删除回执视为「删除目的已达」（info），不再误记成「失败 · 同步分类可能已关闭」。**本轮有拉取/对账缺口**（单条 op 应用失败、旧路径 404、对账单项没落地）时，收尾会在前台排一次 30 秒后的补轮（`sync-gap-retry`，5 分钟节流），不再等下一次用户操作才补。
- **连接通道择优（局域网 → IPv6 → IPv4 → 断开）**：中枢在 `/api/sync/announce` 里通告自己的内网地址，手机把它们与配置的中枢地址排成候选逐个探测（局域网候选 1.5 秒超时），局域网通就走内网直连，否则回到中枢地址按双栈选 IPv6/IPv4，全部不可达时显示「已断开」（本机改动照常排队，下一轮自动重试）。探测节流为「首次 + 每 10 分钟」，改开关或改绑定立即重探。中枢主地址的探测与真实请求走同一条双栈路径（**探测命中哪一族就以哪一族作为通道**，探测成功也会改写双栈记账），每个协议族各有独立超时预算——IPv6 黑洞时仍能退回 IPv4，不会出现「探测说断开、同步其实正常」。通道现状经 `/api/sync/status` 的 `link` 字段给界面——侧栏状态胶囊显示「局域网 / IPv6 / IPv4 / 已断开」，设置 → 多端同步 → **局域网优先** 可开关（关掉只按中枢地址连）。中枢还没有这个通告端点时按中枢地址归类通道，不误报断开。
- **本机网络感知（IPv6 出口 + 切换重学）**：`DeviceNetwork` 读默认网络的 LinkProperties，判断本机当前有没有全局 / ULA IPv6 出口（链路本地 `fe80::/10`、回环不算）——手机在「路由器没下发 IPv6」的 Wi-Fi 或「只转发 IPv4」的 VPN / 代理下时，直接走 IPv4、状态写「本机当前网络没有 IPv6 出口」并提示换网络 / 关代理，不再花三次连接超时去撞 IPv6、也不把原因算到中枢域名头上；域名只有 AAAA 时直接给出可读错误而不是无限重试。默认网络一变化（Wi-Fi ↔ 蜂窝、开合 VPN）就清掉学到的双栈状态、旧网络通告的局域网地址并立即重探，回到有 IPv6 的网络后第一次请求就恢复 IPv6 优先（旧逻辑要等 10 次成功后的回探）；回到前台再补一次核对。需要 `ACCESS_NETWORK_STATE`（普通权限，安装即授予）。
- 会话与任务看板不落本地副本：手机的聊天与看板经窄代理读中枢那一份（会话同步只同步完成态，看板全端唯一一份）。同步引擎遇到 `session` / `board` 两类 op 显式跳过；协议比本端新时的未知类型不再静默吞掉——记一条 warn、水位照常推进，升级手机端即可补齐。
- 同步详情与桌面端同口径：逐条记录带「哪个文件 + 什么增量 + 改动正文采样」（`data.changes`，单条 20 行 / 1400 字预算），支持 视角 / 事件 / 级别 / 关键字 筛选；本机推送被中枢合并时记一条 `push-merged`，说清「本机与中枢都有改动，已按中枢合并结果写回」。
- 本机名称取中枢配置的成员名：每次全量对账从快照的 `device` 字段学回（`sync_device_label`），还没连上中枢时退回手机型号；设置页「多端同步 → 本机名称」与对话来源徽标都用它。
- **「已提炼」标记每轮同步都会对齐**：标记只存在于中枢账本（`source_versions` / `page_contributions`）里，没有对应的同步 op——桌面 / Docker 成员端靠 15 分钟一次的自愈对账顺带补齐，手机端只有前台事件触发的一轮同步（外加 15 分钟一次的周期自愈对账兜底），只靠首轮全量对账的话，中枢之后新提炼的资料在手机上会一直不带「已提炼」（用户报的现象：电脑上标了、手机没标）。现在一轮同步收尾时会走中枢的轻量标记清单 `GET /api/sync/distilled`（只回路径；中枢只回「仍存在的资料」、不按同步分类过滤，手机按本地分类采纳），与本地已标集合比差集后**只对差异项**拉 `/api/sync/evidence` 补账本；节流为每 5 分钟最多一次，手动全量对账强制查，中枢没有这个端点（旧中枢）时记一条 `ledger-marks-unsupported` 并照旧等全量对账。中枢返回**空清单**而本机有标记时跳过取消（`ledger-marks-guard`，防中枢异常时误清）。改动写进同步详情（`ledger-marks`：已提炼标记已对齐：新增 N 项、取消 M 项）。
- **收集箱与「记一条灵感」走中枢**（语义转换、模型拟标题、落盘前勘误与正文精炼都在中枢）：中枢这几条内容面接口与 `/api/assistant/**` 同一道门（成员 token 或 owner / MCP token），手机只持同步成员令牌即可用；「记一条灵感」的「预览 → 确认落盘」两步（`POST /api/ideas/preview` 与 `POST /api/ideas`）都窄代理到中枢，未绑定中枢时给出明确提示而不是报错。收集箱行的「让 Agent 总结并转换」（`POST /api/inbox/agent-task`）同样窄代理到中枢，由中枢的内置 Agent 读原件、总结并按需转换。图片资产「挂载到…」（`POST /api/assets/attach`）在手机上本地实现：把未归属散图移进目标页面目录并把引用追加进正文。
- **收集箱状态不会回退成「待整理」**：手机本机按磁盘事实推导（`收集箱/转换结果/` 里来源匹配的产物 → 已转换；`原始资料/文档/` 里同名且来源一致的副本 → 已入库），并把中枢成功响应的状态落盘缓存（设置键 `sync_inbox_status`）。冷启动首轮同步完成前、离线、任一轮同步失败时显示「上次已知状态」，不再用 `sync.connected` 一票否决；产物/入库副本在磁盘上存在时，任何 pending 结论都会被修正回已转换/已入库。
- 原始资料 md 改「分类」与桌面端同口径：可移动到 `原始资料/文档`、`原始资料/对话`、`原始资料/灵感碎片`（不再是「只能留在 Wiki 目录」）。**改名/移动时账本跟随路径**：本机改名或收到同步 `move` 时，`evidence_snapshots` / `page_revisions` 里的路径键一起迁移（服务端对应 `remapRawSourcePaths`），否则新路径会显示「未提炼」（用户报障：已整理在其他端变成未整理）。
- 客户调研支持查看记录、启动/停止任务、分别清除或一键清除记录（只删记录，知识库文档不动）、修改流程模板，均使用同步成员令牌窄代理到中枢；重复客户时先查知识库已有报告并让用户选「生成新版本 / 覆盖旧报告」；完整报告自动入库，资料不足简报只在页面反馈、可手动入库。报告按 `YYYY.MM.DD_公司全名调研报告` 命名（资料不足简报为 `…_调研简报`），重名追加 `_2`、`_3`，原始资料按同步分类设置回到手机。客户洞察工作台在手机上按单列排布（客户列表 → 客户档案 → 客户速览），章节用下拉切换并接安卓返回键；主体核验状态（已核实 / 未经工商核实 / 查无此主体）与警示条同桌面端一致；报告正文角标可点回「来源与结论对照」，点来源条目回到正文最近一处引用。
- 不在手机上运行 dsh/MCP/CLI，也不下发模型 Key（2026-11 起，内置 Agent 的模型配置与相关 Key 随「设置」分类在桌面端 / Docker 端之间同步，**手机不参与、不落 Key**：Kotlin 侧不加这些 preference key，未知 key 按现有逻辑跳过）；完成成员绑定后，聊天抽屉通过本机 loopback 服务把 Agent 交互窄代理到 Docker 中枢。会话与长任务留在 24 小时在线的服务器上，手机退后台只断开 SSE，不会取消已经提交的任务，回到前台后按 active run 与快照接续。
- **Agent 与自动化配置（v1.5.1 起）**：绑定中枢后，手机设置页也会出现「内置 Agent / 内置 Agent 控制台 / 视频理解模型 / 自动整理（梦境思考）/ 任务看板提炼 / 工具与手册」，经本机 loopback 服务用同步成员令牌窄代理到中枢——改的是中枢上真正在跑的那一份配置（模型、插件、预设、视频理解模型开关、梦境计划），手机本身不运行 dsh。模型 Key 只写不读（读接口只回 configured/hasKey），视频理解模型默认 DashScope / qwen3.8-omni-flash、只需在控制台模型页填一个 DashScope API Key；改完下一轮对话或下次提炼生效；未绑定中枢时整个「Agent 与自动化」不出现，直接访问控制台路径显示「请先在 多端同步 绑定中枢」。详见下方「Agent 与自动化配置」。
- 不提供同步中枢管理（成员邀请 / DDNS / TLS）、外部接入与 MCP Token 发放、Docker / 桌面端更新（拉镜像换容器、装 exe）、ONLYOFFICE 在线编辑或 OCR。外部接入与 MCP Token 等同 owner 权限，只在桌面 / 中枢生成，不下发到手机。**手机端有自己的应用内在线更新**（下载新 APK 并调起系统安装器，见下方「应用内在线更新（OTA）」）。同步来的 AI 工作区与证据仍可只读查看。
- PDF.js 提取 PDF 自带文字层，浏览器兼容组件解析 DOCX/PPTX/XLSX 并把确定性文本写入本地搜索索引；图片和扫描 PDF 不做 OCR。
- 在浏览器、相册、文件管理器等应用点「分享 → Engram」，文字、链接、图片以及单个或多个文件会直接保存到手机本地 `收集箱/`，随后进入「落袋回执」（保存后确认，可直接去清仓或回首页）；应用未启动或尚未登录时也会先保存，登录后展示。文字和普通链接原样保存为 `.txt`，链接不会自动抓取网页正文；B 站 / 抖音视频链接会写成带 `类型: video-link` frontmatter 的视频占位稿（平台、链接、标题），和手动粘贴视频链接走同一条「提炼视频」管线；附件保留文件名，同名自动追加序号。
- 手机端外壳改版（v1.5.3 起，v1.5.4 补齐设备矩阵）：底部五项导航（首页 / 知识库 / 收集箱 / Agent / 我的），「我的」为列表式底部面板（账户与同步状态、新建页面 / 记一条灵感、搜索 / 图谱 / 看板 / 客户调研 / 多端同步 / 设置 / 外观）；按窗口尺寸换骨架——<600dp 五项底栏，600–839dp 折叠屏展开 / 横屏 / 小平板改用左侧导航栏与浮层目录，≥840dp 平板与桌面回三栏；顶层页下拉刷新（**真的发起一轮同步对账**并等它收尾、最多 20 秒，不是只重读状态）、手机「新建」FAB 选择面板、设置分组列表 + 子页、编辑器「插入」面板、阅读目录 h1–h3 底部面板；收集箱卡片区可纵向滚动、动作条固定在底栏上方、左滑移入回收站可撤销；编辑器工具条单行横滚、表格工具条 44dp；关键动作经 navigator.vibrate 轻振。安卓 13+ 打开预测性返回（OnBackInvokedDispatcher，API 33 以下保留旧回调）。（v1.5.5 补齐收尾：Agent 独立页、收集箱长按多选与批量、编辑器选中浮动格式条 / 表格更多 / 格式面板、阅读「编辑」FAB 与进度线、折叠屏 medium 双栏与折痕对齐、桌面姿态操作台、首页看板手机编辑、贴底通知、触觉反馈开关、全局 48dp 热区；viewport-segments 折痕与桌面姿态需真机复核）
- 手机窄屏的收集箱是卡片台：最新一条在卡片堆最上面，「刚刚存入」会标出来；右滑执行主操作（转换 / 提炼视频 / 入库 / 让 Agent 处理 / 下载），左滑移入回收站，上滑看详情，底部三个按钮是手势的无障碍替代；分组按来源 / 类型归组，转换与入库仍由绑定的中枢执行；顶部分类胶囊按「未入库 / 待整理 / 已转换 / 已入库」筛选（未入库 = 待整理 + 已转换，与桌面同一口径），卡片堆只铺三张、其余条目在下方整列列出，「已入库」档可回看产物与落点，不会再出现「入库后从手机界面消失」的观感。宽屏工作台保留原有的拖入、粘贴链接、筛选与菜单。收集箱原件离线可查看、下载和移除，不参与知识检索；联网并启用对应同步分类后进入普通同步待推队列，中枢收到后可转换、审阅入库。文件按 64 KiB 分块复制，单文件上限 200 MB；多项分享中的失败项单独提示，其他项目继续保存。

- 知识库目录触屏整改（2026-11）：左侧目录从「桌面侧栏缩小版」改成手机操作习惯——抽屉宽度按可用视口给（compact 320dp、medium 常驻栏 clamp(280, 38vw, 340)dp），「知识库」标题不再折行，满窗入口只在平板/桌面出现；分区右侧的导出 / 新建 / 上传三个 hover 图标收进一个 44dp 的 ⋯ 动作面板（排序 / 新建 Markdown / 上传 / 导出），顶部四个 44dp 图标不再把「原始资料」类目名挤到 0 宽；行内不再常显多选方框，改为长按 500ms 进入多选（轻振；行尾 ⋯ 里也保留「多选」备用入口），点按始终是打开；触屏不再派发右键菜单与 HTML5 拖拽，行尾 ⋯ 在触屏是贴底动作面板；满窗目录在手机上去掉桌面 rail 的 64dp 左边距、隐藏底栏并在头部隐藏「Esc 收回」，原始资料列与非 md 文件（.txt/.pdf）统一用 documentTitleParts 拆掉日期前缀与扩展名，不再把原文件名当标题；返回键 / 底栏「首页」/ 遮罩 / 左滑统一走 closeSidebar() 同时清 `sidebarOpen` 与 `sidebarFull`（旧实现会停在「正文 pointer-events:none」点不动）；触屏隐藏拖宽手柄，排序弹层接返回键；medium 600–719 仍走抽屉，≥720 才并排常驻。

## Agent 与自动化配置（v1.5.1 起，经中枢窄代理）

手机不运行 dsh / MCP / CLI，模型 Key 也不下发；绑定中枢后，设置 → Agent 与自动化 的以下分组会出现在手机上（服务端能力位 `features.agentConsole` / `features.videoConfig` 在已绑定时为 true）：

- **内置 Agent / 内置 Agent 控制台**：`/api/agent-console/*` 全部 18 条（状态、重启、停止、模型、提供商、插件、预设、高级、原始设置视图）经成员令牌窄代理到中枢。模型提供商、API Key、插件与 Agent 预设写的是中枢那一份 dsh 配置；`credentials/describe` 只回 configured，不回明文 Key。控制台首次打开时由中枢拉起 dsh web 进程（空闲 30 分钟回收），手机只做配置界面。
- **视频理解模型**：`GET/PUT /api/settings/video-config` 窄代理（独立于通用 `/api/settings`）现在只同步一个开关——中枢的 `video_config` 只存 `{ enabled }`（默认开启），PUT 只认 `enabled`，旧客户端带来的 `baseUrl` / `apiKey` / `model` 等字段一律忽略。模型与 Key 不再经这条接口下发：中枢第一次打开该面板时会把默认提供商 `dashscope`（阿里云百炼，OpenAI 兼容地址）与 `qwen3.8-omni-flash` 幂等播种进内置 Agent 控制台的 dsh 模型配置，用户在控制台「模型」页填一个 DashScope API Key 即可；手机上同样能打开该控制台页（走已代理的 `/api/agent-console/*`）。手机面板读 `status` 展示当前模型、「API Key 来源」（中枢控制台已配置 / 来自多端同步（中枢本机未配置）/ 未配置）与「已启用 / 待配置 / 未启用」，点「去控制台配置模型与 API Key」进控制台。
- **模型配置多端同步（2026-11，手机不参与）**：桌面端 / Docker 端的「内置 Agent 控制台 → 模型」配置（提供商 / 官方 DeepSeek 配置 / 默认模型）与这些提供商引用到的 API Key 随同步的「设置」分类在群组内下发，**Android 端既不上传也不落盘**——手机只经窄代理读写中枢那一份配置与状态。因此手机面板上的 `status.keySource` 说的是**中枢**的 Key 来源：`local` = 中枢控制台已配置，`synced` = 中枢本机没配、来自群组另一台设备（手机面板文案写成「中枢控制台已配置 / 来自多端同步（中枢本机未配置）」）。手机不持有模型 Key，视频提炼与聊天都在中枢执行。
- **手机端不需要额外适配**：模型与 Key 都在中枢，手机只读状态、改开关；窄代理是纯 JSON 透传（`GET` 回 `{ settings, status }`），`EngramLocalServer.kt` 的转发逻辑不用改。状态与连通性测试继续走已代理的 `/api/inbox/video-status`、`/api/inbox/video-test`（`video-test` 直接用解析到的模型测试，不再接受 baseUrl / apiKey 覆盖），API Key 不回显（状态只给 `hasKey` / `keySource`，新字段缺省时旧 Web 包按 `hasKey` 降级）。
- **自动整理（梦境思考）**：`/api/assistant/dream` 的读/改与 `/dream/run`、`/dream/stop` 窄代理，计划与实际运行都在中枢。
- **任务看板提炼**：沿用既有 `/api/tasks/board/config` 窄代理（看板页本就可在手机上就地改档位）。
- **工具与手册**：`/api/guide` 窄代理读中枢的只读作业指南。
- **外部接入 / MCP Token 不出现**：成员令牌不能生成 owner 级凭据，仍需到桌面 / 中枢操作。

安全口径：成员令牌可以写中枢的 Agent 与视频模型配置（因此能改模型指向），但读不回任何 Key 明文；这是「用手机远程配置自己中枢」的显式取舍（见 `server/src/assistant/access.ts` 与 `routes/agentConsole.ts` 顶部注释）。模型配置的跨端同步只发给同步群组内的设备（含 Key 明文，群组设备本身互信），Android 不在其中、也不保存 Key。

## 数据与安全

应用数据位于 Android app-specific storage 下的 `engram/`：

```text
engram/
├── brain/       # Markdown 与附件真源
└── wiki.db      # 页面/文件索引、搜索词、图谱、回收站、证据、同步水位和待推队列
```

- 每次启动扫描 `brain/` 与索引对账；数据库可由文件库重建。
- 登录密码使用 PBKDF2 哈希；同步成员令牌与本地会话密钥由 Android Keystore AES-GCM 密封保存，不进入 SQLite 或备份。
- 所有本地、上传、恢复与同步路径均做 canonical 越界校验；写入先落同盘临时文件再原子替换；普通文件同步单文件上限 200 MB，收集箱文件同步不设固定单文件上限；网络和文件复制采用流式处理。
- Android 私有目录会在卸载时删除。设置 → 知识库数据 → 备份与恢复 可导出 v2 备份：`manifest.json + brain/ + portable-metadata.json`，不含密码、会话和同步令牌；导入旧版 `wiki.db + brain/` 时忽略旧数据库并从 `brain/` 重建本机索引。
- 旧远程 APK 原地升级后，只把已保存服务器地址预填为候选中枢地址；仍需成员令牌，不会静默启用同步或覆盖本地库。

## 工程结构

```text
main/mobile/
├── capacitor.config.json       # appId=com.engram.app，webDir=web-dist，adjustMarginsForEdgeToEdge=disable
├── scripts/prepare-mobile-web.cjs
├── scripts/build-apk-ci.sh     # Web build → 复制资产 → cap sync → Gradle test/assemble
├── Dockerfile.ci
└── android/app/src/main/java/com/engram/app/
    ├── MainActivity.java       # 生命周期、WebView、系统分享与下载、邀请链接直达、返回键与启动层
    ├── SystemBars.java         # 透明系统栏 + insets 交给网页 + 系统栏图标明暗跟随应用主题
    ├── SystemBarPolicy.java    # 系统栏策略纯逻辑（JVM 单测：insets JSON 契约、API 版本差异）
    ├── BackPolicy.java         # 返回键判定纯逻辑：网页 → 历史 → 退后台
    ├── BiometricUnlock.java    # 系统解锁桥（指纹/人脸/锁屏密码 + Keystore 密封的登录密码）
    ├── EngramLocalServer.kt    # loopback Ktor REST/静态服务
    ├── AppUpdater.kt           # 应用内在线更新引擎：检查 Release / 后台下载（含断点续传）/ 调起安装器
    ├── AppUpdatePolicy.kt      # OTA 纯逻辑与配置（版本比较、附件挑选、进度、更新源优先级）
    ├── UpdateNotifier.java     # 「新版本已下载」系统通知
    ├── AgentBridge.kt          # Docker Agent 交互面窄代理
    ├── LocalDatabase.kt        # Markdown/SQLite/备份/回收站
    ├── DeviceNetwork.kt       # 本机 IPv6 出口判定 + 网络切换通知（双栈换网重学）
    ├── SyncEngine.kt           # 前台一次性成员同步（退后台最多 5 分钟宽限）
    ├── BackgroundSyncPolicy.kt # 后台宽限策略纯逻辑（JVM 单测）
    └── SecretStore.kt          # Android Keystore
```

`mobile/web-dist/` 是构建产物，不入 Git。每次打包必须先构建 `@engram/web`，再运行 `prepare:web` 和 `cap sync android`。

## 系统栏与返回手势

安卓系统栏是完全边到边（edge-to-edge）的，网页背景一直铺到屏幕边缘，状态栏/导航栏区域不会再出现一条独立色带：

- **透明系统栏**：`SystemBars.install()` 关掉 `windowOptOutEdgeToEdgeEnforcement` 时代的 opt-out，改用 `WindowCompat.setDecorFitsSystemWindows(false)` + 透明 `statusBarColor`/`navigationBarColor` + 关掉系统蒙层（API 29+ `setNavigationBarContrastEnforced(false)`）。
- **图标明暗跟随应用主题**（不是系统深色开关）：网页在 `applyTheme()` 之后调 `window.EngramSystemBars.setDark(dark)`，原生据此设置 `setAppearanceLightStatusBars/NavigationBars`，并把选择记进 SharedPreferences 供下次冷启动使用。
- **安全区由原生注入**：WebView 里 `env(safe-area-inset-*)` 不可靠（恒为 0），所以原生把 `systemBars()`/`ime()`/挖孔的尺寸经 JS 接口 `EngramSystemBars.insets()` + `window.__engramSystemBars(json)` 交给网页；网页在 `web/src/lib/systemInsets.ts` 写进 `--inset-*`，样式层统一用 `--safe-top/right/bottom/left`（`max(env(...), var(--inset-*))`）。软键盘只用来加 `html.kb-open`（底部常驻栏收起），不加进底部安全区——布局视口本来就随键盘收缩。
- **`adjustMarginsForEdgeToEdge` 必须保持 `disable`**：Capacitor 的 `auto/force` 会给 WebView 自己加 margin，网页视口被内缩、安全区仍然算不出来，正好把上面这套废掉。
- **返回键/侧滑返回/预测性返回**：Manifest 上 `android:enableOnBackInvokedCallback="true"`，`MainActivity.installBackHandling()` 按 SDK 分支只注册一个入口——API 33+ 用 `getOnBackInvokedDispatcher().registerOnBackInvokedCallback(PRIORITY_OVERLAY, …)`（系统返回手势有跟手/预览动画），API 33 以下保留 `OnBackPressedCallback`；两条路径互斥、执行同一套判定（`handleSystemBack`）：先 `evaluateJavascript("window.__engramHandleBack()")` 问网页是否消费（关确认框、长按菜单、资产/同步日志抽屉、对话抽屉、文件树、阅读目录面板……注册入口是 `web/src/lib/androidBack.ts`），网页不要才 `webView.goBack()`，历史到头才 `moveTaskToBack`。启动期 `loadDataWithBaseURL` 的占位页在首帧就绪时用 `clearHistory()` 清掉，避免根页面按返回退到空白页。`@capacitor/app` 的 `backButton` 在这个壳里不可用（页面来自 `http://127.0.0.1:18182`，Capacitor 桥没有注入该 origin），不要改回去用它。

## 系统解锁（指纹 / 人脸 / 锁屏密码）

本地库的会话 cookie 最长 30 天，过期或退出登录后仍会回到登录页。登录页的「指纹 / 人脸解锁」调用的是**系统自己的解锁界面**，应用不自绘图案锁，也不引入 `androidx.biometric`（全部走框架 API，离线构建不需要新依赖）：

- **Android 11+（API 30）**：`BiometricPrompt` + `setAllowedAuthenticators(BIOMETRIC_WEAK | DEVICE_CREDENTIAL)`——录了指纹/人脸就走生物识别，没录就落到锁屏密码，弹窗长什么样由系统决定；
- **Android 9/10（API 28-29）**：同一个 `BiometricPrompt`，用 `setDeviceCredentialAllowed(true)`（该 API 在 30 起被 allowed authenticators 取代，但这两档没有等价写法；它与「取消」按钮互斥，所以这两档不设取消按钮，返回键 / 点空白仍可取消）；
- **Android 6-8（API 23-27）**：`KeyguardManager.createConfirmDeviceCredentialIntent()`，由系统出示锁屏验证界面（框架版 `BiometricPrompt` 要求 API 28+）。结果经 `MainActivity.onActivityResult` 转回桥。

网页侧契约在 `web/src/lib/biometric.ts`：`status()`（能力 + 是否已开启）、`remember(password)`、`unlock(requestId)`、`forget()`；解锁结果由原生回调 `window.__engramBiometricResult(requestId, json)` 送回（按 requestId 对号，带 3 分钟超时兜底）。**凭据只有登录密码这一份**：开启后由 `SecretStore` 用 Android Keystore 的 AES-GCM 密钥密封存盘（密钥不可导出、不进备份），只有系统解锁成功之后才会取出交给网页去换会话 cookie；解锁失败、取消或从未开启都不会有凭据离开进程。改密码（设置 → 账户）自动关闭它，避免拿旧密码撞 401；开启只能在登录页做（那里才有明文密码）。桌面端 / Docker 网页端没有这条桥，登录页自动隐藏整块（`biometricStatus()` 返回 null）。


## 扫码绑定与邀请链接直达

绑定同步中枢要填「中枢地址 + 54 位绑定令牌」，手抄容易错。中枢（Docker/桌面端）在 设置 → 多端同步 → 同步群组 的「添加成员 / 成员行 → 邀请」里给出**二维码 + 邀请链接**（`engram://join?hub=…&token=…&name=…&v=1`），手机端有两条免手抄的路：

- **应用内扫码**：设置 → 多端同步 → 绑定中枢 → **扫码**，取景框直接用系统摄像头（`getUserMedia`），识别到链接后自动填好中枢地址与令牌，仍由用户点「保存并绑定」确认；识别逻辑在 `web/src/lib/qrScan.ts`（抽帧 → `jsqr` 解码，解码器动态 import，不进主包）。**权限**：Manifest 声明 `android.permission.CAMERA`（配 `uses-feature android.hardware.camera required="false"`，没有摄像头的设备照样能装），取流时由 Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 向系统申请运行时权限——所以**不需要** `androidx.camera` 或任何原生扫码库，安卓侧只多了一条权限声明。WebView 在 `https://localhost`（Capacitor 默认）下是安全上下文，浏览器自身的摄像头限制在此不构成问题；被拒绝/没有摄像头/被占用都会在取景框里给出中文原因。
- **邀请链接直达**：`AndroidManifest` 为 `MainActivity` 注册 `engram://join` 的 VIEW intent-filter；`MainActivity.handleJoinLink(intent)` 认下链接后交给网页的 `window.__engramJoinLink(raw)`（网页侧 `web/src/lib/joinLink.ts`：存进 `pendingJoinLink`、跳到 设置 → 多端同步，由 `SyncPanel` 消费并回填表单）。**投递要确认**：网页函数返回 `true` 才算送达，冷启动时页面还没起来就每 300ms 重试（上限 100 次），首帧就绪时（`waitForPageSurface`）会重置计数再补投一次；已参与同步的设备收到链接只提示「需先解除绑定 / 退出中枢角色」，不静默改写配置。

同一条链接也可以直接粘贴：成员端「绑定中枢」表单里的邀请链接输入框会即时解析并回填（解析规则与严进宽出的口径见 `web/src/lib/syncInvite.ts`：只认 http/https 中枢地址 + 不含空白的令牌，链接被夹在聊天文字里也能认出来）。


## 应用内在线更新（OTA）

手机端不能像桌面端那样增量拉源码重建，也不能像 Docker 端那样换容器，**唯一的升级通道是安装包**；所以这里做了一套自己的 OTA：信号源沿用服务器/桌面端同一份 **Gitea Release**（附件名 `Engram <版本>.apk`），三端「有没有新版」的口径完全一致。

- **入口**：设置 → 版本与更新 → 安卓端更新（能力位 `features.apkUpdate`，只有 App 内的 Kotlin 服务会报 true，桌面/服务端形态整组不出现）；检测到新版本时右上角还会亮起那枚绿色更新图标，展开面板点一下就是「下载并安装」。
- **动作链**：`POST /api/app-update/check` 比对 `/api/v1/repos/<owner>/<repo>/releases/latest` 的 `tag_name` 与本机 `versionName` → `POST /api/app-update/download` 在后台线程流式下载到应用私有目录 `getExternalFilesDir(null)/updates/`（带 `Range` 断点续传，切后台/进程被杀后回前台接着下）→ `POST /api/app-update/install` 用 FileProvider 把 APK 交给系统安装器。检查与下载都是异步的，界面按 1.2 秒轮询 `GET /api/app-update/state` 看 `phase` / `percent`。
- **装机确认**：Android 从 8.0 起侧载必须由用户确认，应用只负责把包备好并调起安装界面（不做也无法做静默安装）。未授权时面板给「去开启安装权限」按钮跳 `ACTION_MANAGE_UNKNOWN_APP_SOURCES`；装完系统替换应用、进程重启，本机知识库数据不受影响。
- **自动更新**：默认开启——启动 / 回前台（`MainActivity.onStart` → `EngramLocalServer.onForeground`）距上次检查超过 6 小时就查一次，发现新版直接后台下好；网页侧的退避调度（`lib/updateCadence.ts`）在同一套状态上再补一轮。「发现」自动，「安装」永远要用户点一次。
- **自动更新失败暂停**：自动后台下载失败一次（网络中断、鉴权失败、包不完整等）后，本机会记住这个目标版本并**不再自动后台下载**（手动「检查更新 / 下载 / 立即安装」始终可用），同时发一条系统通知、设置页显示暂停横幅与「重试自动更新」按钮；发布更新的新版本（版本号不同）或用户显式重试后恢复正常自动更新。
- **更新源不预置**：代码里没有任何默认仓库地址。地址有两个来源，**本机手填优先**，其次**多端同步中枢**——中枢（Docker/桌面端）在「更新源配置」里填过的仓库地址会随 `/api/sync/snapshot` 的 `updateSource` 字段下发（见 `server/src/lib/updateConfig.ts` 的 `updateSourceForSync`，**只带地址不带凭据**），手机没手填时直接用它，不必每台设备各填一遍；面板上会写明「当前用的是同步中枢下发的地址」，点「改回跟随中枢」可清掉本机手填的地址。
- **私有库凭据二选一**：与服务器/桌面端「更新源配置」同一套口径，面板上「私有库凭据」可选 **访问令牌** 或 **用户名密码**（Basic，`AppUpdatePolicy.authHeader` 与 `server/src/lib/giteaRelease.ts` 的 `repoAuthHeaders` 逐字同口径：`token <令牌>` / `Basic base64(用户名:密码)`，UTF-8）。凭据**不随多端同步下发**，只存本机：令牌与密码走 `SecretStore`（Android Keystore 密封），用户名随设置表存；两者都不回显，输入框留空即「不修改」，清除要显式点按钮。保存时只保留当前方式的凭据（换方式后另一种会被清掉），用户名密码方式缺一项会被界面当场拦下——否则私有库会静默退化成匿名访问（表现为 401/404，而不是「凭据没填全」）。
- **提醒**：应用内是那枚绿色更新图标 + 设置页徽标；退到后台时下载完成会发一条系统通知（Android 13+ 需通知权限，面板上给「允许通知」按钮按需申请）。
- **边界**：调试包（`versionName` 带 `-local-first-debug` 后缀）不参与覆盖安装——它与正式包 `applicationId` 不同，装正式包会变成两个 App 并存，面板会说明原因；远端 Release 必须有 `.apk` 附件（发版 dispatch 勾选 `binaries` 才会上传）；签名必须与已装版本一致才能覆盖升级，keystore 丢失只能卸载重装。

## 本地开发与验证

环境依赖：JDK 21、Android SDK platform/build-tools 35、Node 22 和仓库 pnpm 依赖。下载或安装环境文件前必须按仓库规则取得用户许可。

```bash
cd main
pnpm --filter @engram/web build
node mobile/scripts/prepare-mobile-web.cjs
cd mobile
pnpm exec cap sync android
cd android
./gradlew testDebugUnitTest assembleDebug
```

最低系统版本为 API 23，目标/编译版本 API 35；应用 ID 仍为 `com.engram.app`，版本号仍从 `desktop/package.json` 自动派生。验收至少覆盖 API 23 与 API 35：首次设密和离线 CRUD、进程重启、前后台取消网络、飞行模式编辑后重连、附件流式传输、旧 APK 升级、备份恢复和真实 Node 中枢双向同步。

## CI 与签名

`mobile/Dockerfile.ci` 同时安装主 workspace 和独立 Capacitor 依赖，构建期预热 Android/Gradle 缓存。`mobile/scripts/build-apk-ci.sh` 顺序为：构建 Web → 准备 `web-dist` → `cap sync android` → `testDebugUnitTest` → `assembleRelease`。

release 签名仍读取 `mobile/android/key.properties`（不入库）或 CI 的 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。keystore 丢失后无法覆盖升级既有安装，必须单独备份。日常开发不改版本号、不生成正式 APK。

**发版口径**（2026-09-27 起，见仓库根 `AGENTS.md` 项目规则 9）：

- 发版是显式动作，只在用户明确提出时进行；但**每次发版都必须产出 APK**——它是发版三件套之一（Android APK + Windows exe + Docker 镜像），三件缺一视为该次发版未完成。
- 推 `v*` 标签后立刻 dispatch release.yml 勾选 `binaries`，APK 与 exe 构建完成后自动补挂本次 Release。
- APK 必须基于本次发版提交构建、版本号与 `desktop/package.json` 一致（不得复用旧包）。
- 发版说明里的安卓部分要**补齐自上一个 Android 版本以来累积的全部改动**（安卓端不能源码自更新、可能一次跨过多个版本），并确保手机端代码已对齐这段区间内桌面/Docker 端已有的功能。

## 三端并行与手机对齐

手机端是「一套产品内核 + 三个运行壳」中的适配端：`main/web` 与桌面/Docker 共用同一份构建，操作逻辑按触屏重做。跨端开发规范、平台契约、A–F 分类与同步节奏见 [`PLATFORM-PARALLEL-DEV.md`](./PLATFORM-PARALLEL-DEV.md)；未完成的手机适配登记在 [`MOBILE-SYNC-LEDGER.md`](./MOBILE-SYNC-LEDGER.md)，**发版前必须清零**。

每次手机行为变化（能力位、壳层、原生桥、同步数据面）合并前，至少完成规范 §4.6 的 DoD：分类声明、Web 护栏测试、API 23/35 与 compact/medium/expanded 三档、返回键/安全区、同步双向冒烟（改到数据面时）、本文件对应段落更新。
