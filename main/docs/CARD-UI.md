# 卡片系统 v2（2026-11-18）

> 适用：首页看板、任务看板、收集箱卡面。平台影响 `B,C`：Windows 与 Docker 同源，Android 复用同一份 Web 构建；无 Kotlin / 同步协议改动。

## 1. 为什么重做

旧版首页的标准卡（w≥2 且 h≥2）全部走 `HomeAdaptiveSummary` 通用摘要层：真实模块内容（统计条、热力图、待办列表、收集箱文件行）只存在于“展开详情”里。结果是一屏卡片长得一样、内容却只有几行字，留白大且看起来“没有价值”。

v2 把规则反过来：**标准卡渲染模块自己的正文**，摘要只服务放不下正文的小档位。

## 2. 内容档位

| 档位 | 判定 | 卡面内容 |
| --- | --- | --- |
| 磁贴 tile | w=1 且 h=1 | 摘要：状态圆点 / 数值 + 2 字短名 |
| 横条 bar | h=1 | 摘要：左侧结论 / 数值 + 右侧一条最重要信息；`shortcuts` 例外，直接渲染一排名片 |
| 竖条 column | w=1 且 h≥2 | 摘要的竖排版本 |
| 标准 standard | w≥2 且 h≥2 | 真实模块内容（由 `HomeModuleShell` 渲染 `<slot>`） |

实现位置：`web/src/components/HomeModuleShell.vue` 的 `compact` computed。标准卡只有在实际像素小于 `150×130` 时才退回摘要，避免用户把卡拖得过小后正文挤成一团。

横条左栏只留一条文字轴线：图标 / 状态圆点占开头 15px 小栏，标签、数值、说明都从同一条线起排（`HomeAdaptiveSummary` 的 `.tier-bar` 规则；输入卡 `HomeActionComposer` 的 `.bar-lead` 同宽）。不要再让数值或第二行从卡片内边距起排——那会让「0」挂在「收集」左边。

## 3. 手机单列：高度跟内容走

- `HomeBoard` 在 `mobileCanvas`（≤768 或手机编辑态）时给 `.board-grid` 加 `mobile-list`：`display:flex; flex-direction:column`，不再沿用桌面 12 列格高。
- `HomeModuleShell` 收到 `auto-height` 后：
  - `height:auto`；
  - **`container-type` 从 `size` 退回 `inline-size`**。`container-type:size` 自带 size containment，会把没有固定高度的卡片算成 0 高；
  - `.shell-content` / `.module-content` 取消 `flex:1`，`.shell-body` 保持 `flex:1 1 auto` 吃满卡宽。
- 手机编辑态的 ↑ / ↓ / 隐藏按钮不变；编辑态右上角的详情箭头让位（`.shell.managing .shell-expand { display:none }`）。

## 4. 行数预算：卡内不出现滚动条

外壳用 `ResizeObserver` 观察 `.module-content` 的实际高度，通过作用域插槽 `body-height` 传给模块。列表模块按行高换算可显示条数，取 `min(用户设置的 limit, 实际能放下的条数)`：

| 模块 | 行高 |
| --- | --- |
| 最近更新 / 近期灵感 / 本周新增 / 最近改动 / 等待提炼 / 分区导航 | 36px |
| 近期待办 | 49px |
| 常用标签 | 33px（两列） |

这样卡片高度由布局决定，内容只显示完整行，不再出现“最后一行被裁一半 + 内部滚动条”。

## 5. 视觉令牌

在 `web/src/styles/main.css`：

```css
--bg: #f5f3ee;          /* 暖纸底 */
--bg-secondary: #faf8f3;
--bg-tertiary: #f0ede6;
--card-bg: #fffefb;     /* 暖白卡 */
--card-radius: 16px;
--card-line: #e9e5dd;   /* 发丝线 */
--card-line-soft: #f1eee7;
--font-display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", "Songti SC", serif;
--ai: #bf5b3c;          /* 只给 Agent 摘要 / AI 建议 */
```

- 大数字用 `--font-display`（衬线），正文继续系统无衬线；行数值统一等宽数字。
- 卡头 15px 线性图标 + 12.5px 标题，不再画彩色图标块。
- 圆角 16px、1px 发丝线、`--card-shadow` 轻接触阴影；旧的 `#app .shell` 全局覆盖（14px 圆角 / 16×18 内边距）已删除，卡面由组件自己负责。
- 深色主题在 `html.dark` 下另给 `--card-line*` / `--ai*`，其余沿用暗色令牌。

## 6. 低价值卡的重做

- **知识库概览**：衬线大数 + 堆叠比例条 + 三类明细（数量 / 占比）。
- **知识热力**：活跃日 + 热力格 + 日期范围；卡片窄时自动收成 8 周，月份标签不再被右边缘裁掉。
- **运行状态**：2×2 指标格（版本 / 运行形态 / 后台任务 / 多端同步）+ 底部一行运行环境说明。
- **Agent 摘要**：陶土色卡面 + 一句主结论 + 可点击的线索行 + AI 角标。
- **随机漫游**：页面类型、标题、目录、字数、标签，不再只有一行标题。
- **常用标签**：两列排行条（标签名 + 占比 + 计数）。
- **近期待办**：圆形完成位 + 两行标题 + 责任人/客户 + 右对齐日期。

## 7. 验收与护栏

- `web/src/lib/cardUi.test.ts` 锁住：标准卡不被摘要挡住、手机单列 auto-height、`container-type` 退回、暖纸令牌、列表按正文高度限行、低价值卡的数据形状。
- `verify-feature.sh` 通过后，用 `preview-feature.sh` 起隔离预览，分别截 1440 桌面与 390 手机；任务看板/收集箱也在同一份 Web 构建内验证。
- Android 没有 Kotlin 改动；APK 随下次发版复用本次 Web 构建。手机滞后清单无需登记。
