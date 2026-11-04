# 工作空间「计划」：从会话看板到真任务（todo）

> 状态：**P0–P3 已落地**（2026-11-03）。设计正文保留为决策依据；实现与本文的差异、落地文件与测试清单见 §15。
> 关联：`docs/design/product-data-map.zh-CN.md` §9「计划看板」行（已预判 `workspace_plan_items` 这张表）、`docs/design/everoffice-feature-inventory.zh-CN.md` §3.8（原型 `PlanKanban` 的列、卡片、拖拽手感）、`docs/design/tabs-workbench.zh-CN.md` §4（工作空间页数据面）、`docs/project-space-layout-plan.zh-CN.md`（空间目录 = Agent 的工作根，认领包的 `space` 取自这里）。

---

## 0. 一句话

「计划」不是会话列表的另一种排法，而是**空间里的一等任务对象（todo）**：用户或 Agent 建一条任务，带标题 / 背景 / 验收标准 / 材料引用 / 优先级 / 截止 / 负责人；看板四列拖动改状态；卡片能一键交给 Agent，Agent 也能用工具从池子里**主动认领**——认领时拿到一份结构化的**认领包**（任务意图 + 材料引用 + 历史与约束 + 写回契约），不需要用户再解释一遍。

今天的事实是：卡片就是 `AgentSession`，三列由 run 状态推导，页面明确写了不提供拖拽（`apps/desktop/src/renderer/src/workbench/workspace/PlanPage.tsx:34-36`），后端也没有任何 task 实体（`docs/design/product-data-map.zh-CN.md:357`）。所以这不是「给看板加个拖拽」，是**新增一个领域对象**，然后把它接到已有的空间 / 会话 / 工具面上。

---

## 1. 现状与差距

| # | 今天的事实 | 位置 | 差距 |
| --- | --- | --- | --- |
| 1 | 看板卡片 = `AgentSession`，点开跳会话 | `PlanPage.tsx:37-64` | 任务与执行载体被混为一谈：一次任务换一个会话重做，卡片就多一张 |
| 2 | 三列 `running / idle / done` 由 run 状态推导 | `workbench/types.ts:97-112`、`PlanPage.tsx:17` | 会话结束 ⇒ 任务"结束"，表达不了「还没人开始」「做完了但没验收」 |
| 3 | 库里没有任务表（`agent_schedules` 只是每日定时起会话） | `schema.ts:189`（空间）/`:217`（会话）/`:1354`（定时） | 没有 title 之外的任何字段：无描述、无验收、无优先级、无截止、无负责人、无排序、无材料 |
| 4 | 没有任何写通道 | 无 `plan:*` IPC | 拖拽改状态在渲染层做不出来（这也是当初只做只读的原因） |
| 5 | Agent 侧没有对应工具 | `create-server.ts:759` 起的 tools 数组里无 plan_* | Agent 既不能建任务，也不能认领、不能回报进度 |
| 6 | 原型期卡片状态是页面局部 state，切页即重置 | `everoffice-feature-inventory.zh-CN.md` §3.8 | 落库后自然解决，但要求新页面**不要把 items 放回页面局部 state** |

可复用的既有件（不要重造）：

- 空间过滤与会话排序：`workbench/types.ts:122`、`sessionsOfWorkspace`。
- 打通全链路的范本：每日日记 `apps/gateway/src/modules/journal/{service,routes}.ts` → `create-server.ts:1346-1375` → `apps/desktop/src/main/gateway/agent-gateway-bridge.ts:222` → `apps/desktop/src/main/index.ts:2170` → `apps/desktop/src/preload/index.ts:456` → `apps/desktop/src/shared/sources.ts:990` → `workbench/home/useDailyJournal.ts`。计划模块照这条线走。
- 工具装配点与「软租约」先例：`create-server.ts:759-862`（`primaryIntegrations.tools`）、`documentService.setAgentModificationLease`（`apps/gateway/src/modules/documents/service.ts:959`，派发期文档只读的租约思路，认领租约同构但 TTL 与语义不同）。

---

## 2. 领域模型：PlanItem

### 2.1 字段

分五组，避免又变成一坨 `metadata` JSON。

**身份与归属**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text pk | uuid |
| `workspaceId` | text not null | 所属空间。**必须显式合法**：空间不存在就报错，不像 `createSession` 那样静默归 default（任务落错空间等于丢失） |
| `createdBy` | `user\|agent` | 谁建的（看板要能区分「Agent 自己加的活儿」） |
| `createdByAgentId` | text null | `createdBy=agent` 时的 agentId（`main` / `slides-builder` …） |

**内容（要求人写得清楚，Agent 才认领得动）**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | text not null (≤200) | 卡片标题，一句话说清要做什么 |
| `detail` | text null | 背景与要求（markdown）。为什么有这件事、上下文、注意事项 |
| `acceptance` | text null | 验收标准。人读也是 Agent 的完成判据（"三页 PPT，含一张成本对比表"） |
| `constraints` | json `string[]` | 硬约束（口径/格式/禁止项/必须引用的来源） |

> 三个字段都进认领包**原文照搬**，不做模型二次概括。卡片上只显示 `title` + 若干 meta，详情抽屉里编辑。

