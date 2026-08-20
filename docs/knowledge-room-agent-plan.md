# Knowledge 管线 Agent 化：转正登记 Agent + Room Profile 增量刷新

> 状态：方案评审稿 v2（2026-08-21，v1 为单一 summary 版，v2 扩展为结构化 Room Profile）
> 关联文档：[entity-room-plan.md](entity-room-plan.md)（实体/Room 模型）、[room-wiki-plan.md](room-wiki-plan.md)（wiki 沉淀语义）

## 1. 背景与目标

当前 Room 信息（`rooms.summary`）全库只有一个写入点——晋升 job 的一次性 INSERT（`service.ts` `runPromotionJob`），之后资料再多也永不更新；渲染器侧 `mergeAutoKnowledgeRooms` 对已有 Room 只增不改，导致 `ContextRoomRecord` 里 `brief.goal/status/risks/decisions`、`people`、`timeline` 等字段全是创建时的空值/占位文案。本方案：

1. **`registerEntity`（晋升"转正登记"）从单发 LLM 升级为 agent**——带只读工具读实体的真实关联文档/wiki，产出完整的 Room 身份材料（见 §1.2 Profile 契约）。
2. **资料增量/更新后刷新 Room Profile**——wiki 侧重沉积 + re-ingest 已自动（`rawWrite` 同名覆盖 + KS merge，全资料类型统一走 ingest confirm 汇聚点），缺的是沉淀确认后 Room 信息的再综合，本方案补齐这条管线。
3. 范围决策（已确认）：
   - **全部 Room**（用户创建 / 已认领 / 未认领 auto）无条件自动刷新；
   - **不做锁定开关**——用户暂不能编辑简介，无覆盖冲突；
   - 触发用**去抖合并**（不每份资料跑一次 agent）；
   - agent 的降级链：agent → 单发 `KnowledgeLlm` → 非 LLM 兜底，任何一层失败不阻塞主流程；
   - **本方案只做 agent 侧（需要综合判断的字段）**；`stats` 等纯派生统计的实时化走查询接口，另议（见 §6.2 后续）。

### 1.1 已确认的可行性（探索结论）

- 仓库已有完整**无头 agent 模式**可复用：`createConnectorSyncAgentRuntime`（runtime-factory.ts，`backgroundPi` 配置 + 独立 session 目录 + `includeBashTool: false` + `maxToolCallsPerRun` 封顶）+ `TranscriptionSummaryService.summarize`（processing/service.ts，"JSON prompt → 抓 `message.completed`"最小配方）。与用户聊天 agent 的隔离是三层的：独立 runtime 实例（并发守卫仅实例内生效）+ 独立 session 目录（`assertOwnedSessionRef` 强制）+ `backgroundPi` 独立模型配置（可配不同模型/apiKey），互不阻塞。
- `RoomDto`（routes.ts:16）已含 `summary` 与 `updatedAt`，需扩展 `profile`；`listRooms()` 无参即返回全 origin——渲染器拉全量只需改一处调用。
- jobs 表 `payload` 是 JSON text，新增 job type **零 DDL**；但 profile 扩展需要**一个新迁移**（`0018`，rooms 加 `profile` JSON 列）。

### 1.2 Room Profile 契约（agent 的产出物）

一次 agent run 产出整个 profile（替代 v1 的单一 summary）：

```ts
interface RoomProfile {
  /** ≤200 字综合简介（原 summary 的职责） */
  summary: string;
  /** 从资料推断的 Room 当前目标 */
  goal: string;
  /** 当前状态一句话（渲染器"当前状态 AI"卡） */
  status: string;
  /** ≤3 条当前风险/阻塞 */
  risks: string[];
  /** ≤3 条已形成的关键结论 */
  decisions: string[];
  /** 资料中识别到的关联人物（name + 在资料中的角色） */
  people: Array<{ name: string; role: string }>;
  /** 资料中明确可考的关键事件（时间取资料中明确出现的日期） */
  timeline: Array<{ time: string; title: string; description: string; kind: "done" | "warn" | "info" }>;
}
```

