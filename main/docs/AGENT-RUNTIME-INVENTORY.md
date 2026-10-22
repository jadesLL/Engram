# 内置 Agent 运行时：dsh 0.2.1-rc.2 升级与「插件 / 设置」清单

> 状态：设计已定稿，实现中（分支 `feat/agent-dsh-021-inventory`）。
> 面向读者：接手本任务的服务端 / 前端同学。

## 1. 背景

内置 Agent（聊天抽屉）由随包依赖 `@deepseek-ai/dsh` 驱动，SDK 客户端是
`@deepseek-ai/dsh-sdk-client`（`main/server/package.json` 精确锁版本）。当前锁在
`0.1.5-rc.2`，设置页只显示 4 行状态（运行时是否随包、模型地址、凭据、工作目录），
用户看不到这个 Agent 到底加载了哪些 dsh 插件、每个插件有哪些设置项、当前值来自哪一层配置。

本任务两件事：
1. 把两个包升到 **0.2.1-rc.2**（含配置层破坏性变更的迁移）；
2. 在设置页把内置 dsh 的**插件清单**与**设置项**完整展示出来（只读）。

## 2. 实测结论（本机 DSH 桌面端 0.2.1-rc.2 运行时探针）

| 项 | 结论 |
|---|---|
| SDK 客户端 API | 0.2.1-rc.2 与 0.1.5-rc.2 的 `types.d.ts` 逐字节相同，构造参数与 `start()/run()/close()` 不变；只新增 `resumeSession()` 等。`dshRuntime.ts` 不需要改调用面。 |
| profile | sdk = bundles `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-sdk-app]`，合成 100 条 loader entry；`--profile sdk` 名字不变。sdk-minimal 是另一套（无 settings、默认 danger-full-access），**不用**。 |
| dump | `dsh --profile sdk --dump-config` → 13.5KB YAML entry 列表（193ms），层来源写在 `# == …` 注释里；`--dump-config-schema` → 610KB JSON Schema（1.7s），`x-cordis.entries[]` 给出每条 entry 的 `configRef`（71 schema / 29 absent），`$defs.configN` 是 Schemastery 转的 JSON Schema（含 default/const/pattern，无 description 文案）。dump **不含版本号**。 |
| 插件版本 | 唯一来源是本机 node_modules 的 package.json（SDK stdio 侧没有 plugin inventory 接口；`pluginInventory.list` 只存在于 web/desktop host profile）。 |
| settings.yaml | 0.2.1 降级为遗留：启动后导入一次并改名 `settings.yaml.imported`；新落盘走 **profile patch**（`$DSH_HOME/profiles/sdk/cordis.patch.yml`）。层序 bundle → profile patch → home patch → `--patch`；patch 的 config **整体替换**。 |
| 兼容性 | 现有 MCP patch（`serverName/transport/url/headers/toolCallTimeoutMs`）在 0.2.1 下完整生效（实测 101 条 entry）。 |
| 默认模型 | 0.2.1 sdk 的 `agent-default-model` 默认 `deepseek-flash`（现有 UI 文案写死的 `deepseek-v4-flash` 要改）。 |

## 3. 目标与非目标

目标：
- 依赖升级到 0.2.1-rc.2，模型路由从「写 settings.yaml」迁移到「写 Engram patch」，老数据可平滑升级；
- 设置页新增「内置 Agent 运行时」分组：版本/指纹、插件清单、设置项、原始 dump（高级）；
- 数据全部来自 dsh 自己的 dump，不在 Engram 里手抄插件清单。

非目标：
- 不在 Engram 里编辑 dsh 的任意设置（只读；模型/Key 仍走现有表单）；
- 不做插件安装/卸载（dsh plugin manager 的能力不暴露）；
- 不改变内置 Agent 的会话/事件/工具协议。

## 4. 配置迁移（破坏性变更处理）

升级后旧机器上 `<数据目录>/dsh/settings.yaml` 会被 dsh 导入一次并改名。为避免"旧值反超新值"：

1. `agentSettings.ts` 不再写 `settings.yaml`，改为把模型路由写成 `engram.cordis.yml` 里的两条 patch：

```yaml
- id: llm-pi-ai
  config:
    providers:
      engram-custom:
        displayName: Engram 自定义地址
        apiKeyEnv: ENGRAM_AGENT_API_KEY
        api: openai-completions
        baseURL: "https://api.example.com/v1"
        models:
          - id: "my-model"
- id: agent-default-model
  config:
    provider: engram-custom
    model: "my-model"
```

2. `engram.cordis.yml` 由「MCP 条目 + 模型路由条目」组成，随 `--patch` 叠加（层序最高，压过 dsh 导入的旧 settings）；
3. 首次启动时清理带本方文件头的遗留 `settings.yaml`（无文件头的用户文件保留，由 dsh 自行导入）；
4. 运行时环境变量注入不变（`DEEPSEEK_API_KEY` / `ENGRAM_AGENT_API_KEY`）。

## 5. 服务端 API 契约

新增模块 `server/src/assistant/agentInventory.ts`；新增路由（均挂 `requireAssistantAccess`，写操作再加 `requireAuth`）：