**分类与排序**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `todo\|doing\|done\|dropped` | 见 §3 |
| `priority` | `low\|normal\|high\|urgent` | 默认 `normal`；卡片一个色点，列表排序权重 |
| `rank` | text | 列内排序键（分数序，见 §3.3） |
| `tags` | json `string[]` | 自由标签（筛选用） |
| `dueAt` | timestamp null | 截止时间；过期卡片标红，认领包里也带上 |

**负责人与执行**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ownerKind` | `unassigned\|user\|agent` | 谁在做 |
| `ownerAgentId` | text null | `ownerKind=agent` 时是哪个 Agent |
| `assigneeSessionId` | text null | **执行载体**：认领 / 指派产生的那个工作会话 |
| `lastRunId` | text null | 最近一次执行的 run（详情页"再跑一次"用） |

**认领与并发**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `leaseOwner` | text null | 当前租约持有者 = 会话 id |
| `leaseExpiresAt` | timestamp null | TTL 到期时间（默认 10 分钟，每次相关工具调用续租） |
| `leaseHeartbeatAt` | timestamp null | 最后心跳（排查"为什么被抢了"） |
| `version` | integer | 乐观锁。**所有写操作都带 version**，冲突 409 |

**结果与元数据**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `refs` | json `PlanRef[]` | 材料引用：`{kind:'file'\|'document'\|'session'\|'url', id, title}`。只存引用不存正文 |
| `blockedBy` | json `string[]` | 依赖的其它 item id（写入时查环） |
| `checklist` | json `{id,text,done}[]` | 轻量子步骤（**不做子任务树**，见 §12） |
| `resultSummary` | text null | 完成时的结论（Agent 完成必填，用户标记可空） |
| `closeReason` | text null | `dropped` 的原因 / 重开原因 |
| `completedAt` | timestamp null | 进 `done` 或 `dropped` 时写 |
| `createdAt` / `updatedAt` | timestamp | |

### 2.2 不变式（服务层强制，不是注释）

1. `status ∈ {done, dropped}` ⇒ `completedAt != null`；回 `todo`/`doing` 时清空。
2. `status = done` 且 `ownerKind = agent` ⇒ `resultSummary` 非空（工具侧强制；用户拖拽完成不强制）。
3. `assigneeSessionId != null` ⇒ `ownerKind = agent`（用户自己干是 `ownerKind=user`，不绑会话）。
4. 同一时刻最多一个**未过期**租约；`leaseOwner != null` ⇒ `leaseExpiresAt != null`。
5. `blockedBy` 不得成环，且只能引用**同空间**的 item。
6. 所有写操作走 `version` CAS；**租约持有者之外的写入**在 `status/owner` 类字段上拒绝（`plan_claimed_elsewhere`），`detail/checklist` 等协作字段允许（用户随时能改任务说明）。

### 2.3 谁能创建

| 来源 | 入口 | 备注 |
| --- | --- | --- |
| 用户 | 看板列头「+」、详情抽屉「新建」、概览页快捷入口 | 直接落 `todo` |
| 用户（从会话） | Agent 会话里「存为任务」 | 把当前会话的意图固化成任务，`refs` 自动挂该 session |
| Agent | 工具 `plan_create` | `workspaceId` 取自 run context；单 run 建任务上限 10 条（防任务爆炸） |
| 系统 | 不做 | 不从对话自动抽任务（噪声大，§12） |

---

## 3. 状态机与看板

### 3.1 四列

沿用原型（`everoffice-feature-inventory.zh-CN.md` §3.8）已验证的四列，避免为了"新"而多一列：

| 列 | status | 语义 | 卡片要点 |
| --- | --- | --- | --- |
| 待开始 | `todo` | 认下来了但没人动 / 还没人认领 | 负责人可空（"待认领"） |
| 进行中 | `doing` | 有人（或某个 Agent 会话）在做 | 租约/负责人有值 |
| 已完成 | `done` | 有结论 | `resultSummary` 摘要，完成时间 |
| 已取消 | `dropped` | 不做了 | `closeReason` |

`blocked` **不占列**：它是派生标记（`blockedBy` 里还有非 `done` 的），卡片显示「等待 <title>」，仍留在 `todo`。

### 3.2 迁移矩阵（拖拽语义）

| 从 → 到 | 允许 | 落库动作 |
| --- | --- | --- |
| `todo → doing` | ✅ | 需要执行者：若 `ownerKind=unassigned`，落拖后弹「我来做 / 交给 Agent」；取消则回原位（不写库） |
| `doing → done` | ✅ | 写 `completedAt`；Agent 执行时要求补 `resultSummary`（UI 弹一行输入，可跳过但标注"未填结论"） |
| `doing → todo` | ✅ | 释放执行者：清 `assigneeSessionId` / 租约，**会话保留**为历史（事件里记 `released`） |
| `done → doing` | ✅ | 重开：清 `completedAt` / `resultSummary`，事件记 `reopened` |
| `done → dropped` | ✅ | 直接取消（记 `closeReason` 可空） |
| `dropped → todo` | ✅ | 恢复 |
| 任意 → 自身（同列） | ✅ | **只改 `rank`**，不动状态 |
| 任意 → 任意其它 | ✅ | 统一：写 `completedAt` 规则 + 事件 |

结论：**不设非法迁移**（单机 todo 场景里硬拦只会让用户困惑），代价是每步都要写事件，让时间线可回溯。

### 3.3 排序：分数序 rank

- `rank` 为 base62 字符串，新任务 append 时按当前最大 rank 递增（间隔 1024），拖拽插入取**相邻两条的中点**。
- 理由：拖拽排序是 O(1) 单行更新；用整数序号就得整列重排（看板上百条时明显卡）。
- 中点耗尽（相邻两 rank 相邻）时，对该列做一次局部重排（批量更新几十行，几十次一遇，可接受）。
- 列内查询一律 `order by rank asc`，`rank` 相同再按 `createdAt`。

---

## 4. 认领机制（两条通道都要）

### 4.1 通道 A：用户指派（人对 Agent）

入口：卡片 ⋯ 菜单「交给 Agent」，或拖到「进行中」时选「交给 Agent」。

```
plan:assign(itemId, { agentId? })
  → 网关建会话（pageLabel = 任务标题，workspaceId = 任务的）
  → 用认领包渲染首条 prompt
  → agent.startRun(sessionId, { prompt, idempotencyKey })
  → 回写 item: assigneeSessionId / lastRunId / ownerKind=agent / ownerAgentId / status=doing
  → 返回 { item, sessionId, runId }