字段分层原则：

| 类别 | 字段 | 更新方式 |
|---|---|---|
| **A. 需要综合判断**（agent 的活） | profile 全部字段 | agent 刷新，整体生成、整体覆盖 |
| **B. 纯派生统计** | `stats.*`、`riskCount`、`pendingMemoryCount` | **不进 agent**——查询/计数即得，LLM 生成会过时漂移；实时化另议 |
| **C. 用户所有** | `title`、`kind`、`origin`、`starred` | agent 不碰（title 由用户 rename/晋升登记拥有） |

## 2. 架构总览

```
资料进入（doc 保存 / 文件重传 / 连接器信封，全类型统一）
  → route → ingest job ──confirm──┐
                                  ├─→ markSummaryDirty(roomId)   [内存去抖]
晋升 backlog 沉淀 ──confirm──────┘         │
                                           ▼ N=3 份 或 安静 M=10min
                                  insertJob(knowledge.profile-refresh)
                                           │ worker（与 ingest 同 roomId 锁串行）
                                           ▼
                              runProfileRefreshJob(roomId)
                             ┌─ agent（只读工具：wiki/文档/链接）
                             ├─ 降级：单发 KnowledgeLlm（room 域输入，产出同契约 profile）
                             └─ 再降级：保旧 profile（warn 日志）
                                           │
                                           ▼
                              UPDATE rooms.profile (+ summary 冗余)
                                           │ 渲染器 5s 轮询 listRooms()
                                           ▼
                        mergeKnowledgeRooms → brief.{background,goal,status,risks,decisions}
                                            + people + timeline
```

## 3. Gateway 实现

### 3.1 数据库迁移（新）

`apps/gateway/drizzle/0018_room_profile.sql` + `schema.ts` rooms 表加列：

```ts
/** Room Profile（agent 综合产出，整体生成整体覆盖；null = 尚未生成）。 */
profile: text("profile", { mode: "json" }).$type<RoomProfile | null>(),
```

单 JSON 列而非拆 7 列：profile 本来就是一次 run 整体产出、整体覆盖，无字段级独立写入需求。`summary` 列保留——refresh 时同步写 `profile.summary`（冗余），因为 `summary` 已被 wiki 身份卡、实体登记等多处消费，避免读侧全部改造。

`RoomProfile` 类型定义放 `room-agent.ts` 并从 schema.ts / DTO 侧复用（或放独立的 `room-profile.ts` 避免反向依赖，实现时定）。

### 3.2 新建 `apps/gateway/src/modules/knowledge/room-agent.ts`

不 import service.ts（避免环），全部构件无状态：

**`KnowledgeRoomAgentDeps` 接口**——由 service 的 `roomAgentDeps()` 绑定：

| 访问器 | 数据来源 |
|---|---|
| `resolveWikiId(roomId)` | `registry.resolveRoomWikiId` |
| `listWikiPages(wikiId)` / `readWikiPage(wikiId, ref)` | ks-client |
| `listMaterials(roomId)` | 复用 `roomMaterials()`（roomDocumentLinks ⨝ documents） |
| `linkedSourcesOfRoom(roomId)` | routeDecisions：primaryRoomId 或 ingest ledger 命中本房 |
| `documentMarkdownOf(documentId)` | `getDocument` + `tiptapToMarkdown`（纯正文，无 frontmatter） |
| `linksOfEntity(entityId)` | entityRegistry |
| `decisionSnapshotOf(sourceKind, sourceId)` | 最新 routeDecisions 的 sourceMarkdown 快照 |

**`createKnowledgeRoomAgentTools(deps): PiAgentRuntimeTool[]`**——5 个只读工具，按 `input.sessionId` 前缀分发上下文（`knowledge-register:<entityId>` / `knowledge-profile:<roomId>`）：

