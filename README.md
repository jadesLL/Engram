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
| 资料收集 | 导入文档、保存对话、随手记灵感；收集箱支持转换为 Markdown 后审阅入库 |
| 知识整理 | Agent 提炼概念与实体，写入时校验原文引文，保留来源证据与操作记录 |
| 检索与阅读 | 全文搜索、双向链接、知识图谱、沉浸阅读与附件预览 |
| Agent 助手 | 基于资料问答、调研、生成任务看板，也可按计划自动整理与纠错 |
| 自定义首页 | 拖动、调整卡片大小，组合概览、快速问答与灵感入口 |
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

1. **收集资料**：上传到「原始资料」，或在「收集箱」转换、审阅后入库；零散想法用左下角「+」记录。
2. **连接 Agent**：在「设置 → Agent 与自动化」配置内置 Agent 的模型与 Key；使用外部 Agent 时，在「外部接入」生成 Token 并复制 MCP / CLI 配置。
3. **整理与查找**：让 Agent 提炼资料、回答问题；通过搜索、双链和图谱回到原文，或打开任务看板查看待办。

Android 的 Agent 与收集箱转换等能力由已绑定的中枢执行，详见 [Android 指南](./main/docs/ANDROID.md)。

知识正文与原始资料保存在 `brain/`，SQLite 保存索引、配置与证据等元数据。完整迁移请使用「设置 → 知识库数据 → 备份与恢复」。

## 详细文档

| 想了解什么 | 文档 |
|---|---|
| 功能细节、操作方式、数据目录 | [使用指南](./main/docs/USER-GUIDE.md) |
| 安装、构建、Docker / NAS 部署 | [构建与部署](./main/docs/BUILDING.md) · [Windows 桌面端](./main/desktop/README.md) · [Android](./main/docs/ANDROID.md) |
| Agent 接入与写入规范 | [Agent 操作指南](./main/docs/AI-CONTENT-OPERATIONS.md) |
| 多端直连、DDNS 与网络配置 | [网络与直连](./main/docs/IPV6.md) |
| 参与开发与发布 | [开发约定](./main/AGENTS.md) · [Worktree 流程](./main/WORKTREES.md) · [CI 与发布](./main/docs/GITEA-CI.md) |
| 版本变化 | [更新日志](./CHANGELOG.md) |