```

- 渲染层拿到 `sessionId` 后可直接切到会话视图（与现有 `onOpenSession` 一致）。
- 用户在会话里的追加要求不被任务覆盖：任务只是**入口**，会话是连续工作区。
- 指派即开会话的好处：用户看得见 Agent 在干什么（现有执行时间线、审批卡全部复用），不需要为"认领"发明新的执行视图。

### 4.2 通道 B：Agent 主动认领（Agent 对池子）

工具 `plan_claim({ itemId, note? })`，作用域 = 当前 run 的 `workspaceId`：

| 前置条件 | 不满足时 |
| --- | --- |
| item 存在且属于当前空间 | `plan_scope_mismatch`（403）——跨空间认领一律拒绝，不做"借用" |
| `status = todo`，或 `status = doing` 且租约已过期 | `plan_claimed_elsewhere`（409，附持有者与到期时间） |
| `blockedBy` 中无未完成项 | `plan_blocked`（409，附阻塞项） |
| `version` 匹配 | `plan_version_conflict`（409） |

成功：写租约（`leaseOwner = 当前 sessionId`，TTL 600s）、`status=doing`、`assigneeSessionId = 当前 sessionId`、`ownerKind=agent`、`ownerAgentId = 当前 run 的 agentId`，**返回认领包**。

- **隐式续租**：本会话后续对该 item 的 `plan_get` / `plan_update` 自动续 TTL（不额外发明心跳工具）。
- **释放**：`plan_release({ itemId, reason })` → `status` 回 `todo`、清租约、清 `assigneeSessionId`，`reason` 写事件——下次有人认领时**在认领包的 history 里能看到上次为什么放弃**。
- **过期回收**：读取时惰性判定 + 网关每 60s 扫一次（找 `leaseExpiresAt < now` 且 `status=doing`），置回 `todo` 并记 `lease_expired` 事件。定时器照 `AgentSchedulerService.initialize` 的写法（`setInterval(...).unref()`）。

### 4.3 冲突规则

| 场景 | 规则 |
| --- | --- |
| 用户指派 vs 已有 Agent 租约 | **用户优先**：强制转移（清旧租约 + 事件 `lease_preempted`），旧会话下次调用相关工具收到"任务已被转走" |
| 两个 Agent 同时认领 | `version` CAS：后到者 409 + 当前快照（UI/模型都能重试或换一条） |
| 同会话重复认领同一 item | 幂等：直接返回认领包，不报错 |
| 用户拖拽 vs Agent 同时写 | 双向 CAS；冲突方收到 409 + 最新快照，渲染层刷新并提示「刚被 Agent 更新」 |
| Agent 在租约内被用户改 `detail` | 允许（协作字段），Agent 下次 `plan_get` 看到最新 |

### 4.4 自动认领（P3，默认关）

「空间自动推进」开关：网关 tick 每 60s 挑 `status=todo && ownerKind=unassigned && priority ∈ {high,urgent} && (dueAt 为空或未过期)` 的最多 1 条，起会话认领。默认关闭，因为"没人叫它也自己开工"是产品决策，不是技术决策。

---

## 5. 认领包（claim package）—— 本设计的关键契约

用户的核心诉求：**"Agent 认领的时候要知道必要的上下文"**。这不等于"把这条任务相关的所有东西都塞进 prompt"。定义为 `PlanClaimPackage`：

```ts
interface PlanClaimPackage {
  /** 1. 意图层：人写的，原文照搬，不做概括 */
  item: {
    id: string; workspaceId: string;
    title: string; detail: string | null;
    acceptance: string | null; constraints: string[];
    priority: PlanPriority; dueAt: string | null;
    tags: string[]; checklist: Array<{ id: string; text: string; done: boolean }>;
    status: PlanStatus;
  };
  /** 2. 来由：谁、什么时候、为什么建这条 */
  why: { createdBy: "user" | "agent"; createdByLabel: string; createdAt: string; assignReason: string | null };
  /** 3. 工作根：空间目录（未绑定目录时为 null，此时不承诺能读写磁盘） */
  space: { name: string; root: string | null; libraryPath: string | null; artifactsPath: string | null };
  /** 4. 材料：只给引用 + 可读性提示，正文由 Agent 自己用工具取 */
  materials: Array<{ kind: "file" | "document" | "session" | "url"; id: string; title: string; hint: string }>;
  /** 5. 历史：最近 8 条事件（含上次失败/释放/抢占原因） */
  history: Array<{ at: string; kind: string; actor: string; summary: string }>;
  /** 6. 依赖现状 */
  dependencies: Array<{ id: string; title: string; status: PlanStatus }>;
  /** 7. 写回契约：完成后怎么算完 */
  contract: {
    mustUpdateStatus: true; mustWriteResultSummary: true;
    leaseTtlSec: number; outputHint: string | null;
  };
}
```

四条组装原则（要写进代码注释，防止后人"顺手加个全量上下文"）：

1. **意图层原文照搬**：`detail` / `acceptance` / `constraints` 不改写。模型自己判断轻重。
2. **材料层只给引用**：`refs` 展开成 `fileId` / `documentId`，Agent 用 `file_read` / `library_browse` / `file_search` 自己取正文。理由与本仓库已有结论一致：资料库可能上千份，"最近 N 条抽样快照"会误导模型以为自己看完了（`packages/agent-contract/src/index.ts:1549` 的 `AgentLibraryInventory` 注释）。
3. **历史层封顶 8 条**：重点是「上次为什么没做完」（`released` / `lease_expired` / run 失败原因），避免同一个坑踩两次；再多就挤占上下文。
4. **契约层写清可写回的位置**：产物落 `artifactsPath` / 产物库；完成必须 `plan_update(status=done, resultSummary=...)`。

**明确不放进认领包**：整段会话历史、全库文件清单、记忆全量、其它任务的内容。需要时 Agent 用现有工具自己取（`memory` / `library_browse` / `plan_list`）。

渲染成 prompt 的形状（通道 A 用，也给通道 B 的工具返回文本复用）：

```markdown
### 任务
<title>