| 工具 | 参数 | 上下文 | 行为 |
|---|---|---|---|
| `entity_links` | 无 | register | `linksOfEntity`，≤50 条 JSON |
| `source_read` | `{sourceKind, sourceId}` | 两者 | everroom-doc → `documentMarkdownOf`；外部源 → `decisionSnapshotOf`；截 32KB |
| `room_wiki_list` | 无 | profile | `resolveWikiId` + `listWikiPages`；无 wiki 返回 `{pages: []}` |
| `room_wiki_read` | `{path}` | profile | `readWikiPage` 截 24KB |
| `room_materials` | 无 | profile | materials + linkedSources 合并清单 |

工具体整体 try/catch，失败返回 `{content: JSON.stringify({error})}`——**KsBusyError 绝不逃出工具**（否则会触发 job 级 busy 退避语义）。

**`buildRegisterTaskPrompt` / `buildProfileRefreshTaskPrompt`**——pi runtime 系统提示是固定中文工作台文案（无 per-agent hook），行为塑造全靠任务提示：

- 说明可用工具与任务目标
- register：产出 `{name, summary, aliases}`（契约不变，复用 `parseRegisterResponse`）；晋升时的初始 profile 可选产出——首版保持 register 只出身份材料，profile 留给首轮流亡 refresh 生成（简化 register 契约）
- refresh：产出完整 `RoomProfile` JSON；强调"只综合已沉淀材料、增量改写"、"timeline 只收资料中明确可考的事件与日期，相对日期不硬转"、"people/risks/decisions 没有就不硬凑（空数组合法）"；附 room title/kind/当前 profile 供增量改写
- **严格裸 JSON，禁围栏禁解释**

**`parseRoomProfileResponse(content): RoomProfile`**——新解析器（镜像 `llm.ts` 的严格解析风格）：逐字段类型校验、字符串截断（summary/goal/status ≤500 字、risks/decisions 条目 ≤200 字且 ≤3 条、people/timeline ≤10 条）、timeline.kind 三值枚举、缺失的可选字段给空默认值（空数组/空串）而非解析失败。

**`runKnowledgeAgentTask(runtime, {sessionId, pageLabel, prompt, timeoutMs=5min}): Promise<RegisterResult | RoomProfile>`**——照 `TranscriptionSummaryService.summarize` 配方：

- `start({runId: randomUUID(), sessionId, runtimeSessionRef: null, roomId: null, captureMemory: false, prompt})`
- for-await 事件流取最后 `message.completed` 的 content；`run.failed/cancelled/interrupted` 抛错
- **`Promise.race` 超时**（唯一 hang 兜底，runtime 无内建超时；超时先 `runtime.cancel(runId)` 再抛错）
- 解析（register 用 `parseRegisterResponse`，refresh 用 `parseRoomProfileResponse`）失败带错误反馈重试一次（镜像 `chatJson` 两次尝试），再失败抛错
- `finally` `runtime.deleteSession(runtimeSessionRef)`（每次 run 全新 session，不留状态）

**`ProfileRefreshScheduler`**——可独立单测的小类（v1 的 SummaryRefreshScheduler 改名，语义不变）：

- 构造 `{batchSize=3, quietMs=600_000, onFire(roomId, deposits), hasActiveJob(roomId)}`
- `mark(roomId)`：count+1；timer 锚定**首次** mark + M（固定窗口 = max-wait，防持续沉淀永不触发）；count≥N 立即触发
- 触发时若 `hasActiveJob(roomId)`（当前轮还没跑完）→ 清 count、重武装一个 M 窗口（保证跑完后还有收尾轮，且每房队列至多一条）
- `dispose()` 清全部 timer

### 3.3 修改 `service.ts`（改动最集中）

