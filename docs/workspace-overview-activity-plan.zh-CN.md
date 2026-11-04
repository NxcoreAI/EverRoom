# 工作空间「概览 · 动态」对齐原型模型：实现方案

> 状态：**P0 + P1 已实现**（2026-11-03，见 §4.6 / §5.7 落地记录）；P2 的 `work-review` 已按「活状态」口径实现（见 §6.1），无需建表。
> 关联：`docs/design/everoffice-feature-inventory.zh-CN.md` §3.4（原型动态卡清单）、`docs/design/product-data-map.zh-CN.md` §9（意图：动态/洞察是派生数据，不建 feed 表）、`docs/workspace-plan-task-design.zh-CN.md`（`workspace_plan_items` 与它的**事件流表**）、`everoffice` 原型 `WorkspacePages.tsx:216-247`、`workspace.ts:105-146`。

---

## 0. 一句话

产品现在的「动态」是**两路状态快照合出来的一句话列表**（会话一行 + 文件一行，整行一个跳转）；原型是**带类型的事件流**（7 类事件、文案分段且每段独立可点、每类有自己的图标与色）。本方案把它对齐到后者，分三步：

1. **P0（渲染层，1 天）**：换成原型的模型骨架——`kind` 枚举 + `segments[]` 引用 + 类型色 token + 内联可点引用；顺手修掉跨空间泄漏与「产物落库动态不刷新」两个已有缺陷。
2. **P1（网关派生接口，2–3 天）**：事件源从「当前状态」升级成「历史」——`agent_runs` + `file_entries` + `workspace_plan_item_events` 三源 UNION 派生，游标分页。**不建新表**。
3. **P2（语义补全，按需）**：审批事件落库 → 「等你审阅」；计划事件接进动态；筛选/未读等增强。

---

## 1. 现状 vs 原型

| 维度 | 产品现状 | 位置 | 原型 | 差距 |
| --- | --- | --- | --- | --- |
| 事件来源 | 本空间 sessions + 文件库条目 | `workbench/workspace/activity.ts:127-138` | sessions + 产物 + 材料 + 计划 + 洞察（mock） | 缺「计划/审阅/洞察」语义 |
| 事件类型 | 6 类：`session-created/run/done/updated`、`file-generated/added` | `activity.ts:15-21` | 7 类：task/review/output/material/done/plan/insight | 命名与语义都不对齐（`done` 在原型指「交付完成」，产品里等于「会话结束」） |
| 文案结构 | **单串** `label`，带《》 | `activity.ts:69-106` | `segments[]`：`{text}` / `{taskId}` / `{fileId}` 混排 | 产品一行只能有一个目标 |
| 引用跳转 | `target` 一个，整行是按钮 | `activity.ts:23-25`、`OverviewPage.tsx:374` | 每段引用独立按钮，一行可同时指工作 + 文件 | 表达不了「《某工作》生成了《某文件》」的双引用 |
| 图标 | 3 种（Session→MessageSquare/FileText、产物→Sparkles、材料→文件类型图标） | `OverviewPage.tsx:404-413` | 7 种类型图标 | 类型不可辨 |
| 色彩 | 仅 `is-accent` / `is-running` 两支 | `OverviewPage.tsx:375`、`overview.css:335-342` | 按类型色（蓝/橙/绿/灰/紫） | 无类型语义 |
| 时间 | `relativeTimeLabel(item.at)` | `OverviewPage.tsx:379` | 静态 `timeLabel` | 产品更好，保留 |
| 折叠 | 8 条 / 展开 20 条 | `activity.ts:38-39` | 5 条 / 展开全部 | 保留产品口径（见 §7） |
| 空态 | `EmptyState`「还没有动态」 | `OverviewPage.tsx:362-368` | 「暂无动态——空间里发生的工作与文件变化会记录在这里」 | 补一句说明 |
| 空间隔离 | **缺陷**：`fetchRealFiles(limit)` 没传 `workspaceId` → 拉全库 | `OverviewPage.tsx:430` | 空间内 | 会显示别的空间的文件行 |
| 刷新 | 无。切页重挂才更新 | `OverviewPage.tsx:424-447` | 原型无（mock） | Agent 生成产物后动态不出现，直到切页 |
| 粒度 | 1 会话 = 1 行（状态快照） | `activity.ts:84-93` | 一次 run 可出多行（开始/完成/产物） | 表达不出历史；P1 解决 |

> 结论：**模型层要先换骨架（P0），语义层再换数据源（P1）**。P0 单独就有收益，且不依赖任何后端改动。

---

## 2. 目标模型