### 背景与要求
<detail>

### 验收标准
<acceptance>

### 约束
- <constraint>…

### 材料（自行读取）
- [file] 第三季度成本表.xlsx（fileId: …）
- [document] 立项方案 v3（documentId: …）

### 历史
- 11/02 14:20 release（Agent main）：缺少 2025 年的成本数据，等用户补

### 完成要求
- 产物写到 <artifactsPath 或产物库>
- 完成后调用 plan_update，把 status 改为 done，并写 resultSummary（一句话说明交付了什么、有哪些已知缺口）
```

---

## 6. 数据面

### 6.1 新表（迁移 `apps/gateway/drizzle/0098_workspace_plan_items.sql`）

```sql
CREATE TABLE workspace_plan_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  acceptance TEXT,
  constraints TEXT,            -- JSON string[]
  status TEXT NOT NULL DEFAULT 'todo',     -- todo|doing|done|dropped
  priority TEXT NOT NULL DEFAULT 'normal', -- low|normal|high|urgent
  owner_kind TEXT NOT NULL DEFAULT 'unassigned',
  owner_agent_id TEXT,
  assignee_session_id TEXT,
  last_run_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  created_by_agent_id TEXT,
  due_at INTEGER,
  rank TEXT NOT NULL,
  tags TEXT,                    -- JSON string[]
  checklist TEXT,               -- JSON [{id,text,done}]
  refs TEXT,                    -- JSON PlanRef[]
  blocked_by TEXT,              -- JSON string[]
  result_summary TEXT,
  close_reason TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  lease_heartbeat_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX plan_items_ws_status_rank_idx ON workspace_plan_items (workspace_id, status, rank);
CREATE INDEX plan_items_ws_updated_idx      ON workspace_plan_items (workspace_id, updated_at);
CREATE INDEX plan_items_assignee_idx        ON workspace_plan_items (assignee_session_id);
CREATE INDEX plan_items_lease_idx           ON workspace_plan_items (status, lease_expires_at);