- 常量：`PROFILE_REFRESH_JOB_TYPE = "knowledge.profile-refresh"`；`ProfileRefreshJobPayload {roomId, deposits}` 进 insertJob payload 联合类型
- `KnowledgeServiceConfig` 加 `profileRefreshBatch`（默认 3）/ `profileRefreshQuietMs`（默认 600_000）
- 新字段 `roomAgentRuntime: AgentRuntime | null = null` + `attachAgentRuntime(runtime)` setter（重复 attach 抛错，镜像 ConnectorSyncService；**不动构造签名**，既有测试夹具零影响）；构造器实例化 scheduler（onFire 回调：已有活跃 job 则重武装，否则 insertJob）
- `roomAgentDeps()`（public）：绑定 §3.2 全部只读访问器
- **触发点两处**（真实沉淀的 confirm 写库后，全资料类型汇聚于此）：
  - `runIngestJob` 的 decision confirm 之后
  - `ingestEntityBacklog` 的 confirm 之后（晋升补账也真实沉淀材料）
  - 统一入口 `markProfileDirty(roomId)`：先查 rooms 行 `deletedAt IS NULL` 再 mark（删除房不积累；link-only 分支在 confirm 前返回，天然不触发）
- worker 接线：
  - drain 的 `inArray` 加新 type
  - `lockKeyOf` 加分支：profile-refresh → `roomId`（**与 ingest 同锁串行**——刷新读的 wiki 必已 settled，消掉半写竞态；worker 单飞下这条锁也是期望行为）
  - dispatch 加分支；`dispose()` 加 `scheduler.dispose()`
- 新方法 `runProfileRefreshJob(payload)`：
  1. 读 rooms 行，`!row || row.deletedAt` → return（刷新中被删）
  2. 无 wiki（`resolveRoomWikiId` null）且 materials/linkedSources 全空 → return（无素材不白跑、不建空 wiki）
  3. **降级链**：agent（sessionId `knowledge-profile:<roomId>`）→ 失败走单发 `KnowledgeLlm`（扩展 `KnowledgeLlm.refreshRoomProfile`：room 域输入——linkedSources 的 evidence ≤30 + summary/title ≤10 + 当前 profile——prompt 要求产出同契约 profile JSON，复用 `chatJson` 重试机制）→ 再失败**不写入**，warn 日志后 job 正常 completed（刷新是机会性的，保旧 profile，不烧 job 重试）
  4. 写入：`UPDATE rooms SET profile, summary = profile.summary, updatedAt WHERE id AND deletedAt IS NULL`（写前二次删检查）；**不动 title/aliases/origin/kind**——title 由用户 rename/晋升登记拥有
  5. `logger.info(event: "knowledge.room.profile_refreshed", {roomId, by: agent|llm})`
- `registerEntityOrFallback` 在 `if (this.llm)` 前插 agent 分支：sessionId `knowledge-register:<entityId>`，成功后照旧 `updateEntityIdentity`；失败 warn 后落入原有单发 LLM → 非 LLM fallback（两层兜底原样保留）。晋升 INSERT 照旧只写 `summary`（registration.summary），首份完整 profile 由晋升 backlog 沉淀触发的首轮 refresh 生成（backlog confirm 会 mark，无需额外接线）

### 3.4 REST / DTO 扩展

- `routes.ts` `RoomDto` 加 `profile: Type.Union([RoomProfileSchema, Type.Null()])`（Typebox schema 对应 §1.2 契约）
- `service.ts` `toRoomDto` 透传 `profile`；`upsertRoom` 不写 profile（保持只碰 title/kind/origin）

### 3.5 `runtime-factory.ts` + `create-server.ts` + `config.ts`

- 新增 `createKnowledgeRoomAgentRuntime(config, deps): AgentRuntime | null`——照 `createConnectorSyncAgentRuntime` 逐项对齐：
  - `agentRuntime === "fake" || !backgroundPi` → 返回 null（全链路回退现状）
  - strip memory；`includeBashTool: false`；`maxToolCallsPerRun: 64`（5 个只读工具，防失控循环）
  - **三目录命名空间子目录 `join(..., "knowledge-room")`**（sessions/working/agent 三个 dir，`assertOwnedSessionPath` 硬要求）
  - 签名收 `deps` 不收 service——factory 不 import service.ts，零环