```ts
// workbench/workspace/activity.ts

/** 事件类型：与原型 7 类一一对应，命名按产品语汇（工作 = session）。 */
export type ActivityKind =
  | 'work-created'   // 你/Agent 新建了工作          ← 原型 task
  | 'work-run'       // 工作开始执行                ← 原型 task
  | 'work-review'    // 等你确认（活状态，见 §6.1）  ← 原型 review
  | 'work-done'      // 工作结束/交付               ← 原型 done
  | 'output'         // 生成了产物                  ← 原型 output
  | 'material'       // 添加了材料                  ← 原型 material
  | 'plan'           // 计划/任务状态变更           ← 原型 plan（P1 末尾/P2）
  | 'insight'        // 小 E 产出洞察               ← 原型 insight（见 §7，默认不出行）

/** 文案的一段：纯文本，或一个可点引用（id 而非文案，改名自动跟随）。 */
export interface ActivitySegment {
  text?: string
  /** 指向工作会话（= 原型的 taskId）。 */
  workId?: string
  /** 指向文件库条目（catalog id，= 原型的 fileId）。 */
  fileId?: string
  /** 指向计划项（P1 起）。 */
  planItemId?: string
}

export interface ActivityItem {
  id: string          // 稳定去重键：`session:<id>` / `file:<id>`（kind 不编进 id，见 §4.6）
  kind: ActivityKind
  segments: ActivitySegment[]
  at: string          // ISO；排序与相对时间都用它
  /** P1 起带来源，便于埋点/调试；渲染层不依赖。 */
  actor?: 'user' | 'agent' | 'system'
}
```

**类型视觉表**（`ACTIVITY_TONE`，纯数据，不引 React；色值走 token 不写 hex）：

| kind | 图标（lucide） | tone 类 | 取色 token |
| --- | --- | --- | --- |
| `work-run` | `Play` | `is-running` | `--ui-running` / `--ui-running-soft` |
| `work-review` | `Eye` | `is-warning` | `--ui-warning` / `--ui-warning-soft` |
| `work-done` | `Check` | `is-success` | `--ui-success` / `--ui-success-soft` |
| `output` | `FilePlus` | `is-success` | `--ui-success` / `--ui-success-soft` |
| `material` | `Paperclip` | `is-muted` | `--ui-text-3` / 透明 |
| `plan` | `Flag` | `is-muted` | `--ui-text-3` / 透明 |
| `insight` | `Sparkles` | `is-accent` | `--ui-accent` / `--ui-accent-soft` |
| `work-created` | `FileText` | `is-accent` | `--ui-accent` / `--ui-accent-soft` |

> 原型用 iWork 系统色（蓝 `#0a84ff` / 橙 / 绿 / 紫）；产品是暖纸主题，按 **语义 token** 映射：运行中=蜜桃、待审阅=警示、完成/产物=成功、材料/计划=次级灰、新建/洞察=强调色。不要硬编码 hex（`--ui-icon-*` 只为文件类型图标存在）。

---

## 3. 事件语义映射（原型 7 类 → 产品真实来源）

| 原型 kind | 语义 | P0 可用来源（今天就有） | P1 真实来源 | 备注 |
| --- | --- | --- | --- | --- |
| task → `work-created` / `work-run` | 新建 / 开始执行 | `AgentSession`（`status==='running'` → run；`updatedAt≈createdAt` → created） | `agent_runs.startedAt`（一次 run 一行） | P0 一会话一行 |
| done → `work-done` | 结束/交付 | `session.status ∈ {closed, interrupted}` | `agent_runs.completedAt` + `status ∈ {completed, failed}` | P1 可区分「完成」与「失败/中断」 |
| output | 生成了产物 | `file_entries.sourceKind === 'agent-generated'` | 同一列（+ `files/pi-tools` 的产物口径） | 与产物页同判据 |
| material | 添加了材料 | 其余 sourceKind（`manual-upload/connector/local-folder/web-clipper/legacy-upload/artifact-imported`） | 同一列 | 与 `isArtifactFile` 口径必须互补，避免同一文件两处归类不一致 |
| review | 等你确认 | **无** | `agent_events` 里**未解决**的 `approval.requested`（`run.status ∈ accepted/running`）——这是**活状态**，不是历史事件：卡片一处理（`approval.resolved`）或 run 终结，行就消失 | 引用回会话（卡片就在那段对话里），见 §6.1 |
| plan | 计划/里程碑变更 | **无** | `workspace_plan_item_events`（已建表、已有 service，`plan:*` IPC 已接线） | 已实现 |
| insight | 小 E 洞察 | 已有独立「洞察卡」 | 同 | §7：动态不再重复一行 |