### GET /api/assistant/inventory

```json
{
  "generatedAt": "2026-10-22T03:41:00.000Z",
  "stale": false,
  "runtime": {
    "dshVersion": "0.2.1-rc.2",
    "sdkClientVersion": "0.2.1-rc.2",
    "profile": "sdk",
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"],
    "home": "…/data/dsh",
    "profileDir": "…/data/dsh/profiles/sdk",
    "patchFile": "…/data/dsh/engram.cordis.yml",
    "engramEntries": ["mcp-engram", "llm-pi-ai", "agent-default-model"]
  },
  "plugins": [
    {
      "entryId": "tool-fs",
      "name": "@deepseek-ai/dsh-tool-fs",
      "shortName": "tool-fs",
      "version": "0.2.1-rc.2",
      "layer": "dsh-base",
      "status": "active",
      "disabled": null,
      "configKeys": ["read", "write", "edit"],
      "config": { "read": true, "write": true }
    }
  ],
  "settings": [
    {
      "entryId": "agent-default-model",
      "plugin": "@deepseek-ai/dsh-agent-default-model",
      "path": "model",
      "type": "string",
      "required": true,
      "default": null,
      "current": "deepseek-flash",
      "source": "bundle",
      "secret": false,
      "volatile": true,
      "description": ""
    }
  ],
  "errors": []
}
```

- `plugins[].layer`：`dsh-base` | `dsh-sdk-app` | `engram` | `user` | `unknown`（来自 dump 的 `# ==` 注释 + 条目归属）；
- `plugins[].status`：`active` | `disabled` | `conditional`（`disabled` 是 `!!js` 表达式）| `absent`（schema 标 absent / 未激活）；
- `plugins[].version`：由 `name` 解析本机 package.json 得到，解析不到为 `null`；
- `settings[].source`：`bundle` | `profile-patch` | `engram` | `env` | `default`；
- `settings[].secret`：schema `x-cordis.role === 'credential-ref'` 或键名命中敏感词；
- 敏感值（Authorization/apiKey/token/secret/password）在服务端一律替换为 `"••••"`，Engram 自己的 MCP token 不回传。

### GET /api/assistant/inventory/raw?kind=config|schema

返回原始 dump 文本（`text/plain`，已脱敏）；用于排障与「高级」页复制/下载。

### POST /api/assistant/inventory/refresh

强制重跑 dump（owner 鉴权），返回同 GET 结构。

### GET /api/assistant/status（扩展）

增加 `agentVersion`（dsh 版本）与 `profile` 字段；不触发 dump。

## 6. 缓存与失效

- 内存缓存 1 份 + 数据目录 `agent/inventory.json` 落盘；
- 失效指纹：dsh 版本 + `engram.cordis.yml` 内容 hash + `profiles/sdk/cordis.patch.yml` 内容 hash + 设置页「刷新」；
- 首次生成懒加载（config 8s / schema 25s 超时），失败时返回上次缓存 + `errors[]`（`stale: true`）；
- 同一时刻只允许一个 dump 任务（in-flight promise 复用）。

## 7. 前端结构

设置 → Agent 与自动化：

```
内置 Agent（聊天抽屉）        ← 保留现有 4 行 + 表单；顶部加一行摘要：
                                dsh 0.2.1-rc.2 · profile sdk · [查看插件与设置]
内置 Agent 运行时             ← 新增分组（anchor: agent-runtime）
  ├─ 指纹条：版本 / profile / bundles / DSH_HOME / patch / 生成时间 / [刷新]
  ├─ Tab 插件清单：搜索 + 按层分组（Engram 注入置顶，随包默认折叠）+ 状态徽标 + 版本
  ├─ Tab 设置：按插件分组表格（键 / 当前值 / 默认值 / 来源 / 说明）；敏感项掩码
  └─ Tab 高级：脱敏原始 dump（等宽、可复制）+ schema 下载
自动整理（梦境思考）…          ← 原顺序不变
```

- 新组件：`web/src/components/settings/AgentRuntimePanel.vue`（可再拆 `AgentRuntimePlugins.vue` / `AgentRuntimeSettings.vue`）；
- 复用 `SettingsGroup / AppSelect / SecretField / Icon / notify`，不新增依赖；
- `settingsDomains.ts` 登记 `agent-runtime`（紧跟 `agent-builtin`），并同步 `SettingsView.vue` 渲染顺序（仓库有顺序守卫测试）；
- 状态：加载中骨架、失败重试、缓存过期提示、空清单文案。

## 8. 测试

服务端：dump 解析（真实 0.2.1 dump 夹具）、schema→设置项归一化、敏感键掩码、缓存指纹失效、
patch 生成（MCP + 模型路由两条 / 关闭自定义地址时回收）、遗留 settings.yaml 清理。

前端：settingsDomains 顺序守卫、inventory 归一化格式化函数单测、面板关键态渲染。

验收：`verify-feature.sh agent-dsh-021-inventory`（Docker，安装 0.2.1 依赖需 `--allow-downloads` 批准）
→ `preview-feature.sh` 隔离预览 → 截图（三 Tab + 聊天实跑一轮）→ 自动合并 main → 清理。