- `create-server.ts`：KnowledgeService 构造后 `createKnowledgeRoomAgentRuntime(config, knowledgeService.roomAgentDeps())` → 非 null 则 `attachAgentRuntime`
- `config.ts`：env `NXCORE_KNOWLEDGE_PROFILE_REFRESH_BATCH`（默认 3）/ `NXCORE_KNOWLEDGE_PROFILE_REFRESH_QUIET_MS`（默认 600000），走现有 integer 解析，`KnowledgeGatewayConfig` 透传

## 4. 渲染器（desktop）

### 4.1 `shared/knowledge.ts`：`KnowledgeRoomDto` 加 `profile: RoomProfileDto | null`

`RoomProfileDto` 与 §1.2 契约同构（时间线/人物的子对象）。preload 的 `listRooms` 返回值自动透传，无需改签名。

### 4.2 `knowledgeRoomSync.ts`

`mergeAutoKnowledgeRooms` 扩展为：

```ts
export interface AppliedProfileMarker { profileJson: string; updatedAt: string }
export function mergeKnowledgeRooms(
  rooms: ContextRoomRecord[],
  deletedRooms: ContextRoomRecord[],
  incoming: KnowledgeRoomDto[],
  lastApplied: Map<string, AppliedProfileMarker>,
): ContextRoomRecord[]
```

- 未知 id → 现有 `createAutoContextRoom` 逻辑不变（含 deletedRooms 过滤），`dto.profile` 存在时用于填充初始 brief + 写标记
- 已知房，`dto.profile` 非空且通过守卫（§4.4）→ 字段级映射（**null/空字段不覆盖**，推广 v1 的 summary 守卫）：

| profile 字段 | ContextRoomRecord 映射 |
|---|---|
| `summary` | `brief.background`（非空时） |
| `goal` | `brief.goal`（非空时；创建时的占位文案"明确目标并聚合相关资料。"可被首个非空 goal 替换） |
| `status` | `brief.status`（非空时） |
| `risks` | `brief.risks`（非空数组时）；`riskCount = risks.length` 同步 |
| `decisions` | `brief.decisions`（非空数组时） |
| `people` | `people`（非空数组时；映射 `ContextRoomPerson`：name/role 照用，avatar 用名字首字符生成） |
| `timeline` | `timeline`（非空数组时；映射 `ContextRoomTimelineItem`，kind 直通） |

- **无任何字段变化时返回原数组引用**（既有契约，`PortedContextRoom` 靠 `rooms === current.rooms` 短路 setState）
- 展示位（`OverviewDashboard` 四卡 / `HomeView` / `RoomCard` / `RelationsPane`）零改动——它们已经读 brief/people/timeline，只是终于有数据了

### 4.3 `PortedContextRoom.tsx`

- 加 `lastAppliedProfileRef = useRef(new Map<...>())`
- `knowledge.listRooms('auto')` → `knowledge.listRooms()`（全 origin：user 创建 + 已认领 + 未认领 auto 全部参与 profile 合并）
- 改调 `mergeKnowledgeRooms`；push 侧指纹不动（仍只 title/kind）

### 4.4 双向同步回环分析（结论：不成环）

链路：merge 改 brief/people/timeline → `ContextRoomStateProvider` fingerprint 变化 → `api.syncSnapshot` 推到 gateway **context_rooms 表**（ContextRoomService，独立子系统，不回流 knowledge rooms 表）→ 终止。单向有界。

三个必须保持的守卫：