**明确的口径约束**：`output` 与 `material` 的判据必须与 `OutputsPage`（`isArtifactFile` = `agent-generated | artifact-imported`）**互补且不重叠**——产物页能看到的文件，在动态里只能是 `output`（或 `material` 里不再出现），否则「资料库说是材料、产物库说是产物」。

---

## 4. P0：渲染层对齐（不改后端，1 天）——**已实现**

### 4.1 改动面

| 文件 | 改动 | 规模 |
| --- | --- | --- |
| `workbench/workspace/activity.ts` | 重写类型 + `buildActivities` + `ACTIVITY_TONE`；保留 `collapseActivities`（8/20）与洞察提取（不动） | ~120 行改，洞察段原样保留 |
| `workbench/workspace/OverviewPage.tsx` | 动态行渲染改 `segments` 映射 + 引用按钮；`ActivityIcon` → `ActivityGlyph(kind)`；接 `useFileLibrary(workspace.id, { limit: 20 })` 替换自建 `useWorkspaceFiles`；时间改 `<time dateTime title>` | ~60 行 |
| `workbench/workspace/useFileLibrary.ts` | 加可选 `{ limit }`（默认仍 200） | ~6 行 |
| `workbench/workspace/overview.css` | `.wb-ov-activity` 由「整行按钮」改成容器；新增 `.wb-ov-activity-ref`、`.wb-ov-activity.is-running/-warning/-success/-muted/-accent` | ~40 行 |
| `tests/workbench-overview.test.tsx` | 单测 + 页面用例更新（§4.5） | ~120 行 |

**不动**：`contracts.ts`（props 不变）、`WorkspaceTabHost.tsx`、网关、preload。

新增模块 `workbench/workspace/artifactKind.ts`：`ARTIFACT_SOURCE_KINDS` / `isArtifactSourceKind` 的唯一来源，
`fileBrowser.tsx` 的 `isArtifactFile` 与 `activity.ts` 都从这里取——产物/材料口径不允许各写一遍。

### 4.2 组装规则（`buildActivities`）

```ts
// 会话 → 一行（P0 的粒度上限，P1 靠 runs 拆细）
function sessionActivityOf(s: SessionActivityInput): ActivityItem {
  const kind = sessionKindOf(s)      // running→work-run；closed/interrupted→work-done；其余→work-created
  const verb = sessionVerbOf(s)      // 开始 / 结束 / 新建（刚建好）/ 更新（久未启动只是被更新过）
  return {
    id: `session:${s.id}`,
    kind,
    at: s.updatedAt || s.createdAt,
    segments: [{ text: verb }, { workId: s.id }],
  }
}

// 文件 → 一行（产物 / 材料二选一，判据来自 artifactKind.ts，与产物页互补）
function fileActivityOf(entry: RealOfficeFile): ActivityItem {
  const artifact = isArtifactSourceKind(entry.catalog.sourceKind)
  return {
    id: `file:${entry.catalog.id}`,
    kind: artifact ? 'output' : 'material',
    at: entry.catalog.updatedAt,
    segments: [{ text: artifact ? '生成了 ' : '添加了材料 ' }, { fileId: entry.catalog.id }],
  }
}
```

- **排序**：`at` 倒序；同时刻 `work*` 在前、文件在后，再按 `id` 稳定兜底（沿用现有 `compareActivities` 思路，`activity.ts:113-125`）。
- **去重**：同一 `id` 只留一条（P1 起同 id 的 upsert 语义）。
- 会话 `title` 为空 → 文案用「新工作」（沿用 `sessionDisplayTitle` 口径，别自己造）。

### 4.3 引用解析与降级（页面侧）

```tsx
function renderSegment(seg: ActivitySegment, key: string) {
  if (seg.workId) {
    const session = sessions.find((s) => s.id === seg.workId)
    return (
      <button key={key} type="button" className="wb-ov-activity-ref"
        onClick={() => session ? onOpenSession(session.id) : onToast('工作不存在')}>
        {session ? sessionDisplayTitle(session) : '工作'}
      </button>
    )
  }
  if (seg.fileId) {
    const entry = files.items.find((f) => f.catalog.id === seg.fileId)
    return (
      <button key={key} type="button" className="wb-ov-activity-ref"
        onClick={() => entry ? onOpenFile(entry.file) : onToast('文件不存在')}>
        {entry?.file.name ?? '文件'}
      </button>
    )
  }
  return <span key={key}>{seg.text}</span>
}
```

