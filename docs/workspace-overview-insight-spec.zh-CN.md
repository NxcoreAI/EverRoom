# 工作空间「概览 · 洞察」功能规格（v1 · 待评审）

> 状态：**待评审**（2026-11-03，v1）。本文只定义功能、文案、状态与数据契约，不含排期承诺。
> 范围：产品 `apps/desktop` 工作空间概览页 B 区「洞察」卡（[OverviewPage.tsx](../apps/desktop/src/renderer/src/workbench/workspace/OverviewPage.tsx#L434-L447)）。对齐 `everoffice` 原型（HEAD `d60032e`）的洞察区。
> 上游依据：原型 `WorkspacePages.tsx:57-250` / `workspace.ts:96-146`；产品实现 [activity.ts](../apps/desktop/src/renderer/src/workbench/workspace/activity.ts#L190-L300)；数据地图 [product-data-map.zh-CN.md](design/product-data-map.zh-CN.md) §9；动态方案 [workspace-overview-activity-plan.zh-CN.md](workspace-overview-activity-plan.zh-CN.md)。
> 需要拍板的 8 个决策见 §11.1，每条附推荐值。

---

## 0. 一句话

**概览 B 区的空间级 AI 状态综述**：小 E 用 2–4 行、不超过 240 字的一段话，讲清「这个空间里有什么、卡在哪、下一步建议做什么」，在需要时以一句问话把决定权交回用户。

原型实际渲染（1440×1000 @2x）：

![概览 · 洞察卡（原型实际渲染）](assets/workspace-overview-insight.png)

整页位置见 [概览整页截图](assets/workspace-overview-page.png)：单列三区 = 项目头 / **洞察** / 动态，洞察位于第二区。

---

## 1. 背景：原型验证了什么，产品已有什么

### 1.1 原型已经验证的结论

| 维度 | 原型的做法 | 结论 |
| --- | --- | --- |
| 信息形态 | 一段话，不是指标/列表/chip | 保持。洞察是「助手对你说的一句话」，不是仪表盘 |
| 人格化 | 渐变 AI 徽标 + 「洞察 · 小 E」+ 落款「—— 小 E · 你的工作台助理」 | 保留人格，但标题不写死人格名（见 §11.1 D2） |
| 可解释性 | 副标题「基于本空间 5 项工作与 12 条记忆 · 随工作进展更新」 | 保留「来源计数 + 时效」，但计数必须真实（§8.3） |
| 在场感 | 打字机 2 字/24ms + 光标闪烁，`prefers-reduced-motion` 下直出 | 保留动效能力，默认不每次重播（§11.1 D6） |
| 状态 | 空间无工作时显示「等待第一项工作」引导，隐藏来源与落款 | 保留（P1 落地，§6） |
| 能力裁剪 | 相比主页「每日洞察」，去掉刷新与动作胶囊 | 刷新在 P1 加回（语义改为「重新派生」）；动作胶囊放 P2 |
| 数据 | 单条静态 mock，不随任务变化 | **不迁移**。真实数据必须可派生、可追溯 |

### 1.2 产品现状与差距

| 项 | 产品现状（`OverviewPage.tsx` / `activity.ts`） | 差距 |
| --- | --- | --- |
| 数据源 | 本空间最近更新会话 → `agent.getSession` 取最后一条 assistant 正文；快照无正文时用 run 事件兜底 | ✅ 已可派生，保留为 P0 主路径 |
| 文本规整 | 去 Markdown 噪音、≤4 行 / ≤240 字、超长加省略号 | ✅ 直接复用 |
| 状态 | `loading` = spinner，`empty`/失败 = **整卡不渲染** | 缺 no-content / updating / error 语义与空态引导 |
| 展示 | 徽标「洞察」+ 正文；无来源行、无落款、无刷新、无动效 | 补齐信息层级（来源/落款/更新中） |
| 空间隔离 | 会话由渲染层按 `workspaceId` 内存过滤；`listSessions` 桥未传 workspaceId | 需透传（网关已支持，§8.5） |
| 隔离/兜底 | 无桥时静默为空，不造 mock | ✅ 保持，写入不变量（§6.4） |
| 与动态关系 | 动态默认不产出 `insight` 行 | ✅ 保持（见动态方案 §7） |

**结论**：产品已有可靠的「真实数据 → 一段话」管线；本规格要补的是**信息层级、状态机、文案约束与可解释字段**，而不是另起一套生成系统。

---

## 2. 目标与非目标

### 2.1 目标

1. 用户进入空间概览 3 秒内知道：**这个空间在发生什么、有没有需要我拍板的事**。
2. 洞察文本 **100% 可追溯到真实会话**：能回答「这话从哪来的」，且不跨空间。
3. 状态完整：无工作、加载中、运行更新中、失败、无内容都有明确表现，不出现空白卡或 mock 文案。
4. 文案质量可验收：长度、结构、语气、禁用项可自动校验。

### 2.2 非目标

- 不做「每日洞察 / 定时洞察」：主页每日洞察不在本次范围（且已按 [tabs-workbench](design/tabs-workbench.zh-CN.md) 决定不迁移）。
- 不做多条洞察、已读/忽略、确认写回画像。
- 不新增洞察实体表（除非触发 §8.6 的建表条件且评审通过）。
- 不在 P0 引入 LLM 调用：P0/P1 的「洞察」是对既有会话内容的**二次呈现**，不是新生成。

---

## 3. 能力范围与分期

| # | 能力 | 定义 | 阶段 | 验收 |
| --- | --- | --- | --- | --- |
| 1 | 真实文本派生 | 取本空间最近更新会话的最后一条 assistant 正文（事件流兜底），规整后展示 | P0 | §10 AC-1/2/3/4 |
| 2 | 状态机 | `unavailable/empty/no-content/loading/ready/updating/error` 七态 P0；`refreshing` 随 P1 刷新启用 | P0 | §10 AC-5~9 |
| 3 | 来源行 | 「基于本空间 N 项工作与 M 个文件 · 更新于 X」；计数真实，缺数据则省略分句 | P0 | AC-2/10 |
| 4 | 空态引导 | 无工作 / 无内容两种空态，各有一句「怎么才会有」的说明 | P1（P0 暂不渲染卡） | AC-1、AC-4 |
| 5 | 落款 | 「—— 小 E · 你的工作台助理」+ 分隔线 | P1 | 视觉走查 |
| 6 | 刷新 | 重新派生（不调模型），保留正文直至新文本就绪 | P1 | AC-11 |
| 7 | 证据展开 | 点来源行展开「这条洞察来自：工作《X》（跳会话）」 | P1 | AC-12 |
| 8 | 运行中提示 | 会话运行中保留旧文本 + 角标「小 E 正在更新…」，run 结束自动刷新 | P1 | AC-6 |
| 9 | 推荐动作 | 1–2 枚动作胶囊（打开会话/文件/计划项，或「让小 E 再做一版」= 生成 run） | P2 | 需 D4 决策 |
| 10 | 生成式洞察 | 由 Agent run 产出一段新洞察（计费/配额/提示词约束） | P2 | 需 D4 决策 |
| 11 | 历史 / 确认 / 忽略 | 多条、可确认、可稍后 | P2 | 触发建表条件，见 §8.6 |
| 12 | i18n | 文案抽 key，支持 en-US | P2 | §5.6 |

> P0 是「把现状做对」：状态机 + 来源行（真实计数）+ 不造 mock + 测试；P1 是「补齐原型的信息层级」；P2 才涉及新生成能力。

---

## 4. 信息架构与视觉规格

### 4.1 结构与层级

```
<section aria-labelledby="wb-ov-insight-heading">   ← 一张卡，位于项目头之后、动态之前
  ├─ header
  │   ├─ badge「洞察」 (Sparkles + 文字，accent 软底，胶囊)
  │   ├─ [P1] 运行中角标「小 E 正在更新…」
  │   └─ [P1] 刷新按钮（hover 露出，或常驻 ghost 小按钮）
  ├─ 正文 <p>：2–4 行，≤240 字；loading 时被 3 行骨架占位
  ├─ [P0] 来源行：基于本空间 N 项工作与 M 个文件 · 更新于 2 小时前
  └─ [P1] footer：分隔线 + 「—— 小 E · 你的工作台助理」右对齐
```

### 4.2 视觉规格（对齐产品 token）

| 元素 | 规格 | Token |
| --- | --- | --- |
| 卡片 | `padding: 16px 18px`；`border: 1px solid`；`border-radius: var(--ui-radius-lg)`；`background: var(--ui-surface)` | `--ui-border` / `--ui-radius-lg` / `--ui-surface` |
| 卡间距 | 与项目头、动态卡垂直间距 24px（沿用概览页 `gap`） | — |
| 徽标 | 胶囊，`padding: 3px 10px`，`border-radius: var(--ui-radius-full)`，`background: var(--ui-accent-soft)`，`color: var(--ui-accent-strong)`，字号 `--ui-text-2xs`，字重 650，图标 `Sparkles` 13px（`aria-hidden`） | `--ui-accent-soft` / `--ui-accent-strong` |
| 正文 | `font-size: var(--ui-text-base)`；`line-height: var(--ui-leading-relaxed)`；`color: var(--ui-text-2)`；`white-space: pre-line`；`overflow-wrap: anywhere`；`max-width: 78ch` | `--ui-text-base` 等 |
| 来源行 / 落款 | `--ui-text-xs`，`color: var(--ui-text-3)`；落款右对齐，上方 1px 分隔线 | 同上 |
| 骨架 | 3 行，行高与正文一致，`--ui-hover` 色块，`prefers-reduced-motion` 下不闪烁 | `--ui-hover` |
| 运行中角标 | 文案 12px，`color: var(--ui-text-3)`；可选一个 8px 呼吸圆点，`prefers-reduced-motion` 下静态 | — |

> 原型用的是裸色值（`#9b7ce8 → #6d4bd0` 渐变、`rgba(0,0,0,.06)` 边框）；**落地一律走产品 token**，不照抄 hex。原型渐变 AI 徽标可作为 P1 视觉升级项（与主页洞察卡共用组件时再定）。

### 4.3 响应式

- 宽度 < 720px：徽标与刷新按钮同一行，来源行可换行；正文不做截断（靠字数上限自然收敛）。
- 侧栏展开/收起、窗口挤压时不跳版；正文最小高度按 3 行预留，避免状态切换时页面抖动。

---

## 5. 文案规范

### 5.1 写作公式

一段话，最多三句，按「盘点 → 判断 → （可选）提议」组织：

1. **盘点**（1–2 句）：按状态分组，不按时间罗列。分组词建议：`等你审阅 / 等你拍板 / 进行中 / 已完成 / 还没开始`。
2. **判断**（1 句）：一条明确建议，带取舍依据（数字、交期、优先级）。
3. **提议**（0–1 句）：以问句结尾，把决定权交回用户；只在「小 E 确实能接着做」时使用。

### 5.2 硬约束（可自动校验）

| # | 约束 | 校验方式 |
| --- | --- | --- |
| C1 | 正文 ≤240 字、≤4 行（与 `normalizeInsightText` 口径一致） | 单测 + 运行时截断 |
| C2 | 推荐 80–180 字；少于 40 字必须能独立成句（不允许「暂无。」这类占位） | 单测断言下限 |
| C3 | 最多 3 句；问句最多 1 个，且必须位于末句 | 正则计数 |
| C4 | 不出现 Markdown 控制语法：行首 `#`/`-`/`*`/`>`/数字编号、`**加粗**`、`` `代码` ``、表格竖线、行内链接/图片语法（正文中的「」《》与破折号允许） | 正则校验 |
| C5 | 不出现代码块、URL、emoji、感叹号、`$`/`{{}}` 等模板占位符 | 黑名单校验 |
| C6 | 人称：对用户称「你」；对助手称「我」或「小 E」。禁止「本 AI / 本系统 / 作为助手」 | 黑名单 |
| C7 | 数字只能来自真实数据（计数、金额、日期）；不确定的量必须省略，禁止「一些/若干/多个」凑数 | 生成侧约束 + 抽查 |
| C8 | 时间只用相对表达（今天/昨天/本周/刚刚）；不出现 `2026-11-03` 式绝对时间戳 | 正则 |
| C9 | 工作/文件/计划项名称用「」包裹；不出现 id、路径、运行时名、内部代号 | 抽查 |
| C10 | 不使用营销/套话词：赋能、闭环、抓手、沉淀、复用、助力、全面提升、稳步推进、继续保持 | 黑名单 |
| C11 | 不写免责/谦虚声明：希望对你有帮助、仅供参考、如有需要请告诉我 | 黑名单 |
| C12 | 不做完成承诺（「今天会完成」），除非引用计划项的截止时间且注明来源 | 抽查 |

### 5.3 正反例

**正例**（原型文案，P0 可派生形态）：

> 这个空间里有 5 项工作：周报草稿在等你审阅，供应商比价卡在交期取舍，V1 发布计划已完成。建议先把比价口径定下来——启明互联贵 6.7 万但交期最短，要不要我按「交期优先」再出一版对比？

**反例 1（结构错误）**：把洞察写成列表

> ## 本周进展
> - 周报：待审
> - 比价：阻塞

**反例 2（编造数据）**：

> 今天完成了 3 项工作，预计 18:00 全部收尾。

（除非数据来自真实会话/计划项，否则不得出现。）

**反例 3（空话）**：

> 本空间整体进展顺利，各项工作稳步推进，继续保持。

**反例 4（越权承诺）**：

> 我已经把比价表发给了采购部，明天会跟进。

（只描述现状与建议，不宣称已执行未发生的动作。）

### 5.4 系统文案表

| id | 场景 | 文案（zh-CN） | 阶段 |
| --- | --- | --- | --- |
| `title` | 徽标 | 洞察 | P0（沿用） |
| `source.worksFiles` | 来源行，有工作有文件 | 基于本空间 {workCount} 项工作与 {fileCount} 个文件 · {updatedLabel} | P0 |
| `source.worksOnly` | 只有工作计数 | 基于本空间 {workCount} 项工作 · {updatedLabel} | P0 |
| `updated.relative` | 时效 | 更新于 {相对时间}（如「更新于 2 小时前」） | P0 |
| `updated.justNow` | 刚刚派生 | 刚刚更新 | P0 |
| `updating.badge` | 运行中 | 小 E 正在更新… | P1 |
| `empty.noWorks.title` | 空间无工作 | 等待第一项工作 | P1 |
| `empty.noWorks.body` | 空间无工作 | 空间刚建好。第一项工作落成后，小 E 会在这里汇总进展、给出建议。 | P1 |
| `empty.noContent.body` | 有会话但无可归纳正文 | 小 E 还没有可汇总的内容——等第一次工作跑完，这里会自动出现。 | P1 |
| `error.retry` | 无缓存且失败 | 洞察暂时不可用，稍后重试 | P1 |
| `refresh.label` | 刷新按钮 aria-label | 重新获取洞察 | P1 |
| `refresh.toast` | 刷新成功 | 洞察已更新 | P1 |
| `evidence.title` | 证据浮层标题 | 这条洞察来自 | P1 |
| `footer` | 落款 | —— 小 E · 你的工作台助理 | P1 |

> 「等待第一项工作」直接沿用原型；其余为新增。表中的 `{updatedLabel}` 由 `updated.relative` / `updated.justNow` 生成（相对时间），不单独维护。**任何状态都不允许出现技术词**（接口、超时、bridge、session），一律降级为「暂时不可用」。

### 5.5 生成式洞察的提示词约束（仅 P2）

若走 P2「让小 E 再想想」生成新洞察，系统提示词必须包含 C1–C12 的等价约束，并附输出格式：**只输出正文一段话，不输出标题、列表、引用**。服务端仍用 `normalizeInsightText` 做二次兜底。

### 5.6 i18n 约定

当前 workbench 页面文案硬编码 zh-CN。P2 迁移时统一 key 前缀：

```
workbench.workspace.overview.insight.title
workbench.workspace.overview.insight.source.worksFiles   // {workCount} / {fileCount} / {updatedLabel}
workbench.workspace.overview.insight.updated.relative
workbench.workspace.overview.insight.updating
workbench.workspace.overview.insight.empty.noWorks
workbench.workspace.overview.insight.empty.noContent
workbench.workspace.overview.insight.error.retry
workbench.workspace.overview.insight.refresh
workbench.workspace.overview.insight.footer
```

迁移前不得在组件里拼英文/中文混排；文案表（§5.4）是唯一来源。

---

## 6. 状态机

### 6.1 状态定义

| 状态 | 进入条件 | 卡片表现 | 数据 |
| --- | --- | --- | --- |
| `unavailable` | 无 `window.nxcore.agent` 或 `getSession` 缺失 | **不渲染**（不占位、不 mock） | — |
| `empty` | 本空间会话数 = 0 | P0 不渲染；P1 显示空态卡（`empty.noWorks.*`） | `stats.workCount = 0` |
| `loading` | 已选定目标会话、首次取文本中（无缓存） | 卡存在：徽标 + 3 行骨架；不显示来源行 | — |
| `no-content` | 目标会话无任何可归纳 assistant 正文 | P0 不渲染；P1 空态正文（`empty.noContent.body`） | `origin` 可为空 |
| `ready` | 有文本且 `origin.sourceUpdatedAt == latestSession.updatedAt`，且无 running 会话 | 正文 + 来源行「更新于 X」 | 完整 |
| `updating` | 有文本，但 `latestSession.status == 'running'` 或 `updatedAt > origin.sourceUpdatedAt` | 正文（旧）+ 角标「小 E 正在更新…」；后台重取 | 保留旧 `text` |
| `refreshing` | 后台重新派生中：手动刷新（P1）或产物落盘触发 | 正文保留；手动触发时按钮转圈并拒绝二次点击，后台触发时无额外视觉 | 保留旧 `text` |
| `error` | 取文本失败/超时 | 有缓存 → 落回 `ready` 并静默（只埋点）；无缓存 → P0 不渲染，P1 显示 `error.retry` | `error.code` |

`error.code` 枚举：`bridge-unavailable` / `session-fetch-failed` / `timeout` / `no-assistant-message`。

### 6.2 状态转移

| # | 触发 | 转移 | 副作用 |
| --- | --- | --- | --- |
| T1 | 挂载 / 切到本空间 | `* → loading`（有桥）或 `* → unavailable`（无桥） | 清空上一空间文本与 `origin`（防串台） |
| T2 | `sessions.length === 0` | `loading → empty` | `stats.workCount = 0` |
| T3 | `getSession` 成功且有正文 | `loading → ready` | 记录 `origin`（sessionId/messageId/runId/sourceUpdatedAt） |
| T4 | `getSession` 成功但无正文 | `loading → no-content` | 记录本次抓取时间，避免循环重取 |
| T5 | `getSession` 失败 / 超时（8s） | `loading → error` | 重试 ≤2 次（1s / 3s 退避）；有缓存则回 `ready` |
| T6 | `sessionsSignature` 变化（含 run 结束、会话更新） | `ready → updating` | 保留正文；800ms 去抖后重新派生 |
| T7 | 运行中会话 `status` 变为非 running | `updating → loading`（后台）`→ ready` | 刷新完成后角标消失 |
| T8 | 产物落盘事件（`office.onAgentFile` `done/edited` 且命中本空间） | `ready → refreshing`（后台，无按钮转圈）`→ ready` | 800ms 去抖，合并多次事件 |
| T9 | 点「刷新」（P1） | `ready/updating → refreshing（手动）→ ready` | 重新派生，不调模型；toast「洞察已更新」 |
| T10 | 切换空间 / 卸载 | `* → 取消` | 丢弃 inflight 结果（`cancelled` 标记），不得回写新空间 |
| T11 | 计划项变更（P2） | `ready → refreshing → ready` | 仅在洞察引用计划项时触发 |

> 「会话运行中」不走 `loading`：把已有正文藏起来再转圈会让用户误以为内容丢失。运行中一律保留旧文本 + 角标（T6/T7）。

### 6.3 状态机图

```
  ┌──────────────┐
  │ unavailable  │ ◀── 无桥 / 能力缺失（不渲染）
  └──────────────┘

  挂载 / 切到本空间
          │
          ▼
       loading ──── 无会话 ────────────────▶ empty        （P1 空态卡）
          ├──────── 有正文 ────────────────▶ ready
          ├──────── 无正文 ────────────────▶ no-content   （P1 空态卡）
          └──────── 失败 / 超时(无缓存) ───▶ error        （P0 不渲染 / P1 可重试）

       ready ─── 会话更新 / run 中 ─────────▶ updating     ── 取到新文本 ──▶ ready
         │
         └────── 手动刷新(P1) / 产物落盘 ───▶ refreshing   ── 取到文本 ───▶ ready

  任何状态下有缓存时的失败 → 静默保持 ready，不进入 error
```

### 6.4 不变量（必须写进代码与测试）

1. **单飞**：同一 `workspaceId` 同时最多 1 个 inflight 派生；重复触发复用同一个 Promise。
2. **防串台**：切换空间立即清空 `text/origin`；inflight 结果按 `workspaceId` 校验后才允许写入。
3. **禁止 mock**：任何失败/无桥路径都不得注入固定文案；空态文案必须来自 §5.4 文案表。
4. **只读本空间**：`session.workspaceId` 必须等于当前空间（P0 渲染层校验；P1 服务端过滤）。
5. **幂等**：`normalizeInsightText` 对同一输入输出稳定；派生不修改输入数据。
6. **不阻塞首屏**：洞察加载不得阻塞项目头/动态渲染。
7. **超时**：单次 `getSession` 8s 超时；连续失败后进入冷却（60s 内不再自动重试），仅手动刷新可重启。

---

## 7. 交互规格

| # | 交互 | 规则 | 阶段 |
| --- | --- | --- | --- |
| I1 | 正文 | 纯阅读；可选中复制；不响应点击 | P0 |
| I2 | 打字机 | 首次进入空间播放（2 字/24ms，结束后光标消失）；再次进入不重播；`prefers-reduced-motion` 直出全文 | P1（D6） |
| I3 | 刷新 | 图标按钮，hover 显示；`refreshing` 时禁用；成功后 toast「洞察已更新」；失败静默（埋点） | P1 |
| I4 | 来源行 | 可点击展开证据浮层：标题「这条洞察来自」+ 会话行（标题 + 相对时间，点击跳会话）；Esc/点外关闭 | P1 |
| I5 | 动作胶囊 | 最多 2 枚，顺序固定；点击即执行（打开会话/文件/计划项或发起生成 run），不弹二次确认 | P2 |
| I6 | 运行中角标 | 只提示，不可点；run 结束后自动消失 | P1 |
| I7 | 空态 | 不含 CTA 按钮（避免与项目头「＋ 新建工作」重复）；P1 可考虑弱化的「新建工作」文字链 | P1 |

### 7.1 无障碍

- 卡片 `section` + `aria-labelledby` 指向徽标文字；装饰性图标 `aria-hidden`。
- 打字机：视觉节点 `aria-hidden`，给正文容器 `aria-label` 提供完整文本，避免读屏逐字播报；动画结束后 `aria-live="polite"` 播报一次（按 D6）。
- 刷新按钮必须有 `aria-label`（§5.4 `refresh.label`）；禁用态用 `aria-disabled`，不用 `disabled` 丢焦点。
- 正文对比度 ≥ 4.5:1；骨架屏不加过渡动画当 `prefers-reduced-motion` 生效。

---

## 8. 数据与字段约定

### 8.1 派生架构

```
AgentSession[]（本空间）
        │  latest = updatedAt 最大
        ▼
agent.getSession(latest.id) ──► messages[] ──► extractInsightText ──► normalizeInsightText
        │ activeRun 存在且无正文                     │
        ▼                                            │
agent.getEvents(sessionId, runId, 0) ── insightTextFromEvents ──┘
                                                     ▼
文件库（本空间，可选计数） ────────────────► WorkspaceInsight（ViewModel）
```

- **P0/P1 由渲染层派生**（沿用现有 [useWorkspaceInsight](../apps/desktop/src/renderer/src/workbench/workspace/OverviewPage.tsx#L556-L608)），不新增后端接口。
- **P2 若需要服务端聚合或生成**，再按 §8.5 的契约加接口；在此之前不得为洞察建表。

### 8.2 输入源与字段

| 输入 | 现有通道 | 用到字段 | 备注 |
| --- | --- | --- | --- |
| 会话列表 | `agent.listSessions(pageLabel?, roomId?)` | `id/workspaceId/title/status/updatedAt` | 目前渲染层内存过滤 workspace；P1 透传 workspaceId（§8.5） |
| 会话快照 | `agent.getSession(sessionId)` → `AgentSessionSnapshot` | `session`、`activeRun`、`messages[]`（`role/content/id/runId/createdAt`） | 只取「最近更新」的 1 个会话 |
| 运行事件 | `agent.getEvents(sessionId, runId, afterSeq)` | `type`、`payload.content`、`payload.delta` | 仅快照无正文时兜底 |
| 文件库 | `useFileLibrary(workspaceId)`（`files.list`，`limit` 分页） | `state`、`total`（全量计数） | 只用于来源计数，不参与文本；`state !== 'ready'` 时省略计数 |
| 计划项 | `plan:*`（P2） | `id/title/status` | 仅 P2 证据/动作 |

### 8.3 目标 ViewModel

```ts
/** 洞察卡状态：与 §6.1 一一对应。 */
export type WorkspaceInsightStatus =
  | 'unavailable'   // 无桥/能力缺失 → 不渲染
  | 'empty'         // 本空间无工作
  | 'loading'       // 首次取文本
  | 'no-content'    // 有会话但无可归纳正文
  | 'ready'         // 文本新鲜
  | 'updating'      // 文本可用但后台在更新
  | 'refreshing'    // 后台重新派生中（手动刷新 P1 / 产物落盘触发）
  | 'error'         // 取文本失败

/** 文本出处：用于证据浮层、埋点、排障；不直接展示给用户。 */
export interface WorkspaceInsightOrigin {
  sessionId: string
  /** 被采纳的那条 assistant 消息；事件流兜底时为 null。 */
  messageId: string | null
  /** 事件流兜底时命中的 run；消息快照命中时为 activeRun?.id ?? null。 */
  runId: string | null
  /** 本轮抓取时间（ISO）。 */
  capturedAt: string
  /** 来源会话的 updatedAt（ISO），用于判断新鲜度与展示「更新于」。 */
  sourceUpdatedAt: string
}

/** 来源统计：只用真实数据源；缺数据的字段必须缺省，禁止编造。 */
export interface WorkspaceInsightStats {
  /** 本空间会话数。必填。 */
  workCount: number
  /** 本空间文件数；文件库未就绪时缺省 → 来源行省略该分句。 */
  fileCount?: number
  /** 无空间维度数据源，本版恒缺省；禁止用全局记忆数凑数。 */
  memoryCount?: number
}

export interface WorkspaceInsight {
  workspaceId: string
  status: WorkspaceInsightStatus
  /** 正文：ready/updating 时必填；2–4 行、≤240 字（已过 normalize）。 */
  text: string | null
  origin: WorkspaceInsightOrigin | null
  stats: WorkspaceInsightStats
  /** 展示用时效 = origin.sourceUpdatedAt；null 表示尚未成功派生。 */
  updatedAt: string | null
  /** 失败详情：仅内部/埋点，不直接展示。 */
  error: { code: 'bridge-unavailable' | 'session-fetch-failed' | 'timeout' | 'no-assistant-message'; message?: string } | null
}
```

**字段约束表**

| 字段 | 必填 | 约束 | 缺省行为 |
| --- | --- | --- | --- |
| `workspaceId` | ✅ | 非空，等于当前空间 | 不成立时整卡 `unavailable`（防串台） |
| `status` | ✅ | 枚举（§6.1） | — |
| `text` | ready/updating 时 ✅ | 非空白、≤240 字、≤4 行、无控制字符 | 其他状态 `null` |
| `origin.sessionId` | ready/updating 时 ✅ | 属于当前空间 | 无则视为 `error` |
| `origin.messageId` / `runId` | 至少 1 个 | 事件兜底时 `messageId=null` | — |
| `origin.capturedAt` | ✅ | ISO 8601 | — |
| `origin.sourceUpdatedAt` | ✅ | ISO 8601，来自会话 | — |
| `stats.workCount` | ✅ | ≥0 整数，= 本空间会话数 | — |
| `stats.fileCount` | ❌ | ≥0 整数；文件库未就绪必须缺省 | 来源行省略「与 M 个文件」 |
| `error.code` | error 时 ✅ | 枚举 | 其他状态 `null` |

> **与原型 mock 的映射**：原型 `workspaceInsight.{speaker,text,source,updatedLabel}` 中，`speaker` 固定为「小 E」（产品侧写死文案，不进数据）、`text` → `WorkspaceInsight.text`、`source` → 由 `stats` 渲染、`updatedLabel` → 由 `updatedAt` 渲染相对时间。原型「12 条记忆」**不允许**映射为 `memoryCount`（无数据源）。

### 8.4 派生算法（伪代码）

```ts
async function deriveWorkspaceInsight(workspaceId, sessions, files): Promise<WorkspaceInsight> {
  const scoped = sessions.filter(s => s.workspaceId === workspaceId)
  if (scoped.length === 0) return { status: 'empty', stats: { workCount: 0 }, ... }

  const latest = scoped.reduce((a, b) =>
    Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a)          // 平手：createdAt 大者，再平手：id 字典序

  const snapshot = await withTimeout(agent.getSession(latest.id), 8000)
  const detail = extractInsightDetail(snapshot.messages ?? [])           // 倒序找最后一条非空 assistant，返回 {text, messageId}
  let text = detail?.text ?? null
  let messageId = detail?.messageId ?? null
  let runId = snapshot.activeRun?.id ?? null
  if (!text && snapshot.activeRun) {
    const events = await agent.getEvents(latest.id, snapshot.activeRun.id, 0)
    text = insightTextFromEvents(events ?? [])                           // message.completed 优先，其次 delta 拼接
    messageId = null
  }
  if (!text) return { status: 'no-content', origin: originOf(...), stats: {...}, ... }

  return {
    status: latest.status === 'running' ? 'updating' : 'ready',
    text,
    origin: { sessionId: latest.id, messageId, runId, capturedAt: nowIso(),
              sourceUpdatedAt: latest.updatedAt },
    stats: { workCount: scoped.length, ...(files.state === 'ready' ? { fileCount: files.total } : {}) },
    updatedAt: latest.updatedAt,
  }
}
```

**必须保留的规整规则**（已有实现，不改口径）：

1. 丢掉代码块（``` 围栏内）、空行、`---`/表格分隔线/纯 HTML 行；
2. 去标题 `#`、引用 `>`、列表符号、链接/图片语法、行内 `*_`~；
3. 最多 4 行；首行之外累计超过 240 字即截断，末尾补「…」；
4. 规整后为空 → 返回 `null`（走 `no-content`）。

**新鲜度判定**：`ready` 要求 `Date.parse(latest.updatedAt) <= Date.parse(origin.sourceUpdatedAt)` 且 `latest.status !== 'running'`；否则 `updating`。

### 8.5 接口 / 桥契约

| 能力 | 现状 | 目标（阶段） |
| --- | --- | --- |
| 按空间列会话 | 网关 `GET /v1/agent/sessions` 已支持 `workspaceId`（[routes.ts](../apps/gateway/src/modules/agent/routes.ts#L295-L311)）；preload/bridge 未透传，渲染层内存过滤 | **P1**：`preload.agent.listSessions(pageLabel?, roomId?, workspaceId?)`；bridge 透传 query 参数。第三参可选，旧调用行为不变 |
| 取会话快照 | `agent.getSession(sessionId)` ✅ | 不变 |
| 取 run 事件 | `agent.getEvents(sessionId, runId, afterSeq)` ✅ | 不变 |
| 聚合洞察 | 无（渲染层派生） | **P2 可选**：`GET /v1/agent/workspaces/:id/insight` 返回 §8.3 ViewModel 同形 JSON；仅当需要服务端计数/证据/生成时新增 |
| 生成洞察 | 无 | **P2 可选**：走现有 `agent.startRun(sessionId, input)`（底层 `POST /v1/agent/sessions/:sessionId/runs`，计费/权限/配额沿用），不新增表；input 带专用洞察指令 |

> P2 聚合接口上线后，渲染层只做展示与缓存，不再自行 `getSession`；在此之前保持 P0/P1 的客户端派生。

### 8.6 持久化边界（默认不建表）

遵守 [product-data-map §9](design/product-data-map.zh-CN.md)「动态/洞察是派生数据，不要为它们建表」。只有同时满足以下**两个及以上**条件才允许评审新表（`workspace_insights` + route）：

1. 需要历史多条洞察或「查看上一条」；
2. 需要用户确认/忽略/稍后（状态需持久化）；
3. 需要服务端定时预生成以降低首屏延迟（>1s 不可接受时）；
4. 需要跨设备一致（桌面端之外还要出现）。

新表最小字段（仅评审用，勿提前实现）：`id/workspace_id/text/origin_session_id/origin_message_id/status/created_at/dismissed_at`。

### 8.7 缓存、刷新与成本

| 项 | 规则 |
| --- | --- |
| 缓存位置 | 渲染层 `Map<workspaceId, WorkspaceInsight>`（内存），随空间卸载可回收 |
| TTL | 60s；`sessionsSignature` 变化即失效 |
| 失效触发 | 会话 `updatedAt/status` 变化、产物落盘事件、手动刷新、（P2）计划项变更 |
| 去抖 | 连续触发合并为 800ms 一次 |
| 成本 | 每次派生 = 1× `getSession`（+0–1× `getEvents`），**不调 LLM、不计费** |
| 失败策略 | 超时 8s、最多 2 次重试（1s/3s）、失败冷却 60s；有缓存则继续展示旧文本 |
| P2 生成 | 手动生成限流：每空间 10 分钟 1 次；界面明确「由小 E 重新生成」并提示耗时 |

---

## 9. 可观测与埋点

| 事件 | 触发 | 关键属性 |
| --- | --- | --- |
| `insight_impression` | 卡片实际渲染 | `workspace_id`(hash)、`status`、`text_length`、`truncated`、`source_session_id`(hash) |
| `insight_refresh_click` | 点刷新（P1） | `from_status` |
| `insight_evidence_open` | 展开证据（P1） | `origin.kind` |
| `insight_action_click` | 点动作（P2） | `action_id`、`index` |
| `insight_error` | 进入 error/unavailable | `code`、`has_cache` |
| `insight_latency_ms` | 派生完成 | `duration_ms`、`has_events_fallback` |

**健康指标**：`unavailable` 率、`error` 率、`no-content` 率、`updating` 平均持续时长、p90 派生耗时、文本截断率（`truncated=true` 占比）。若截断率 >30%，重新评审 §11.1 D5（上限放宽或提供展开）。

---

## 10. 验收标准

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-1 | 空间无工作 | 打开概览 | P0：不渲染洞察卡；P1：显示「等待第一项工作」空态，无来源行、无落款 |
| AC-2 | 空间 3 个工作，最近会话有 assistant 正文 | 打开概览 | `ready`；正文 = 规整后文本；来源行显示「基于本空间 3 项工作[与 M 个文件] · 更新于 X」 |
| AC-3 | 最近会话快照无正文，但有 `activeRun` 事件 | 打开概览 | 用事件内容兜底；`origin.messageId=null`，`runId` 非空；埋点 `has_events_fallback=true` |
| AC-4 | 最近会话无任何 assistant 正文、无 run | 打开概览 | P0：不渲染；P1：`no-content` 空态文案；不出现「暂无」类占位 |
| AC-5 | 无 `window.nxcore.agent` | 打开概览 | `unavailable`，不渲染，不注入 mock；无控制台报错 |
| AC-6 | 最新会话运行中且有旧正文 | 打开概览 | 展示旧正文 + 「小 E 正在更新…」；run 结束后 ≤2s 自动刷新为 `ready` |
| AC-7 | 派生中切换空间 | 立即切换 | 新空间不显示旧空间文本；旧请求结果被丢弃 |
| AC-8 | `getSession` 超时 | 等待 8s | 有缓存 → 保持旧文本、静默、埋点 `insight_error`；无缓存 → P0 不渲染 / P1 显示重试态 |
| AC-9 | 文本超 240 字或 4 行 | 派生 | 按规则截断并补「…」；不出现半截 Markdown/列表 |
| AC-10 | 文件库未就绪 | 打开概览 | 来源行省略「与 M 个文件」，不得显示 0 或猜测值 |
| AC-11 | 卡片 ready | 点刷新（P1） | 按钮转圈并禁用；完成后 toast「洞察已更新」；正文可能不变（派生幂等） |
| AC-12 | 点来源行（P1） | — | 展开证据浮层，显示来源会话标题 + 时间；点击跳到该会话；Esc 关闭 |
| AC-13 | `prefers-reduced-motion: reduce` | 打开概览 | 无打字机/骨架闪烁，全文直出 |
| AC-14 | 读屏 | 打开概览 | 正文只播报一次完整文本，不逐字播报 |
| AC-15 | 5000 字会话正文 | 派生 | p90 派生耗时 <300ms（不含网络）；主线程无长任务 >50ms |
| AC-16 | 文案样本 20 条 | 跑校验脚本 | C1–C12 全通过；黑名单 0 命中 |

**测试落点**：

- `activity.test.ts`（新增）：`normalizeInsightText` 边界（围栏/表格/链接/超长/空）、`extractInsightText` 倒序与 role 过滤、`insightTextFromEvents` completed/delta 优先级。
- `insight.test.ts`（新增）：选会话（平手规则）、空间过滤、新鲜度判定、错误码、缓存失效。
- `OverviewPage.insight.test.tsx`（新增）：7 态 + `refreshing` 的渲染快照与状态转移（假 bridge）。
- 文案校验脚本：对 §5.4 系统文案与样例正文跑 C1–C12。

---

## 11. 风险与开放问题

### 11.1 待拍板决策（每条附推荐）

| # | 问题 | 选项 | 推荐 | 影响 |
| --- | --- | --- | --- | --- |
| D1 | 无工作时是否显示空态卡 | A 隐藏（产品现状）/ B 显示引导（原型） | **B（P1）**：原型已验证引导价值；P0 先保持隐藏避免空卡噪声 | 首页信息密度 |
| D2 | 标题是否写人格名 | A「洞察」/ B「洞察 · 小 E」 | **A + 落款署名**：品牌/人格名可能调整，标题保持功能名 | 文案、i18n |
| D3 | 最近会话无正文时是否回溯旧会话 | A 不回溯（如实空态）/ B 回溯最近有正文的会话 | **A**：回溯会把旧结论当现状，误导性大于收益 | 数据正确性 |
| D4 | 「刷新」语义 | A 重新派生 / B 调 Agent 重新生成 | **A（P1）**；B 放 P2 并改名「让小 E 再想想」 | 成本、延迟、预期 |
| D5 | 240 字 / 4 行上限 | A 保持 / B 放宽到 6 行 320 字 | **A 先保持**，看 §9 截断率再定 | 信息量 |
| D6 | 打字机动效 | A 保留但只播一次 / B 每次进入重播 / C 不加 | **A（P1）**：有在场感又不干扰回访 | 观感、无障碍 |
| D7 | 来源行是否含「记忆条数」 | A 不含 / B 接真实记忆统计 | **A**：无空间维度数据源，禁止编造 | 文案可信度 |
| D8 | 运行中提示样式 | A 角标「小 E 正在更新…」/ B 顶部细进度条 | **A**：不引入新组件 | 视觉 |

### 11.2 其他风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 派生文本质量不可控 | 会话最后一条 assistant 可能是工具调用说明/半截回复 | 规整规则 + `no-content` 兜底；P2 用提示词约束；截断率监控 |
| 新鲜度误导 | 最近会话无正文时不回溯（D3），用户可能看到空态但空间里其实有旧洞察 | 空态文案说明「等第一次工作跑完」；证据浮层不适用 |
| 空间隔离 | 会话由渲染层过滤，若 `workspaceId` 缺失（旧会话 `default`）可能串台 | P1 服务端过滤 + 渲染层二次校验 |
| 敏感内容 | 洞察正文可能包含会话中的隐私/客户信息 | 仅本空间可见；不进入分享/导出；埋点只记长度不记正文 |
| 性能 | 每次派生 1 次 `getSession`，会话多时列表已全量拉取 | `sessions` 由上层注入，不重复拉；P1 服务端按空间过滤后成本下降 |
| 多窗口 | 两个窗口同时展示同一空间，各自派生 | 允许；缓存按窗口内存，不共享（P2 可提主进程缓存） |

### 11.3 与既有文档的冲突检查

- 动态方案：`insight` 事件默认不出行 —— 本规格不改，保持。
- 数据地图 §9：洞察只能派生、不建表 —— 本规格 §8.6 一致（仅列建表触发条件）。
- tabs-workbench：概览 B = 最近会话最后一条 assistant 文本 —— 本规格细化状态与兜底，方向一致。
- 特性清单 §8.3：来源计数是硬编码需真实统计或去掉 —— 本规格 §5.4 / §8.3 已改为真实计数或省略。

---

## 12. 实施改动面

| 文件 | P0 | P1 | P2 |
| --- | --- | --- | --- |
| [OverviewPage.tsx](../apps/desktop/src/renderer/src/workbench/workspace/OverviewPage.tsx) | `useWorkspaceInsight` 改为状态机 + ViewModel；来源行；无桥/失败不渲染（禁止 mock） | 刷新按钮、证据浮层、运行中角标、落款、空态卡/错误重试 | 动作胶囊、生成入口 |
| [activity.ts](../apps/desktop/src/renderer/src/workbench/workspace/activity.ts) | 导出 `WORKSPACE_INSIGHT_LIMITS`；新增 `extractInsightDetail()` 返回 `{text, messageId}`，保留 `extractInsightText()` 供动态复用 | — | 生成结果规整复用 |
| [overview.css](../apps/desktop/src/renderer/src/workbench/workspace/overview.css) | `.wb-ov-insight-*` 骨架 + 来源行样式 | 空态/错误/角标/证据浮层/落款/刷新按钮样式 | 动作胶囊 |
| [preload/index.ts](../apps/desktop/src/preload/index.ts) + [agent-gateway-bridge.ts](../apps/desktop/src/main/gateway/agent-gateway-bridge.ts) | — | `listSessions` 透传 `workspaceId` | 可选聚合接口 |
| `apps/gateway/src/modules/agent/routes.ts` | 已支持，不改 | — | 可选 `GET /v1/agent/workspaces/:id/insight` |
| 测试 | `activity.test.ts` / `insight.test.ts` / `OverviewPage.insight.test.tsx` | 状态转移测试扩展 | 动作/生成测试 |
| 文案 | 沿用现有硬编码 | 落 §5.4 文案表 | i18n 抽 key |

**参考实现顺序建议**：P0 先合（纯渲染层，无后端依赖）→ 观测两天截断率/空态率 → P1（workspaceId 透传 + 刷新 + 证据）→ 再决定 P2。

### 12.1 实施记录（2026-11-03）

P0 与 P1 已一并实现（改动面与 §12 一致，测试全绿）：

| 项 | 状态 | 落点 |
| --- | --- | --- |
| 状态机（8 态 + 转移 + 不变量） | ✅ P0 | 新增 [useWorkspaceInsight.ts](../apps/desktop/src/renderer/src/workbench/workspace/useWorkspaceInsight.ts)：模块级缓存（60s TTL）+ 单飞（key 含会话指纹）+ 失败冷却（60s，仅拦自动重试）+ 请求序号防串台 |
| 纯派生层 | ✅ P0 | 新增 [insight.ts](../apps/desktop/src/renderer/src/workbench/workspace/insight.ts)：`deriveWorkspaceInsight`（超时 8s、重试 1s/3s、`pickLatestSession`、来源行/时效格式化、`validateInsightCopy`、`INSIGHT_COPY` 文案表） |
| 消息详情 | ✅ P0 | [activity.ts](../apps/desktop/src/renderer/src/workbench/workspace/activity.ts)：`extractInsightDetail()` 返回 `{text, messageId}`；导出 `INSIGHT_MAX_LINES/INSIGHT_MAX_CHARS` |
| 概览卡接入 | ✅ P0+P1 | [OverviewPage.tsx](../apps/desktop/src/renderer/src/workbench/workspace/OverviewPage.tsx)：`InsightCard`（骨架/空态/no-content/错误+重试/来源行/证据浮层/落款/刷新+toast/updating 角标）+ `useInsightTypewriter`（每空间播一次，reduced-motion 直出全文） |
| 样式 | ✅ P0+P1 | [overview.css](../apps/desktop/src/renderer/src/workbench/workspace/overview.css)：`wb-ov-insight-*` 全套（含浮层、caret、骨架、落款分隔线） |
| `listSessions` workspaceId 透传 | ✅ P1 | [sources.ts](../apps/desktop/src/shared/sources.ts)、[preload/index.ts](../apps/desktop/src/preload/index.ts)、[main/index.ts](../apps/desktop/src/main/index.ts)、[agent-gateway-bridge.ts](../apps/desktop/src/main/gateway/agent-gateway-bridge.ts)（网关本就支持，补齐链路；渲染端 store 仍全量拉取，按空间过滤在 `useWorkspaceSessions`） |
| 测试 | ✅ | [workbench-overview.test.tsx](../apps/desktop/tests/workbench-overview.test.tsx)：派生/选会话/重试/超时/文案校验 + 页面 8 态 + 证据浮层 + 刷新 toast + 防串台；[agent-gateway-bridge.test.ts](../apps/desktop/tests/agent-gateway-bridge.test.ts)：workspaceId 查询参数。全量 889 测试通过，tsc 0 错误 |
| 视觉验证 | ✅ | `vite.browser.config.mts` mock + 无头 Electron 截图（`.tmp-proto/shots/ws-insight-*.png`）：updating 角标/来源行计数/落款/证据浮层均按规格渲染 |

**评审修复（对照首轮代码评审，8 项全部处理）**：冷却到期自动重试（§8.7，`__setInsightCooldownForTests` 可注入时长）；T6/T8 800ms 去抖（切空间立即执行）；单飞 key 收敛回 `workspaceId`（签名变化复用在飞请求，不并发）；刷新按钮 `aria-disabled`（§7.1 不丢焦点）；错误回退保留 `updating` 语义；证据行 `aria-label` 使用「打开工作」文案；打字机正文改为视觉隐藏全文节点（读屏始终可读完整内容）；`validateInsightCopy` 补 C2 下限/C3 句数/C5 URL 与模板占位符/C11 免责声明。

**与规格的偏差**：

1. **打字机步进**为 2 字/24ms（规格未定参数，视觉接近原型）。
2. **重试间隔可注入**（`__setInsightRetryDelaysForTests`）：生产仍为 1s/3s，单测注入 `[]`/`[0]` 避免真实等待——与 §6.4 不变量不冲突。
3. **错误重试按钮**（P1 项）直接复用刷新动作（重新派生），与 D4 一致。
4. P2 全部顺延（动作胶囊、生成 run、历史表、i18n），理由见 §11.1/§4.3；`memoryCount` 恒缺省（D7）。
5. **AC-6 时序**：实现依赖工作台 4s 会话轮询，run 结束后刷新上界为一个轮询周期（≤4–8s），未达「≤2s」字面值。建议后续在 run 完成事件上主动 `refreshSessions`（P2 一并做）；本版接受轮询上界。

---

## 附录 A：原型证据索引

| 内容 | 位置 |
| --- | --- |
| 概览页（项目头 / 洞察 / 动态） | `everoffice` 原型 `src/renderer/src/office-proto/pages/WorkspacePages.tsx:57-250` |
| 洞察 mock 数据 | `.../office-proto/workspace.ts:96-103` |
| 打字机 hook | `.../office-proto/pages/RecentView.tsx:18-39` |
| 洞察卡样式 | `.../office-proto/office-proto.css:135-200`（工作空间复用见 `:1541-1543`） |
| 设计文档（v1→v4 决策） | `.../everoffice/design/ws-overview-redesign.md` §3 B |
| 线框图 | `.../everoffice/design/ws-overview-wireframe.html` |
| 实际渲染截图 | [概览卡片](assets/workspace-overview-insight.png)、[整页](assets/workspace-overview-page.png) |

> 原型仓库 HEAD：`d60032e`（2026-10-30）；截图由 `.tmp-proto` 无头 Electron 渲染（1440×1000，DPR 2，`prefers-reduced-motion`）。

## 附录 B：术语

| 术语 | 含义 |
| --- | --- |
| 工作 | 产品的 `AgentSession`（工作会话）；原型称「工作/任务」 |
| 洞察 | 本规格定义的概览 B 区卡片及其 ViewModel |
| 派生 | 从既有数据（会话消息/事件/文件）实时计算，不新建持久化实体 |
| 证据 | 洞察文本所引用的来源会话/消息（`origin`） |
| 新鲜度 | `origin.sourceUpdatedAt` 与最近会话 `updatedAt` 的一致性 |