1. merge 无变化返回**原数组引用** → setState 被短路 → 不触发 snapshot 推送（每 5s 轮询零成本）
2. 标记按 **profile 内容 JSON** 比较（`JSON.stringify(profile)`）：渲染器 `upsertRoom`（title/kind 指纹变化时）会 bump `rooms.updatedAt` 但 profile 不变——合并条件要求"updatedAt 更新 **且** profile JSON 与标记不同"，upsert 的 updatedAt 抖动不会误触发
3. **字段级 null/空不覆盖**：profile 未生成（null）的房保住创建时文案；profile 内某字段空值不动该字段局部（如 agent 判断无风险 → risks 为空 → 保留旧 risks？**否——空数组合法语义"当前无风险"，应覆盖**；只有 null/缺失才不覆盖。实现时区分：字段缺失 → 不动，字段为空数组/空串 → 覆盖）

## 5. 测试计划

**新建 `apps/gateway/tests/knowledge-room-agent.test.ts`**（夹具照 `knowledge-file-upload.test.ts` 的 `serviceForTest`：临时 sqlite + 不可达 KS + 不 start()；agent 用自写 stub AgentRuntime——`FakeAgentRuntime` 回复不可注入，自写更直接）：

- `ProfileRefreshScheduler`（vitest fake timers）：首次 mark 后 M 触发 / count≥N 提前触发 / hasActiveJob 重武装（再 mark 仍只 fire 一次）/ dispose 清 timer
- `runKnowledgeAgentTask`：正常 JSON → 返回；带围栏 JSON 仍解析成功；坏 JSON 两次 → 抛错；`run.failed` → 抛错；挂起不结束 + timeoutMs → 抛错且 `cancel` 被调用
- `parseRoomProfileResponse` 纯函数：合法全字段 / 部分字段缺失给默认 / 超长截断 / 数组超限裁剪 / kind 枚举外回退 info / 坏 JSON 抛错
- service 级（插 jobs 行驱动 worker）：
  - 刷新写入 profile 且 summary 冗余一致、title 不动
  - 失败链：stub 抛错 + `llm: null` → profile 保旧、job 状态 completed
  - 删除房（deletedAt 非空）→ job 完成且无写入
  - 晋升登记 agent 优先：stub 内容进新 rooms 行的 summary
  - 回归守护：不 attach runtime + `llm: null` → 登记走 name + 首条依据
- 迁移：现有迁移测试模式（若有）加 0018；至少 `serviceForTest` 夹具库跑新列无碍

**desktop `tests/knowledge-room-sync.test.ts` 扩展**：profile 新者胜（updatedAt 更新 + profile JSON 不同 → 各字段映射正确 + 标记推进）/ 同 profile → 返回原引用（`toBe` 断言）/ null profile 不覆盖 / updatedAt 变但 profile 同 → 不应用 / 部分字段缺失只更新存在的字段 / 空数组 risks 覆盖旧值 / 未知 auto 房照旧新增、deletedRooms 不复活（保留现用例改名适配）

**可选**：`ingest-pipeline.test.ts` 构造处加 `profileRefreshBatch: 1`，补一条端到端断言（晋升 → ingest confirm → rooms.profile 变化，agent 缺席时验证 llm 分支）。

## 6. 风险与边界

| 风险 | 处置 |
|---|---|
| agent hang | 5 分钟超时 + `runtime.cancel` 兜底（pi runtime 无内建超时，这是唯一兜底）；刷新失败保旧 |
| worker 单飞被长刷新阻塞 | 超时封顶 5 分钟，与现状 `waitUntilSettled` 最长 10 分钟同量级 |
| gateway 重启丢防抖态 | 接受（内存 scheduler；下次沉淀重新 mark，机会性刷新不丢数据） |
| 刷新中删除 Room | mark 时过滤 + job 开头 + UPDATE 前三重 `deletedAt` 检查 |
| 刷新中认领（auto→user） | 无冲突，刷新只写 profile/summary，不碰 origin/title |
| 仅 link-only（wiki-disabled）源的房 | confirm 前返回不 mark，永不空转 |
| 无 wiki 有材料的房 | wiki 工具返回空列表，agent 靠 materials/source_read 仍可产出；全空则提前 return |
| timeline 时效性 | prompt 约束"只收资料中明确可考的事件与日期，相对日期不硬转"；解析器数量封顶 ≤10 |
| profile 漂移（反复增量改写失真） | refresh prompt 附当前 profile 供增量改写；后续可加低频全量自愈（每次 N 轮增量后强制 wiki 全读重写），首版不做、留观察 |
| 固定中文系统提示（无 per-agent hook） | 任务提示强约束裸 JSON + 解析两次重试 + 全链 fallback 兜底 |
| 文档改标题留旧信封 | **已知缺口，不在本方案范围**（文件名含净化标题，同名覆盖不命中，wiki 短期双版本，profile 影响轻微） |