- 行容器是 `<span>`/`<p>`，**不再是 `<button>`**：一行多个引用时嵌套按钮非法，必须拆开（今天 `OverviewPage.tsx:374` 整行 button，这是本方案唯一的结构性改动）。
- 引用按钮：`color: var(--ui-accent)`、`font-weight: 550`、hover 下划线、`:focus-visible` 走统一 focus ring；`aria-label` 带对象全名（如「打开工作：整理连接器需求」）。
- 目标已删 → `onToast`，**不灰化、不留历史**（与资料库删除同口径）。

### 4.4 数据源与刷新

- 复用 `useFileLibrary(workspace.id, { limit: 20 })`：一次拿到**本空间**文件、带 `state`（loading/ready/unavailable）、并且已经**监听 `office.onAgentFile` 自动重拉**（`useFileLibrary.ts:92-105`），直接修掉「产物生成后动态不刷新」。
- 会话侧仍是 `WorkspaceTabHost` 注入的 `sessions`（3.5s 轮询 + run 事件已由 store 维护），不额外加轮询。
- 文件库 `unavailable`（无桥/网关挂了）→ 只留工作行，卡片右下角一行 `wb-ov-note`「文件库暂不可用」（现有文案保留）。

### 4.5 验收（P0）

- [ ] 单测（`activity.ts`）：7 类 kind 的判定分支；`segments` 组装（会话 2 段、文件 2 段）；排序（同时刻工作在前）；`collapseActivities` 8/20 与 `hiddenCount`。
- [ ] 页面（`OverviewPage`）：
  - 一行出现 ≥2 个引用按钮，点工作 → `onOpenSession`，点文件 → `onOpenFile`；
  - 引用目标不存在 → toast「文件不存在/工作不存在」，不崩；
  - 空态文案含「空间里发生的工作与文件变化会记录在这里」；
  - loading → Spinner；unavailable → 只剩工作行 + 提示；
  - **只渲染本空间文件行**（fixture 里混一条别的 `workspaceId` 的文件，断言不出现）。
- [ ] a11y：`<ul>/<li>` 结构、引用是 `button`、时间 `<time dateTime>` 且 `title` 为绝对时间、`Tab` 可依次聚焦每个引用。
- [ ] 视觉：四类 tone 的图标底色各不相同（截图对照 `overview.css`）。

### 4.6 落地记录（2026-11-03）

| 项 | 实现 |
| --- | --- |
| `activity.ts` | `ActivityKind` 8 值 + `ACTIVITY_TONE` + `ActivitySegment`/`ActivityItem`（`segments` 取代 `label`/`target`）；会话一行、文件一行；`collapseActivities` 维持 8/20 |
| 事件 id | `session:<sessionId>` / `file:<catalogId>`（**不把 kind 编进 id**：kind 会随状态变化，id 必须稳定，P1 直接兼容） |
| 语义 vs 视觉分离 | `kind` 只定图标 + tone；动词由状态选（`开始/结束/新建/更新`），因此「刚建好」与「被更新过」同属 `work-created` 但文案不同 |
| 引用 | `renderSegment` 按 `workId` / `fileId` 实时解析名字；目标已删 → toast「工作不存在 / 文件不存在」，不渲染幽灵条目 |
| 行结构 | `<li><div class="wb-ov-activity">`（**不再是 button**）+ 内联 `.wb-ov-activity-ref` 按钮；`<time datetime title>` 给相对时间 + 悬停绝对时间 |
| 数据源 | 自建 `useWorkspaceFiles` 删除，改用 `useFileLibrary(workspace.id, { limit: 20 })`：**修掉跨空间泄漏**，并接上 `office.onAgentFile` 自动重拉 |
| 口径 | 新增 `artifactKind.ts`；`fileBrowser.isArtifactFile` 改为委托它 |
| 空态 | `EmptyState` 增描述「空间里发生的工作与文件变化会记录在这里」 |
| 测试 | `tests/workbench-overview.test.tsx` 13 passed；覆盖 kind/segments/id、产物导入也算产物、tone 映射、引用点击跳转、`files.list(20, 0, { workspaceId })` 空间隔离、行非按钮 + 引用可聚焦 + `<time>` 属性 |

**P0 尚未产生的事件类型**：`work-review`（审批未落库）、`plan`（计划事件流已存在于网关，渲染层尚未接）、
`insight`（产品有独立洞察卡，动态不出重复行）。三种都已在枚举/图标/tone 里预留，接上数据源即可显示。

---

## 5. P1：事件源上移到网关（派生接口，不建表）——**已实现**

### 5.1 为什么派生而不是建 feed 表

沿用 `product-data-map` §9 的结论（「动态/洞察是派生数据，不要建表，否则很快与真实状态漂移」）。历史本来就有：

