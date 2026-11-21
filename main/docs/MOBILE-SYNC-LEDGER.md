# 手机端同步滞后清单（MOBILE-SYNC-LEDGER）

> **用途**：Windows 主开发的功能里，凡「需要在 Android 端补适配」而本次分支未完成的，必须在此登记；每周巡检与发版门禁都会检查。
> **规则**（完整流程见 [`PLATFORM-PARALLEL-DEV.md`](./PLATFORM-PARALLEL-DEV.md) §5.6）：
> 1. 只有 A/C/D/F 类改动且本次未完成手机侧适配时才登记；B/E/none 不登记。
> 2. 状态只允许：`待办` / `进行` / `完成` / `不适用`。
> 3. 目标版本必须是计划补齐的发版号（如 `v1.5.7`），不允许空。
> 4. 手机侧完成后改「完成」并写提交 hash；确认手机不需要做的改「不适用」并写原因。
> 5. **发版前必须清零**（目标版本 ≤ 本次版本的待办行）；`platformParity.test.ts` 会在 bump 后检查本表。
> 6. 同一行超过 14 天未推进，周检时必须升级处理（拆分 / 排期 / 改为不适用）。

| 日期 | 来源提交 | 类型 | 要补什么 | 手机侧改动点 | 状态 | 目标版本 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19 | feat/asset-owner-repair | A | 图片归属自愈：正文引用别的父项（复制正文 / Agent 转写留下 `/media/<旧id>/…`）时，收编进本页资产目录并改写引用；服务端已在 `writePage` 与启动扫描落地 | Android 侧已在 `e07e6767` 补齐：`LocalDatabase.updatePage` / `writeSyncedPage` / 扫描重新索引的页面都走 `PageAssetAdoption`（复制 `assets/<旧父项id>/` 文件到本页目录、改写引用并保留 `#w=` 与 title），升级后一次性补齐存量页面；`PageAssetAdoptionTest` 覆盖复制 / 幂等 / 源缺失 / HTML src / 写入失败 | 完成 | v1.5.16 | 手机本地服务是同一套资产模型；同步拉回的页面正文已由中枢改写，但手机本机复制正文仍会复现 |
| 2026-11-08 | feat/agent-model-sync | F | 新增 preference 键 `agent_model_config`（内置 Agent 模型配置与相关 Key）与 `video_config`（视频理解开关）的跨端同步 | 无：Android 不跑 dsh、不持有模型 Key，未知 preference key 按现有逻辑跳过；视频提炼与聊天都在中枢执行 | 不适用 | v1.6.x | 见 docs/AGENT-MODEL-SYNC.md「平台影响」与 docs/ANDROID.md「Agent 与自动化配置」 |

（暂无待办；上面一行是确认「不适用」的登记，不算待办。2026-11-21 的 A 类「图片归属自愈」已随 v1.5.16 完成。）

## 历史

| 关闭日期 | 来源提交 | 类型 | 条目 | 关闭方式 | 目标版本 |
| --- | --- | --- | --- | --- | --- |