### 6.2 明确不在本方案范围（后续另议）

- **stats 等派生统计实时化**：走查询接口（`roomMaterials` 已有，渲染器消费可另做小增量），不进 agent——LLM 生成统计必然过时漂移
- **profile 低频全量自愈重写**
- **文档改标题的旧信封清理（rawRm）**

## 7. 实施顺序

1. 迁移 `0018_room_profile.sql` + schema.ts + `RoomProfile` 类型
2. `room-agent.ts`（工具/prompt/解析器/runner/scheduler，无依赖可先行）
3. `service.ts`（config 字段 → job type/deps/attach → 触发点 → worker 接线 → `runProfileRefreshJob` → `registerEntityOrFallback`）+ DTO 扩展
4. `runtime-factory.ts` + `create-server.ts` 接线 + `config.ts` env 旋钮
5. 渲染器 `shared/knowledge.ts` → `knowledgeRoomSync.ts` → `PortedContextRoom.tsx`
6. 测试（gateway 新文件 → desktop 扩展）
7. 全量 typecheck + 两侧 vitest + drizzle 迁移验证

## 8. 验证

- `pnpm --filter gateway test`（新 agent 测试 + 既有 routing/upload/pipeline 回归）
- `pnpm --filter desktop test`（knowledge-room-sync 扩展）
- 手动端到端：启动 gateway + desktop → 上传文件归类到某 Room → 观察日志 `knowledge.room.profile_refreshed` → 渲染器 5s 轮询内 OverviewDashboard 的简介/状态/时间轴卡出现真实内容

## 附：关键文件清单

| 文件 | 动作 |
|---|---|
| `apps/gateway/drizzle/0018_room_profile.sql` | 新建（rooms.profile JSON 列） |
| `apps/gateway/src/infrastructure/database/schema.ts` | rooms 加 profile 列 |
| `apps/gateway/src/modules/knowledge/room-agent.ts` | 新建（RoomProfile 类型/工具/prompt/解析器/runner/scheduler） |
| `apps/gateway/src/modules/knowledge/llm.ts` | 扩展 `refreshRoomProfile`（单发降级） |
| `apps/gateway/src/modules/knowledge/service.ts` | 修改（job type、触发点、worker、refresh job、登记 agent 分支、DTO 透传） |
| `apps/gateway/src/modules/knowledge/routes.ts` | RoomDto 加 profile |
| `apps/gateway/src/modules/agent/runtime-factory.ts` | 新增工厂函数 |
| `apps/gateway/src/server/create-server.ts` | 接线 |
| `apps/gateway/src/config.ts` | env 旋钮 |
| `apps/desktop/src/shared/knowledge.ts` | KnowledgeRoomDto 加 profile |
| `apps/desktop/src/renderer/src/components/context-room/ported/knowledgeRoomSync.ts` | merge 扩展为 profile 字段级映射 |
| `apps/desktop/src/renderer/src/components/context-room/ported/PortedContextRoom.tsx` | 拉全量 + 调新 merge |
| `apps/gateway/tests/knowledge-room-agent.test.ts` | 新建 |
| `apps/desktop/tests/knowledge-room-sync.test.ts` | 扩展 |