- `agent_runs`（`startedAt` / `completedAt` / `status`）＝ 执行的真实历史；
- `file_entries`（`sourceKind` / `workspaceId` / `updatedAt`）＝ 产物的真实历史；
- `workspace_plan_item_events`（`kind` / `actorKind` / `summary` / `sessionId` / `createdAt`）＝ **已经存在的计划事件流**（`schema.ts:1901-1922`，专为「卡片时间线/审计/认领包 history」设计）。

三张表 union 出来就是一个可回溯的事件流，唯一缺的是「审批」（P2 决策点，见 §6.1）。

### 5.2 契约

```ts
// packages/agent-contract（或 shared/ingest 同层 DTO）
export interface WorkspaceActivitySegmentDto {
  text?: string
  sessionId?: string
  fileId?: string
  planItemId?: string
}

export interface WorkspaceActivityDto {
  id: string                 // 见 §5.3
  kind: 'work-created' | 'work-run' | 'work-done' | 'work-review' | 'output' | 'material' | 'plan'
  actor: 'user' | 'agent' | 'system'
  at: string                 // ISO
  segments: WorkspaceActivitySegmentDto[]
  /** 供埋点/调试，渲染层不依赖。 */
  source: { table: 'agent_runs' | 'file_entries' | 'workspace_plan_item_events'; rowId: string }
}

// GET /v1/agent/workspaces/:workspaceId/activities?limit=20&beforeAt=2026-11-03T07:00:00.000Z&beforeId=run:...
// → { items: WorkspaceActivityDto[]; nextBeforeAt: string | null; nextBeforeId: string | null }
```

- `limit` 默认 20、上限 50；**游标**用 `(at, id)` 双键（`at` 可能重复，单键会跳条）。
- 桌面链路照 `journal` 的范本走（`docs/workspace-plan-task-design.zh-CN.md` §1 有完整清单）：`gateway/modules/.../routes.ts` → `main/gateway/agent-gateway-bridge.ts` → `main/index.ts` channel → `preload/index.ts` → `shared/sources.ts`（`NxcoreDesktopApi`）→ 渲染层 hook。

### 5.3 事件 id 规范（稳定、可去重、可增量）

| 来源 | id | 说明 |
| --- | --- | --- |
| run 开始 | `run:<runId>:start` | `startedAt` 非空才有 |
| run 结束 | `run:<runId>:end` | `completedAt` 非空；`status=completed` → `work-done`，`failed/interrupted` → `work-done`（文案「执行失败」可选） |
| 文件 | `file:<fileId>` | 一个文件一条，`updatedAt` 决定位置（P0 同构，升级平滑） |
| 计划事件 | `plan:<eventId>` | 直接复用事件行 id |
| 会话新建 | `session:<sessionId>:` + `created` | `agent_sessions.createdAt`，仅当没有任何 run |

> 一行的 `at`：run 两个事件分别取 `startedAt` / `completedAt`；文件取 `updatedAt`；计划事件取 `createdAt`。

### 5.4 查询骨架（实际实现：四条 drizzle 查询 + 内存合并，不是单条 UNION SQL）

上面的 UNION 是**语义**示意；实际用的是四条各自走索引的 drizzle 查询（每条 `LIMIT scanLimit`，
`scanLimit = clamp(limit × 3, 60, 200)`），在内存里合并、按 `(at, id)` 排序取前 `limit`：
SQL 预筛用 `<=`（同一毫秒的多条必须进候选），**严格更早**由内存里的游标比较完成——
只靠 SQL 的 `<` 会漏掉同一毫秒的第 2..n 条（这是 P1 实现里最容易写错的一处，已有单测锁住）。

```sql
WITH ev AS (
  SELECT 'run:<id>:start' AS id, 'work-run' AS kind, NULL AS actorKind,
         r.started_at AS at, s.id AS sessionId, NULL AS fileId, NULL AS planItemId, r.prompt AS brief
  FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id
  WHERE s.workspace_id = :ws AND r.started_at IS NOT NULL
  UNION ALL
  SELECT 'run:<id>:end', 'work-done', NULL, r.completed_at, s.id, NULL, NULL, r.prompt
  FROM agent_runs r JOIN agent_sessions s ON s.id = r.session_id
  WHERE s.workspace_id = :ws AND r.completed_at IS NOT NULL
  UNION ALL
  SELECT 'file:<id>', CASE WHEN f.source_kind IN ('agent-generated','artifact-imported') THEN 'output' ELSE 'material' END,
         NULL, f.updated_at, NULL, f.id, NULL, f.original_name
  FROM file_entries f
  WHERE f.workspace_id = :ws AND f.deleted_at IS NULL AND f.state <> 'deleted'
  UNION ALL
  SELECT 'plan:<e.id>', 'plan', e.actor_kind, e.created_at, e.session_id, NULL, e.item_id, e.summary
  FROM workspace_plan_item_events e JOIN workspace_plan_items i ON i.id = e.item_id
  WHERE i.workspace_id = :ws
)
SELECT * FROM ev
WHERE (:beforeAt IS NULL) OR (at < :beforeAt) OR (at = :beforeAt AND id < :beforeId)
ORDER BY at DESC, id DESC
LIMIT :limit + 1;   -- 多取一条判断是否还有更早
```

