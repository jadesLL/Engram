<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="main/docs/brand/engram-lockup-dark.svg" />
    <img src="main/docs/brand/engram-lockup-light.svg" alt="Engram" width="360" />
  </picture>
</p>

# Engram · 个人知识库

把文档、对话和灵感整理成可检索、可追溯的知识。支持 Windows、Android 与 Docker 自托管，Markdown 文件由你自己掌握。

基础知识库无需模型 Key；配置自己的 Key 可使用内置 Agent，也可通过 MCP / CLI 接入已有的外部 Agent。

[下载安装](#下载安装) · [开始使用](#开始使用) · [详细文档](#详细文档) · [更新日志](./CHANGELOG.md)

## 能做什么

| 功能 | 用途 |
|---|---|
| 资料收集 | 导入文档、保存对话、随手记灵感；Android 可接收其他应用分享的文字、链接和文件到收集箱，转换为 Markdown 后审阅入库；也能直接让内置 Agent 读收集箱原件、总结并转换（图片/音视频同样交给 Agent 处理）。内置 Agent 对话里可直接添加文件（上传 / 拖入 / 从收集箱挑选）交给它处理，也可让它把一段内容新建进收集箱待整理 |
| 知识整理 | Agent 提炼概念与实体，写入时校验原文引文，保留来源证据与操作记录；正文编辑器支持 Markdown 表格增删行列（光标进表格即浮出工具条，即时渲染与源码模式都可用） |
| 检索与阅读 | 全文搜索、双向链接、知识图谱、沉浸阅读与附件预览 |
| Agent 助手 | 基于资料问答、调研、生成任务看板，也可按计划自动整理与纠错；对话里能直接附上收集箱文件，或按你的要求在收集箱新建待整理原件 |
| 客户调研 | 输入客户名称，按统一 ACS 流程与模板生成带来源的报告，保存为 `YYYY.MM.DD_公司全名调研报告`，重名自动追加尾缀；客户洞察页按客户聚合历次调研，报告按章节翻阅、引用可回溯（客户洞察、原始资料阅读页与文件预览三处双向互跳，手机端单列排布）；调研记录与流程模板随多端同步（设置 → 多端同步 → 同步内容，默认开启）；Windows、Docker 与绑定中枢的 Android 安装版共用，外部 Agent 也可调用 |
| 自定义首页 | 拖动、调整卡片大小，组合概览、快速问答与灵感入口；紧凑卡片按尺寸重排内容 |
| 多端与备份 | Windows / Android / Docker 多端同步，离线编辑、整库备份与恢复 |

## 下载与安装

| 使用方式 | 入口 |
|---|---|
| Windows 安装包 | 从 [Releases](https://github.com/jadesLL/Engram/releases) 下载 `Engram Setup <版本>.exe`，双击安装 |
| Windows 源码版 | 下载 [源码版安装器](https://github.com/jadesLL/Engram/releases/download/installer-latest/Engram-source-setup.exe)，日常通过应用内「检查更新」更新 |
| Android | 从 [Releases](https://github.com/jadesLL/Engram/releases) 下载 APK；可离线使用，也可连接同步中枢，详见 [Android 指南](./main/docs/ANDROID.md) |
| Docker / NAS | 按下面的命令从源码启动，或参考 [部署指南](./main/docs/BUILDING.md) 使用 Registry 镜像 / NAS Compose |

Gitea 下载需要已授权账号。安装包也会同步到 GitHub 公开仓库的同名 Release，入口说明见 [公开下载说明](./main/docs/GITEA-CI.md)。

**Docker 从源码启动**（需 Git、Docker Compose 和仓库访问权限）：

```bash
git clone https://github.com/jadesLL/Engram.git
cd Engram/main
docker compose up -d --build
```

访问 `http://<主机IP>:18080`，首次登录设置密码；若配置了 `DEFAULT_PASSWORD`，使用该密码。数据保存在 `main/data/`，请定期备份。

## 开始使用

1. **收集资料**：上传到「原始资料」，或在「收集箱」转换、审阅后入库；零散想法用左下角「+」记录。内置 Agent 对话里也能直接添加文件（上传 / 拖入 / 从收集箱挑选）交给它处理。
2. **连接 Agent**：在「设置 → Agent 与自动化」配置内置 Agent 的模型与 Key；同一页的「内置 Agent 控制台」直接嵌入 DeepSeek Harness 原生界面：插件页与「更多 → 设置」里的模型/内置插件/Agent 预设都在里面，改完对聊天 Agent 直接生效；使用外部 Agent 时，在「外部接入」生成 Token 并复制 MCP / CLI 配置。
3. **整理与查找**：让 Agent 提炼资料、回答问题；通过搜索、双链和图谱回到原文，或打开任务看板查看待办。

知识图谱支持业务视图、全库与本页关联，采用 Obsidian 风格的简洁画布：中性小圆点、细连线与紫色焦点，悬停或选中时突出当前页面及其直接关联，其余关系退后显示。设置和详情默认收起，按需浮于画布上方，不挤压画布或重排节点；右上角「设置」按筛选、分组、显示与力组织，可按类型、标签和规模筛选，也可开启按类型着色，外观设置自动记忆。拖动空白处平移，拖动节点调整位置；被拖节点跟随鼠标，关联节点由连线平滑牵引，松手后保留惯性并逐渐收敛；固定布局时可独立摆放节点。使用画布右下角的缩放、适应画布和固定布局控件调整视野，点击节点查看关联与打开原文。深浅主题和手机布局同步适配。

首页可添加快速问答与灵感卡片；桌面与 Docker 网页端使用固定 12 列逻辑画布（原始单格约 75px），窗口变窄或侧栏展开时，卡片、文字与间距整体等比例缩小，不再横向滚动；编辑前后保持相同缩放比例、排位与内容档位，拖动和调整尺寸按比例换算坐标。手机端仍按可用宽度适配。同步卡片将状态与进度合并展示，快捷入口采用轻量图标与文字；卡片采用紧凑内部布局：统一标题与内容起点，列表按自然行高显示完整条目，来源与时间退到标题下方，底部保留完整内容入口；输入框与提交操作放在同一书写区。横卡长文字在框内滚动，缩放与展开保留草稿。详见[首页快捷卡片](./main/docs/USER-GUIDE.md#首页快捷卡片)。

Android 的 Agent 与收集箱转换等能力由已绑定的中枢执行，详见 [Android 指南](./main/docs/ANDROID.md)。

知识正文与原始资料保存在 `brain/`，SQLite 保存索引、配置与证据等元数据。完整迁移请使用「设置 → 知识库数据 → 备份与恢复」。

## 详细文档

| 想了解什么 | 文档 |
|---|---|
| 功能细节、操作方式、数据目录 | [使用指南](./main/docs/USER-GUIDE.md) |
| 安装、构建、Docker / NAS 部署 | [构建与部署](./main/docs/BUILDING.md) · [Windows 桌面端](./main/desktop/README.md) · [Android](./main/docs/ANDROID.md) |
| Agent 接入与写入规范 | [Agent 操作指南](./main/docs/AI-CONTENT-OPERATIONS.md) |
| 客户调研、报告模板与各客户端入口 | [客户调研指南](./main/docs/CUSTOMER-RESEARCH.md) |
| 多端直连、DDNS 与网络配置 | [网络与直连](./main/docs/IPV6.md) |
| 参与开发与发布 | [开发约定](./main/AGENTS.md) · [Worktree 流程](./main/WORKTREES.md) · [CI 与发布](./main/docs/GITEA-CI.md) |
| 版本变化 | [更新日志](./CHANGELOG.md) |