CREATE TABLE workspace_plan_item_events (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES workspace_plan_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,           -- created|updated|moved|claimed|released|assigned|lease_expired|lease_preempted|completed|reopened|dropped
  actor_kind TEXT NOT NULL,     -- user|agent|system
  actor_id TEXT,
  from_status TEXT,
  to_status TEXT,
  summary TEXT NOT NULL,        -- 一句话（时间线直接显示）
  payload TEXT,                 -- JSON 细节（旧值/新值/释放原因）
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX plan_events_item_idx ON workspace_plan_item_events (item_id, created_at);
```

drizzle 定义追加在 `apps/gateway/src/infrastructure/database/schema.ts` 末尾（journal 之后），命名 `workspacePlanItems` / `workspacePlanItemEvents`；JSON 列用 `text(..., { mode: "json" }).$type<...>()`，与 `agentWorkspaces.goals` 同款。

### 6.2 为什么事件表不是可选项

- 卡片详情的时间线（"谁改的、为什么回退"）直接取自它。
- 认领包的 history 取自它——**这是"上次为什么没做完"的唯一可靠来源**。
- 实时推送给看板的 payload 也复用它。
- 用户误拖拽的理解成本靠它兜底（没有撤销按钮也能看懂发生了什么）。

### 6.3 迁移与兼容

- 全新表，不动老表，无回填。
- 老「计划」页的会话看板不再重复：会话本来就在侧栏「工作 N」列表里（`WORK_SESSION_STATUS_META` 继续只服务侧栏）。
- 降级：无 `plan_*` 端点时渲染层显示空态 + 「当前版本不支持计划」弱化提示（照 `useDailyJournal` 的 `unavailable` 分支）。

---

## 7. 接口面

### 7.1 网关模块 `apps/gateway/src/modules/plan/`

照 `modules/journal/{service,routes,index}.ts` 的形状：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/plan/items?workspaceId=&status=&owner=&q=&limit=` | 看板一次拉全空间（上限 500，按 status+rank 排序） |
| POST | `/v1/plan/items` | 建任务（title 必填） |
| GET | `/v1/plan/items/:id` | 详情 |
| PATCH | `/v1/plan/items/:id` | 改字段（body 带 `version`） |
| POST | `/v1/plan/items/:id/move` | `{ status, beforeId?, afterId?, version }` → 算 rank + 状态迁移 + 事件 |
| POST | `/v1/plan/items/:id/claim` | Agent 认领（`{ note? }`）→ 认领包 |
| POST | `/v1/plan/items/:id/release` | `{ reason }` |
| POST | `/v1/plan/items/:id/assign` | 用户指派（`{ agentId? }`）→ `{ item, sessionId, runId }` |
| DELETE | `/v1/plan/items/:id` | 硬删（P1 用 `POST …/drop` 替代，见下） |
| GET | `/v1/plan/items/:id/events` | 时间线 |

删除语义：**默认不给硬删**，用户删卡片 = `status=dropped`（可恢复）；「彻底删除」只在 `dropped` 且 30 天后的清理里做（P3）。理由：一张卡片可能是某个 Agent 会话的唯一线索。

错误码：`plan_item_not_found`(404)、`plan_version_conflict`(409)、`plan_claimed_elsewhere`(409)、`plan_blocked`(409)、`plan_scope_mismatch`(403)、`plan_dependency_cycle`(400)、`plan_invalid_input`(400)。

### 7.2 桌面 IPC

| 层 | 改动 |
| --- | --- |
| `apps/desktop/src/main/index.ts` | 新增 `PLAN_CHANNELS`（`plan:list/create/get/update/move/claim/release/assign/events`），`handle` 里转发 bridge（照 `JOURNAL_CHANNELS` 位置，`:346` / `:2170`） |
| `apps/desktop/src/main/gateway/agent-gateway-bridge.ts` | 新增 `listPlanItems / createPlanItem / …`（照 `getJournalToday`，`:222`） |
| `apps/desktop/src/preload/index.ts` | 新增 `plan: { … }`（照 `journal`，`:456`） |
| `apps/desktop/src/shared/sources.ts` | `NxcoreApi` 接口补 `plan`（照 `:990`） |

quiet 取舍：**读用 `invokeQuietly`**（看板自己渲染空/错态），**写用普通 `invoke`**（`move`/`assign` 失败必须冒泡，好让看板回滚 + toast）。

### 7.3 共享契约

新增到 `packages/agent-contract/src/index.ts`（网关、渲染层、工具三处共用，防 DTO 漂移）：

`PlanStatus`、`PlanPriority`、`PlanOwnerKind`、`PlanRef`、`PlanChecklistItem`、`PlanItem`、`PlanItemEvent`、`PlanClaimPackage`、`CreatePlanItemInput`、`UpdatePlanItemInput`、`MovePlanItemInput`、`PlanItemListQuery`。

---

## 8. Agent 工具面

在 `create-server.ts` 的 `primaryIntegrations.tools`（`:759` 起）追加 `createPlanPiTools({ plan })`，实现放 `apps/gateway/src/modules/plan/pi-tools.ts`（照 `web-search-tools.ts` / `notifications/pi-tools.ts`）。

| 工具 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `plan_list` | `{ status?, owner?, q?, limit? }` | 卡片摘要数组（不含 detail） | 找活儿干 |
| `plan_create` | `{ title, detail?, acceptance?, constraints?, priority?, dueAt?, refs?, status? }` | item | Agent 也能建任务（"这件事我后续要处理"） |
| `plan_get` | `{ itemId }` | **认领包**（未认领 = 预览包，`contract` 置空） | 认领前必读 |
| `plan_claim` | `{ itemId, note? }` | 认领包 + 租约信息 | 见 §4.2 |
| `plan_update` | `{ itemId, status?, resultSummary?, checklist?, note? }` | item | 推进状态、勾 checklist、写结论 |
| `plan_release` | `{ itemId, reason }` | item | 干不动就放回去，**reason 会成为下一位的线索** |

`promptGuidelines` 必须写明（这些直接决定 Agent 行为质量）：

- 用户提到"计划里的某件事"/"之前那条任务"时，先 `plan_list` 再 `plan_get`，**不要凭记忆猜**。
- 认领前看 `acceptance` 与 `dependencies`；材料用 `file_read` / `document_read` 自己取，不要假装读过。
- 同一 run 内最多认领 3 条，避免并行摊薄质量。
- 任务做完必须 `plan_update(status='done', resultSummary=...)`；做不完必须 `plan_release` 写原因——**不要静默放弃**。
- 不能改别人租约内的任务；不能跨空间。

`agents/main/SYSTEM.md`（现 88 行）加一节「计划与认领」，讲清「计划 = 空间待办池、认领 = 租约 + 认领包、完成 = 写回结论」三件事，`promptSnippet: "认领计划任务"`。

P2 顺带给 MCP 面暴露同名工具（照 `agent-scheduler/mcp-routes.ts`），让外部 Agent 也能认领。

---

## 9. 渲染层

### 9.1 结构与状态

```
workbench/workspace/
  PlanPage.tsx          容器：取数、拖拽编排、乐观更新、toast（沿用 WorkspacePageProps）
  plan/PlanBoard.tsx    四列布局 + 顶部工具条（搜索/筛选/新建）
  plan/PlanColumn.tsx   列头（圆点/名/计数/+）、空列占位、drop 目标
  plan/PlanCard.tsx     卡片（标题 + meta + 关联会话 + hover 菜单）
  plan/PlanItemDetail.tsx  右抽屉：编辑 detail/acceptance/constraints/refs/checklist + 时间线
  plan/planDrag.ts      纯函数：resolveDrop(items, dragId, column, index) -> {status, rank}
  plan/usePlanItems.ts  hook：list/create/update/move + 轮询刷新
```

**状态提升**：`usePlanItems(workspaceId)` 的结果挂在 `WorkspaceTabHost` 注入的 pageProps 上（与 `sessions` 同级），不放页面局部 state —— 原型期切页重置的坑（§1 第 6 条）不能再踩。

### 9.2 拖拽实现

- **原生 HTML5 DnD**（仓库无 dnd 依赖，原型 `PlanKanban` 就是这么做的；Electron 桌面无触屏需求）。`draggable` + `dataTransfer.setData('application/x-plan-item', id)`；列与卡片都是 drop 目标（卡片上半 = 插到前面，下半 = 插到后面）。
- **落点算法是纯函数** `resolveDrop()`，单测直击（不引入 UI 测试负担）：给定拖拽项、目标列、目标索引 → 新 `status` + 新 `rank`（相邻两 rank 中点）。
- **乐观更新**：先改本地 → 发 `move` → 409/失败则整体回滚 + toast「刚被 Agent 更新，已刷新」。
- 拖到「进行中」且未指派 → 弹执行者选择（我来做 / 交给 Agent）；选「取消」回原位**不发请求**。
- 拖到「已完成」时若有未勾的 `checklist` / 空 `acceptance` → 轻提示「还有 2 个检查项未完成」，允许继续（不拦）。
- 视觉：拖动卡片 `opacity: .5`，目标列背景高亮（原型手感），`prefers-reduced-motion` 下关过渡（`tools.css:171` 已有先例）。

### 9.3 卡片信息层次

```
┌──────────────────────────────────────┐
│ ● 整理 Q3 成本对比表                  │  ← priority 色点 + 标题（2 行截断）
│ 王小雨 · 11/05 截止 · 2 材料 · 3/5    │  ← 负责人 chip / 截止（过期红）/ 材料数 / checklist
│ ⟳ 会话「成本表整理」 刚刚               │  ← 关联会话（有则显示，点击跳转）
└──────────────────────────────────────┘
```

- `createdBy=agent` 的卡片右上角一个小 `AI` 角标（用户删起来心里有数）。
- hover 出 `⋯`：编辑 / 交给 Agent / 复制 / 取消。
- 阻塞中的卡片显示 `等待 <title>`，弱化色。

### 9.4 页面骨架

- 顶部工具条：搜索框 · 筛选（全部 / 我的 / Agent 的）· 主按钮「新建任务」；「新建工作」降为次要按钮（保留纯会话入口）。
- 列头：圆点 + 名称 + 计数 + `+`（行内 input，Enter 落 `todo`，Esc 取消 —— 沿用原型手感）。
- ≤960px 纵向堆叠（`tools.css:40` 的媒体查询已有先例）。

### 9.5 实时

- **P1**：写操作后本地失效 + 页面可见时 30s 轮询（照 `slides.pageImagesStatus` 的轮询先例，够用且零新协议）。
- **P2**：Agent 认领/推进要能"卡片自己动"。加 `/v1/plan/stream`（SSE，按 `workspaceId` 分房间），桌面主进程转成 `plan:changed` 事件推给渲染层。复用 `AgentEventBroker` 的分房间模式，但**不要**塞进 `agent:subscribe`（那是按 sessionId 的，看板不吃会话）。

---

## 10. 与现有模型的关系

| 关系 | 结论 |
| --- | --- |
| 任务 ↔ 会话 | 会话是**执行载体**，一条任务可以有 0..n 个会话（重开就换一个）；卡片显示最新一个，历史在详情时间线里 |
| 会话有任务吗 | 可以没有（纯聊天）；任务可以没有会话（纯记录/待办） |
| 侧栏「工作 N」列表 | 保留不动（会话仍是导航单位）；计划页不再重复列会话 |
| `agent_schedules`（定时任务） | 无关。定时任务 = 定时起会话，不产生计划项。P3 可选：定时任务的产出自动落一张 `createdBy=agent` 的卡片 |
| 空间目录（`project-space-layout-plan`） | 认领包的 `space` 字段取自 `WorkspaceLayoutService.pathsOf()`；未绑定目录时 `root=null`，认领包里明确"不能承诺读写磁盘" |
| 记忆 / 今日洞察 | P3：任务 `done` 写一条记忆信号（`plan.completed`），让今日洞察能说"今天推进了 3 件事" |

---

## 11. 分期与验收

### P0 · 数据 + 只读看板（无拖拽）

表 + 迁移 + `PlanService` + `routes` + bridge/IPC + `usePlanItems` + PlanPage 渲染真数据 + 详情抽屉（只读）。

**验收**：库里插两条 item，看板四列正确显示、计数对、详情能开、空态正常；`GET /v1/plan/items?workspaceId=` 只返回本空间。

### P1 · 写通道（用户可用）

`POST` / `PATCH` / `move` + 拖拽改状态与排序 + 乐观更新与回滚 + 行内新建 + 编辑/取消 + 事件时间线。

**验收**：拖 10 次（含跨列、同列、拖回原地）库里 `status`/`rank` 与看板一致；断网/网关挂掉时卡片回滚并提示；两窗口同开一个空间，A 改 B 刷新后一致（不需要实时，刷新即可）。

### P2 · Agent 面（认领）

`plan_*` 六件工具 + 认领包组装 + 租约/续租/过期回收/抢占 + `assign` 即开会话 + `SYSTEM.md` 指引 + SSE 实时。

**验收**：
1. 会话里说"计划里那条成本表的活儿你来做" → Agent `plan_list` → `plan_get` → `plan_claim`，卡片变「进行中 · Agent main」，详情时间线出现 `claimed`。
2. Agent 中途 `plan_release`（写原因）→ 卡片回「待开始」，时间线有原因；下一个认领者 `plan_get` 的 history 里能看到这条。
3. 用户对已被认领的任务点「交给 Agent（另一个）」→ 抢占成功，旧会话下次写该任务收到 `plan_claimed_elsewhere`。
4. 认领包快照测试：`detail`/`acceptance`/`constraints` 原文出现、材料只给引用（无正文）、history 上限 8 条。

### P3 · 打磨

自动认领开关、记忆联动、MCP 暴露、批量操作（多选移动/取消）、任务模板、`dropped` 30 天后清理。

---

## 12. 非目标

- **不做**跨空间任务、空间共享看板、任务指派给"人"（单机单用户）。
- **不做**甘特图 / 依赖图可视化（`blockedBy` 只在卡片上提示）。
- **不做**评论与 @人（要协作先上多端同步）。
- **不做**子任务树（`checklist` 够用；真需要再升 `parentId` + 树查询）。
- **不做**从对话自动抽取任务（噪声大，且会让 Agent 疯狂建卡）。
- **不做**任务级权限（空间即边界）。

---

## 13. 测试要点

| 层 | 测什么 |
| --- | --- |
| `PlanService` 单测 | 状态迁移矩阵全覆盖、`completedAt`/`resultSummary` 不变式、rank 中点插值与耗尽重排、`blockedBy` 环检测、`version` CAS 冲突、租约过期回收与抢占、跨空间拒绝 |
| `routes` 单测 | 错误码映射（404/409/403/400）、`move` 的 `beforeId`/`afterId` 语义 |
| `planDrag.resolveDrop` | 纯函数：首/中/尾插入、跨列、空列、相邻 rank 耗尽 |
| `PlanPage` 渲染 | 假数据 + `WorkspacePageProps` 注入（沿用现有单测做法），空态/错误态/回滚提示 |
| 认领包 | 快照测试（防上下文退化）+ 大小上限断言（history ≤ 8、materials 只含引用字段） |
| 手工 | 两窗口并发、网关重启后租约自愈、Agent 会话删除后卡片状态不悬空（`assigneeSessionId` 置空 + 事件） |

---

## 14. 风险与取舍

| 风险 | 取舍 |
| --- | --- |
| 认领包太长挤占上下文 | history 封顶 8 条、材料只给引用、`plan_get` 可只取摘要（`{ compact: true }`）。宁可让 Agent 多调一次工具，也不塞一份"什么都有一点"的包 |
| 拖拽乐观更新与 Agent 并发写打架 | 单一 `version` CAS + 409 带最新快照；UI 回滚并提示"刚被 Agent 更新"，不做自动重放（重放会悄悄改用户意图） |
| Agent 建卡刷屏 | 单 run 建卡上限 10；`createdBy=agent` 有角标；筛选器可一键看/清 Agent 建的卡 |
| 用户对"任务 ≠ 会话"的心智迁移 | 侧栏「工作 N」原样保留，计划页卡片上的会话入口叫「会话」而不是「打开」，语义分得开 |
| 空间未绑目录时 Agent 干不了活 | 认领包里 `space.root=null` 直接说明；UI 在卡片详情提示"绑定空间目录后 Agent 才能读写文件"（不阻断认领，只做能力降级） |
| `dropped` 语义被当删除用 | 卡片菜单写「取消」而不是「删除」；详情页给「恢复」；真删除只在 P3 的清理任务里 |

---

## 附录：与 `product-data-map` 的差异

`docs/design/product-data-map.zh-CN.md:357` 写的「接受只读可零后端先上」是当时的权宜判断。本方案明确**不接受只读终态**：任务对象是空间的产品骨架（用户与 Agent 的共同待办池），拖拽与认领是它的核心交互，用会话状态推导出来的看板永远表达不了"没人开工"和"做完了要验收"。一旦要真做，`workspace_plan_items` + 事件表 + `plan:*` 通道就是最小集，没有更小的可行版本。

---

## 15. 实现落点（P0–P3，2026-11-03）

### 15.1 落地文件

| 层 | 文件 |
| --- | --- |
| 契约 | `packages/agent-contract/src/index.ts`（`PlanItem` / `PlanItemEvent` / `PlanClaimPackage` / `formatPlanClaimPackage` / `PlanChangePayload` / `PlanBatchInput`） |
| 数据 | `apps/gateway/src/infrastructure/database/schema.ts`（`workspacePlanItems` / `workspacePlanItemEvents`）、`apps/gateway/drizzle/0098_workspace_plan_items.sql` + `meta/_journal.json` |
| 服务 | `apps/gateway/src/modules/plan/{service,rank,claim-package,routes,pi-tools,mcp-routes,scheduler,stream,index}.ts` |
| 接线 | `apps/gateway/src/server/create-server.ts`（PlanService + 工具 + 路由 + MCP + 回收器 + 记忆联动）、`agents/main/SYSTEM.md`（「计划与认领」一节 + 路由表一行） |
| 桌面 | `main/gateway/agent-gateway-bridge.ts`（plan 方法 + SSE 订阅）、`main/index.ts`（`PLAN_CHANNELS`）、`preload/index.ts`、`shared/sources.ts` |
| 渲染 | `workbench/workspace/PlanPage.tsx`、`workbench/workspace/plan/{planDrag,usePlanItems,PlanBoard,PlanColumn,PlanCard,PlanItemDetail}.tsx/css`、`workbench/api.ts` |
| 测试 | `apps/gateway/tests/plan.test.ts`（22）、`apps/gateway/tests/plan-routes.test.ts`（5）、`apps/desktop/.../plan/planDrag.test.ts`（17） |

### 15.2 与设计的三处偏差（都是有意的）

1. **看板数据放 `usePlanItems` hook，而不是提升到 `WorkspaceTabHost` 的 pageProps**（原文 §9.1 写的是后者）。理由：服务端是唯一权威，切页回来重新拉一次就够；跨页缓存的代价是"改了没落库"的假状态更难排查。原型期"切页丢数据"的问题是**没有落库**，不是"没有跨页缓存"。
2. **实时用 SSE（`GET /v1/plan/stream`）+ 桌面主进程转发 `plan:changed` + 30s 兜底轮询**，没有复用 `AgentEventBroker`（它按 sessionId 分房间，看板要的是"整个空间"）。断线 1s 重连，丢一条也只是下一次轮询补齐。
3. **认领包的 `space` 字段在空间未绑目录时全为 null**，`contract.outputHint` 也置空——不假装 Agent 能往磁盘写。

### 15.3 P3 的落地细节

| 项 | 实现 | 开关 |
| --- | --- | --- |
| 自动认领 | `PlanService.autoClaim()`：挑「待开始 + 未指派 + urgent/high + 未过期 + 无未完成依赖」**一条**起会话 | `NXCORE_PLAN_AUTO_CLAIM=1`（默认关） |
| 已取消清理 | `PlanService.cleanupDropped(30)`，回收器每天跑一次 | `NXCORE_PLAN_RETENTION_DAYS`（默认 30，0 = 关） |
| MCP 暴露 | `POST /v1/mcp/plan`（`plan_list/get/create/claim/update/release`），与内置工具共用服务与租约 | 默认开 |
| 批量操作 | `POST /v1/plan/items/batch` + 看板「多选」批量条；逐条 CAS，单条失败记入 `failed` 不回滚其它 | 默认开 |
| 记忆联动 | 任务 `done` 时写一条 `plan/task/completed` 记忆（`category=fact`、`confidence=inferred`），今日洞察可引用 | 默认开（失败只记 warn，不影响状态写入） |

### 15.4 验证

- 单测：`apps/gateway/tests/plan.test.ts`（22）、`apps/gateway/tests/plan-routes.test.ts`（5，含 assign 起会话与 MCP）、`apps/desktop/.../plan/planDrag.test.ts`（17）、`apps/desktop/tests/workbench-workspace-tools.test.tsx`（7，计划看板四列/详情/空态/新建）全绿。
- 类型：`@nxcore/agent-contract` 与计划相关文件（gateway `modules/plan/**`、desktop bridge/main/preload/PlanPage）`tsc --noEmit` 无错。
- 说明：本工作树当时有其它并行改动（`packages/agent-runtime-pi` 的 memory 重构、新增 `modules/workspace-activity`、`hippo-memory` 版本升级），会让整包 `pnpm typecheck` 在工作树里临时报错；这些错误都不在计划模块的文件里，属于并行改动，本批未介入。同理 `database-migrations.test.ts` 的「pre-merge Yjs 分支」用例在本批改动前就已失败。
- 已知边界：SSE 端点无法用 `app.inject` 断言（长连接），因此只覆盖了"写操作 → 事件表 → 渲染层按 id upsert"这条链，SSE 本身靠桌面端 1s 重连 + 30s 兜底轮询兜住。

### 15.5 还没做的（明确的后续项）

- 卡片拖拽不支持触屏 / 键盘排序（桌面端无触屏场景；键盘只支持 Enter 打开详情）。
- 任务级评论与 @人（等多端同步）。
- 子任务树（`checklist` 够用）。
- 依赖可视化（只有卡片上的「等待 X」）。