- 索引：`agent_runs` 已有 `(session_id, idempotency_key)` 唯一索引；按空间查需要 `agent_sessions.workspace_id` 索引（`drizzle/0089_agent_workspaces.sql:25` 已有）；`file_entries` 有 `workspace_id` 索引（`schema.ts:1252`）；计划事件有 `plan_events_item_idx`。**建议补**：`agent_sessions(workspace_id, updated_at)` 已有用途确认，若无则 P1 一并加一条迁移。
- 文案**在服务层拼**（`segments` 的 text 部分），渲染层只做渲染与引用解析——避免同一句话在两端各写一遍、口径漂移。

### 5.5 渲染层切换与降级

```ts
// workbench/workspace/useWorkspaceActivities.ts（已实现）
export function useWorkspaceActivities(
  workspaceId: string,
  options?: { limit?: number; refreshKey?: string },
): {
  state: 'loading' | 'ready' | 'unavailable'
  items: ActivityItem[]
  hasMore: boolean
  loadingMore: boolean
  loadMore(): void
  refresh(): void
}
```

- 桥不可用 / 请求失败 → `state='unavailable'`，**回落到 P0 的本地派生 `buildActivities`**（离线与 happy-dom 单测零成本）。
- `loadMore()` 走游标（替换掉「展开到 20 条」的本地截断；UI 仍是「显示更早 / 收起」，行为升级为真分页）。
- 刷新时机：`sessions` 变化（轮询已存在）+ `office.onAgentFile`（复用 `useFileLibrary` 的订阅）+ 展开/切页。

### 5.6 验收（P1）

- [x] 服务单测：三源 union 的 kind/文案/`at` 映射；游标翻页不重不漏（构造同一 `at` 的多行）；空间隔离（另一空间数据不出现）；软删文件不出现。
- [x] 契约单测：段引用 id 均为稳定 id，不含展示文案。
- [x] 渲染层：桥不可用回落 P0；桥可用时「显示更早」发出带游标的第二次请求；本空间产物落盘（`office.onAgentFile`）后立即重拉首屏（事件驱动，不等轮询）。
- [x] 性能：四条查询各自走空间索引（`agent_sessions_workspace_idx`、`file_entries_workspace_idx`、`plan_events_item_idx`），单次扫描上限 200 行；`workspace_id + updated_at` 复合索引尚未加（万级文件库时再补，需求见 §8.9）。**未做基准实测**。

### 5.7 落地记录（2026-11-03）

| 项 | 实现 |
| --- | --- |
| 契约 | `packages/agent-contract/src/index.ts` 新增 `WorkspaceActivityKind` / `WorkspaceActivitySegment` / `WorkspaceActivity` / `WorkspaceActivityPage` / `WorkspaceActivityQuery` |
| 网关 | 新模块 `apps/gateway/src/modules/workspace-activity/{service,routes,index}.ts`；`GET /v1/agent/workspaces/:workspaceId/activities?limit&beforeAt&beforeId`；空间不存在 → 404 `{error:'workspace_not_found'}` |
| 派生来源 | `agent_runs`（`startedAt` → `run:<id>:start`、`completedAt` → `run:<id>:end`，`failed` 出「执行失败」）、`agent_sessions`（**没有 run 的会话**才出 `session:<id>` 的「新建了工作」，避免重复）、`file_entries`（产物/材料，口径同 `artifactKind.ts`，软删与 `state=deleted` 排除）、`workspace_plan_item_events`（`plan:<eventId>`，段 = 计划项引用 + 摘要） |
| 游标 | `(at, id)` 双键；`nextBefore*` 只在确实还有下一页时返回（前端不用判空页） |
| 桌面链路 | `agent-gateway-bridge.listWorkspaceActivities` → `workspace:activities`（main）→ preload `workspace.activities` → `shared/sources.ts` 类型 |
| 渲染层 | 新 hook `useWorkspaceActivities(workspaceId, { limit, refreshKey })`：DTO→`ActivityItem`（契约 `sessionId` → 本地 `workId`）、游标 `loadMore`、失败置 `unavailable`；`OverviewPage` 在 `ready` 时用服务端列表，否则回落 `buildActivities` |
| 刷新策略 | 三档：① `refreshKey` = 会话状态指纹（`id:status:updatedAt`），「谁在跑/跑完」变了才重拉；② 本空间产物落盘（`office.onAgentFile` 的 `done/edited`）立即重拉首屏；③ 审批卡片不动会话时间戳 → 有 running 会话时 10s 低频轮询（用户已翻页则不打断、空闲时完全不轮询） |
| 审批（等你确认） | 同模块 `approvalActivities`：本空间活跃 run 里未解决的 `approval.requested` → `work-review` 行（活状态，见 §6.1）；跨源按 id 去重保留最新 |
| 计划引用 | 计划项暂无独立详情路由 → 点引用跳「计划」看板（`onOpenPage('plan')`） |
| 测试 | `apps/gateway/tests/workspace-activities.test.ts` 9 passed（合并语义 / 失败 run / 未跑过会话 / 软删与空间隔离 / 空间不存在 / 游标不重不漏 / 末页无游标 / limit 夹取 / HTTP 200+404）；`tests/workbench-overview.test.tsx` 16 passed（含网关派生行、游标续拉、失败回落） |

**仍未产生的事件**：无（P1 阶段）。`work-review` 在 P2 按「活状态」补上（`agent_events` 里未解决的
`approval.requested`，见 §6.1），与 P1 的派生口径不同：它不保证历史可回看，卡片一处理就消失。

---

## 6. P2：语义补全（按需）——`work-review` 已实现

### 6.1 `work-review`（「等你确认」）——**已实现（活状态，不建表）**

先说清楚它到底是什么：**「等你确认」不是一条历史记录，而是一个正在跑的对话里弹出的审批卡片**。
用户在概览里看到的应该是「现在有 N 张卡在等我点」，点进去回到那段对话（卡片就在那里）；卡片被处理、或 run 结束，这条就该消失。

因此口径与其它 kind 相反：不派生「历史上发生过一次审批」，而是派生**当前未解决的审批集合**。

实现依据（关键事实，纠正了本文早期版本「审批未落库」的判断）：

- run 事件**是落库的**：`agent_events`（`schema.ts` `502-520`，`payload` 为 JSON），
  审批卡的两次事件都在里面：`approval.requested` / `approval.resolved`，
  `payload = { approvalId, toolName, command, ... }`；
- 所以**不需要新建表**，也没有 §6.1 早期设想的「唯一需要建表的场景」。

派生规则（`WorkspaceActivityService.approvalActivities`）：

```
本空间 + run.status ∈ {accepted, running} 的 approval.* 事件
  → 收集 resolved 的 (runId, approvalId)
  → requested 里没被 resolved 的 = 待确认
  → 一行：id = approval:<runId>:<approvalId>，kind = work-review，at = requestedAt
           segments = [{text:'等你确认 '}, {sessionId}, {text:' · <toolName>'}]
```

- **同一张卡只出一行**：id 用 `approvalId` 而非事件 id（重试会重发 requested）；
  跨源合并时统一按 id 去重（保留 `at` 最新的一条）；
- **点了去哪**：引用段是会话 id，点击 → `onOpenSession(sessionId)`，落到的就是弹着卡片的对话；
  不做独立「审批中心」页面（产品里审批没有独立实体，只有卡片）；
- **视觉**：kind 固定 `work-review` → warning tone + Eye 图标（P0 已备好，渲染层零改动）；
- **刷新**：`approval.requested` 不会改会话 `status/updatedAt`，指纹刷新抓不到 →
  只要有 running 会话，动态接口以 10s 低频轮询（用户已翻页则不打断），空闲时完全不轮询；
- **不会出现僵卡片**：run 终结（completed/failed/cancelled/interrupted）后即使 requested 没 resolved
  也不再展示——卡片本身已经随 run 失效。

**验收**（`apps/gateway/tests/workspace-activities.test.ts` + `apps/desktop/tests/workbench-overview.test.tsx`）：

- [x] 跑着的 run 有未处理审批 → `work-review` 行，文案含 toolName，引用回会话；
- [x] `approval.resolved` 落地 → 行消失；run 结束后 → 行不再出；
- [x] 同 `approvalId` 重发只出一行；其它空间的审批不出；
- [x] 渲染层：warning 色 + 点引用 `onOpenSession`；有 running 会话时 10s 轮询、卡片处理后行消失；空闲不轮询。

**已知边界**：仅覆盖 `approval.requested`（bash/工具审批）。若产品以后有「产物等用户验收」
这类没有 run 的确认，那才是真正需要新事件表 / 新实体的场景，届时按 §6.1 早期方案 1 加即可。

### 6.2 `plan` 事件——**已实现**

依赖 `apps/gateway/src/modules/plan` 的桌面接线（`plan:*` IPC + 计划页从会话看板换成真任务看板，见 `docs/workspace-plan-task-design.zh-CN.md` §11）。接线完成后，`workspace_plan_item_events` 直接并入 §5.4 的 union，渲染层零改动。

### 6.3 增强（不入本期）

- 类型筛选 chip（复用原型 7 类的枚举，天然是筛选维度）；
- 按工作过滤（`?sessionId=`）；
- 未读点 / 已读游标（需新增 per-user 游标存储，先不做）；
- 时间分段（今天/昨天/更早）——数据已有，纯 UI。

---

## 7. 与原型的有意差异（评审确认）

| 项 | 原型 | 产品 | 理由 |
| --- | --- | --- | --- |
| 折叠 | 5 条 / 展开全部 | 8 条 / 展开 20（P1 起游标续拉） | 8/20 已是既有需求与测试基线；屏幕更宽，5 条偏少 |
| insight 行 | 洞察既进动态、又有独立卡 | 只保留独立洞察卡，动态不出 insight 行 | 同一句话出现两次是噪音 |
| 时间 | 静态文案 | 真实 ISO + 相对时间，`<time title>` 给绝对时间 | 真实数据必备 |
| 色彩 | iWork 系统色 hex | 语义 token | 主题可切换（暖纸/深色），hex 会错 |
| 空态 | fresh 空间不出 mock | 任何空间无数据即空态，从不造假数据 | 原型本身也是「不造 mock」原则 |
| 数据结构 | `taskId/fileId` | `workId/fileId`（+ `planItemId`） | 产品无 task 实体，会话才是工作 |

---

## 8. 风险与坑

1. **跨空间泄漏（现存缺陷，P0 必修）**：`OverviewPage.tsx:430` 未传 `workspaceId`。修法：改用 `useFileLibrary(workspace.id)`。
2. **整行按钮 → 内联引用**：一行变多个交互元素后，行的 hover 底色要挂在容器上、focus ring 只给引用按钮；`<li>` 内不要再包一层 button。
3. **引用目标被删**：只 toast，不渲染失效引用为灰字（避免「幽灵条目」）。
4. **改名跟随**：引用一律存 id，名字实时解析（P0 已是 id 模型，注意别退回存标题）。
5. **相对时间不跳动**：没有定时器，`3 分钟前` 会一直显示到下次重渲染（现状如此）。取舍：保持无 timer，靠 `<time title>` 给准确时间。
6. **展开态在切页时重置**：页面卸载即丢（`WorkspaceTabHost.tsx:80-100` 只渲染当前页，同款问题）。P0 不做；若要保留，把 `expanded` 提到 tab 视图态。
7. **产物/材料口径**：必须与 `OutputsPage.isArtifactFile` 互补；否则同一个文件在「产物」页是产物、在动态里是材料。
8. **文案口径**：`《》` 在原型用于文件书名号；产品现状是「生成了《X》」。统一规则：**引用对象不加书名号**（分段渲染本身就带样式），纯文本段不加。
9. **P1 性能**：union 查询跨三表，务必带 `workspace_id` 过滤并 `LIMIT n+1`；`file_entries` 的空间索引已存在，别用 `LIKE`。

---

## 9. 落地顺序（建议）

| 步 | 内容 | 依赖 | 估时 |
| --- | --- | --- | --- |
| 1 | P0：`activity.ts` 模型重写 + 单测 | 无 | 0.5 天 |
| 2 | P0：`OverviewPage` 渲染 + `useFileLibrary` 限流参数 + CSS | 1 | 0.5 天 |
| 3 | P1：网关 `/activities` 派生接口 + 服务单测 | 无（可与 1/2 并行） | 1.5 天 |
| 4 | P1：桥/preload/sources 链路 + `useWorkspaceActivities` + 分页 UI | 3 | 1 天 |
| 5 | P2：审批事件落库（若确认要做「等你审阅」） | 需先定事件表结构 | 1.5 天 |
| 6 | P2：plan 事件并入（依赖 plan 页接线） | `plan:*` IPC | — |

---

## 10. 明确不做

- 不新建 `workspace_activities` feed 表（除非 P2 审批事件落库，那也复用「事件表」而非「feed 表」概念）。
- 不做 websocket 实时推送（轮询 + `office.onAgentFile` 足够）。
- 不做未读/红点、不做跨空间动态聚合（主页「最近」页已有自己的口径）。
- 不改原型 mock（`everoffice` 仓库不动）。
