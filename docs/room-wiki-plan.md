# Room × Wiki：Room 级知识空间与自动归类 — 实施方案

> 状态：草案（待评审）
> 日期：2026-08-16
> 范围：`apps/desktop`、`apps/gateway`、`packages/agent-runtime-pi`；依赖 TencentDB-Agent-Memory 的 **MemoryKnowledge**（下称 KS，Knowledge Service，本地 8421，已由 `KnowledgeServiceSupervisor` 托管）
> 前置阅读：`docs/pi-agent-memory-plan.md`（记忆接入，模式相同可类推）

## 1. 背景与目标

### 1.1 现状

- 桌面端启动时幂等引导**一个全局 wiki**（`everroom-wiki`，`apps/desktop/src/main/knowledge/knowledge-supervisor.ts:35`），wiki_id 通过 `NXCORE_KNOWLEDGE_WIKI_ID` 注入 gateway。
- pi runtime 以**固定 wikiId** 构造 `KnowledgeServiceClient`（`packages/agent-runtime-pi/src/knowledge/client.ts:44`），所有 Room 的 agent 共用同一个 wiki。
- EverRoom 的文档模型本身就是 Room 级的：`RoomDocument` 自带 `roomId`（`packages/agent-contract/src/index.ts:106`），另有 `room_doc_links`、`doc_transactions` 两张关联表。

### 1.2 问题

所有文档混进一个全局 wiki：

1. agent 检索噪音大——Room A 的 agent 会命中 Room B 的内容；
2. 无法回答"这个 Room 里沉淀了什么"；
3. 上下文边界缺失，后续多用户/共享场景没有权限隔离的抓手。

### 1.3 目标

1. **Room ↔ Wiki 一一映射**：每个 Room 懒拥有一个独立 wiki（KS knowledge instance）。**不设全局 wiki**——凡无合适 Room 归属的文档，由 LLM 仲裁判定为"新主题"时**自动创建 Room + wiki** 承接（防碎片化约束见 D2）。
2. **自动归类路由层**：新文档（含将来的外部采集源：会议纪要、邮件、云盘）自动判定归属 Room，写入对应 wiki。
3. **Room 作用域消费**：Room 内 agent 会话自动挂载本 Room wiki，检索天然带上下文边界。

### 1.4 非目标

- 不做多用户 ACL（单机单用户先行，表结构预留）；
- 不改 KS 本体（ingest-v2 引擎、merge 语义原样使用）；embedding 检索（L3 层）在 KS 支持前由 gateway 侧自建；
- 不在本方案内实现会议纪要/邮件采集连接器（只定义其接入路由器的接口契约）。

## 2. 总体架构

```text
渲染器 ──IPC── Electron 主进程                    Gateway (Fastify)
                │                                    │
                │ KnowledgeServiceSupervisor          │ modules/knowledge   ← 本方案新增模块
                │ (只负责拉起 KS 进程)                 │ ├─ rooms           Room 注册表（renderer 本地 Room 的网关镜像 + origin=auto）
                │                                    │ ├─ registry        Room↔Wiki 映射 + ensureWikiForRoom
                ▼                                    │ ├─ router          确定性层 → 候选层 → LLM 终审
          KS (MemoryKnowledge, 8421)  ◀──────────────┤ ├─ ingest-worker   jobs 队列 → KS raw/write + ingest
          POST /v3/wiki/create|raw/write|ingest|get|update-meta|raw/rm|delete
                │                                    │ └─ routes           REST（待归类确认/Room 同步/管理）
                │ 检索: /v3/wiki/search|page/ls|page/read
                │                                    │
        PiAgentRuntime (packages/agent-runtime-pi) ───┘
          会话启动时按 agentSessions.roomId 解析 roomWikiId → wiki 客户端
```

### 2.1 关键决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **懒创建**：Room 建立时不建 wiki，第一份文档路由到该 Room 时才 `ensureWikiForRoom` | 大量 Room 永远不会有文档；KS 每个 wiki 有独立 data dir，空壳浪费资源 |
| D2 | **不设全局 wiki；无合适归属时自动创建 Room + wiki**。防碎片化三约束：(a) 只有⑤ LLM 有权判"新主题"并提议 create_new（③④无此权限）；(b) 自动创建的 Room **立即进入后续路由的候选池**（name+summary+首批页面标题都进卷宗），同类文档第二轮就归入它而非再建新 Room；(c) origin=auto 标记 + 面板可见可改名可合并 | 全局 wiki 会成为无人治理的垃圾抽屉；自动建 Room 的碎片化风险靠"候选池闭环 + 人工可收敛"消化，而不是靠全局兜底掩盖 |
| D3 | **多归属只 ingest 一次**：文档归属多个 Room 时，分数最高者为主 Room 落 ingest，其余 Room 只写 `room_doc_links` 链接 | wiki 化（LLM ingest）有成本，链接免费；跨 Room 检索原始文档走链接 |
| D4 | **per-room wiki 的创建走 gateway → KS HTTP**，desktop supervisor 只管拉起 KS 进程（不再引导全局 wiki） | 职责分离：desktop 是进程保姆，gateway 是业务编排者；KS API 天然幂等（`create` 返回 `existed`） |
| D5 | **路由错误宁可保守**：低置信度落待归类队列，不硬塞 | 错误 ingest 会长进实体页并污染后续实体匹配（正反馈污染），纠正成本高 |
| D7 | **③④ 只产候选与证据，LLM 是唯一非确定性终审**：凡①②未解决的文档必经⑤判决 | 实体匹配/向量各自的阈值是两套难调且会静默错分的超参；收敛为单一调参点（LLM confidence）+ 可读判决理由，准确性可控性更好 |
| D6 | **复用 `jobs` 表做 ingest 队列**，per-wiki 串行 | KS `/ingest` 并发返回 409 busy（`MemoryKnowledge/src/routes/wiki.ts:89`），天然要求每 wiki 同时只有一个任务 |

## 3. 数据模型

### 3.1 新表（`apps/gateway/src/infrastructure/database/schema.ts`）

```ts
// Room 注册表：当前 Room 只存在于渲染器 localStorage（nexcore:context-room:state:v1），
// gateway 无实体表。自动建 Room（D2）要求 gateway 侧有权威注册表：
// 渲染器 Room 打开/创建时上报登记（origin=user），router 自动创建时写入（origin=auto），
// 渲染器经 REST 拉取 origin=auto 的 Room 显示（带角标）。
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  kind: text("kind").notNull().default("auto"),       // 对齐渲染器 ContextRoomRecord.kind
  origin: text("origin").notNull().default("user"),   // user | auto
  /** origin=auto 时的空间简介（LLM 判"新主题"时产出，供后续路由当候选身份卡） */
  summary: text("summary"),
  createdAt / updatedAt,
});

export const roomWikis = sqliteTable("room_wikis", {
  roomId: text("room_id").primaryKey(),
  knowledgeId: text("knowledge_id").notNull(),        // KS wiki_id
  status: text("status").notNull().default("active"), // active | archived
  // ④ 向量层用：质心（float32 数组序列化，~4KB）与参与文档数（冷启动判断）
  centroid: text("centroid"),                         // base64 BLOB；null = 未初始化
  centroidDocs: integer("centroid_docs").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const routeDecisions = sqliteTable("route_decisions", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  documentVersion: integer("document_version").notNull(),
  // 路由结果：主 Room（落 ingest）+ 附带 Room（仅链接）
  primaryRoomId: text("primary_room_id"),             // null = 待归类（含 create_new 待执行）
  linkedRoomIds: text("linked_room_ids"),              // JSON array
  /** ⑤ 判 create_new 时的提议（执行后回填 primaryRoomId） */
  newRoomName: text("new_room_name"),
  newRoomSummary: text("new_room_summary"),
  confidence: real("confidence").notNull(),            // 0~1
  // 终态决策者只有五种：③④ 只产候选与证据，不做决策（§5.2 设计决定）
  decidedBy: text("decided_by").notNull(),             // entry | link | rule | llm | user
  /** ③④ 的分数快照（JSON：{ entity: {roomId: score}, vector: {roomId: sim} }），供复盘 */
  evidence: text("evidence"),
  reason: text("reason"),
  status: text("status").notNull().default("pending"), // pending | auto | awaiting_review | confirmed | reverted
  createdAt / updatedAt,
});

export const routingRules = sqliteTable("routing_rules", {
  id: text("id").primaryKey(),
  /** 匹配条件（JSON）：{ sourceTag?, filenamePrefix?, threadId?, titleKeyword?, creatorId? }，字段间 AND */
  matcher: text("matcher").notNull(),
  targetRoomId: text("target_room_id").notNull(),
  /** 仅 manual：用户在面板/API 显式配置。不做确认/撤销自动回写（见下）。 */
  origin: text("origin").notNull().default("manual"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt / lastHitAt,
});
```

`routing_rules` 评估顺序：链接（②a）优先；规则（②b）之间按**具体度**排序（文件夹/线程 > 来源标签 > 标题关键词）。

**设计决定：不做规则自动回写。** 待归类确认 / 撤销**不**生成规则——一次误确认会被固化成规则、静默带偏后续一批文档（复利式污染），风险大于收益。代价是同类模糊文档可能反复进待归类队列逐份确认；换来的是路由依据全部可追溯（每条规则都是用户显式写下的，每条 decision 记录当时的瀑布层级与分数）。表默认为空，整个 ②b 层是纯可选的逃生舱。

### 3.2 复用的既有结构

| 结构 | 用途 |
| --- | --- |
| `room_doc_links` | 多归属附带链接；L0 层"版本更新回原 Room"的判定依据 |
| `jobs`（schema.ts:17） | ingest 队列：`type: "knowledge.ingest"`，payload 携带 documentId + knowledgeId |

> 注：原方案中 `gateway_metadata` 存全局 wiki_id 的用途随全局 wiki 取消而移除。

## 4. Wiki 生命周期管理

### 4.1 `ensureWikiForRoom(roomId)`（gateway `modules/knowledge/registry.ts`）

```text
查 roomWikis 缓存/表 → 命中且 active → 返回
  └─ 未命中 → POST /v3/wiki/create
       header: x-tdai-service-id: everroom
       body: { team_id: "everroom", name: `room-${roomId}`, user_id: "everroom" }
     （KS 幂等：已存在返回 200 + existed，不存在 201）
  → 写 roomWikis → 返回 knowledgeId
```

- 命名 `room-${roomId}`：KS 要求 id 段合法（`isValidIdSegment`），roomId 已满足；name 带 `room-` 前缀便于 Panel 里辨认。
- 创建后调 `/v3/wiki/update-meta` 写一句 summary（如 "Room {标题} 的资料空间"）——summary 是将来 agent 侧 `about` 线索和 LLM 仲裁的输入。
- **归档不删除**：Room 长期无活动 → `status: archived`，agent 不再挂载；wiki 数据保留（可整卷 `/v3/wiki/delete` 清理，操作放管理接口，不自动化）。

### 4.2 自动创建 Room（D2 的执行细则）

无合适归属时**不落全局兜底**，由 ⑤ LLM 判定"新主题"后走以下流程：

```text
① router 收到 ⑤ 输出 action=create_new（含 newRoomName/newRoomSummary）
② rooms 表插入 { id: nanoid, title: newRoomName, origin: "auto", summary }
③ ensureWikiForRoom(newRoomId)（§4.1 同款流程）
④ ingest-worker 正常执行（该文档即新 wiki 的第一份源文档）
⑤ 渲染器经 GET /knowledge/rooms?origin=auto 拉取，显示为带"自动创建"角标的 Room
```

防碎片化约束（与 D2 对应）：

- **判定权只在⑤**，且必须是"高置信的新主题"判断（confidence ≥ 0.8 才允许 create_new；低置信 + 无匹配仍走待归类队列，卡片上提供"按建议新建 Room「X」"按钮，人点一下才建）；
- **新 Room 立即进候选池**：后续路由的卷宗里，它和普通 Room 一样有 name + summary + 页面标题——第二份同类文档会归入它而不是再建一个。这是防碎片化的核心闭环：**孤立文档最多催生一个新 Room，不会催生一串**；
- **重名去重**：create_new 前用 title 相似度（bigram 重合 + 别名表）比对现有 Room，命中即归并到现有 Room 而非新建；
- **人工可收敛**：origin=auto 的 Room 在面板可重命名、可合并进其他 Room（合并 = room_doc_links 迁移 + wiki raw/rm 级联清理 + 目标 Room re-ingest，M3 提供 UI）。

> 渲染器 Room 目前存于 localStorage（`nexcore:context-room:state:v1`），gateway 侧 `rooms` 表是新增的权威注册表：渲染器 Room 首次被打开/文档挂载时上报登记（origin=user，幂等），自动创建的 Room 反向经 REST 同步下去。Room 的"单一事实源"问题在本方案内只做最小闭环，完整双向同步不在范围内（见 §12）。

### 4.3 文档 → KS raw 的导出约定

- 文件名：`${documentId}__${title-sanitized}.md`（稳定可重入；sources 溯源可读）；
- 内容：Tiptap JSON → markdown（新增 exporter，表格/列表基本覆盖；画板等富块降级为链接说明）；
- **KS 硬约束**（`MemoryKnowledge/src/routes/wiki.ts:263-266`）：单文件 ≤ 512KB、单批 ≤ 10 文件、总量 ≤ 5MB。超限策略：截断正文并附"已截断"标注（Room 文档极少超限，会议纪要连接器接入时需分片）。

## 5. 自动归类路由层（核心）

### 5.1 触发点

挂在 `documents` 模块的事务提交完成处（`document.committed`，即 `doc_transactions` 落定后）：

- **不在** `appended`/`commit-requested` 时触发（草稿噪音）；
- **防抖**：同一文档 10 分钟窗口内多次 commit 只入队最后一次（比较 version，jobs 去重）；
- 失败重试：`document.deleted` 触发清理任务（见 5.5）。

### 5.2 路由瀑布：确定性层 → 候选生成层 → LLM 终审

**设计决定：③④只产候选与证据，不做最终决策。** 凡未被①②确定性解决的文档，一律经⑤ LLM 仲裁后才落库——准确性的调参点收敛为 LLM 的 confidence 阈值一处，且每条决策都有可读的判决理由。③④的价值转为：**剪枝（控制喂给 LLM 的候选数）+ 证据（分数进卷宗，辅助 LLM 判断）**。

```text
文档导出 markdown（§4.3）
  │
  ① 入口确定性（decidedBy=entry，confidence=1.0）【决策层】
  │   RoomDocument.roomId 存在 → 主 Room 即源 Room。
  │   ※ EverRoom 内创建/导入的文档天然带 roomId，本级命中率极高；
  │     自动归类的真正主战场是未来的外部采集源（会议纪要/邮件/云盘
  │     同步进来无 roomId 的信封，连接器直接从 ② 起步）。
  ▼
  ② 链接与规则（decidedBy=link / rule）【决策层，确定性零成本】
  │   a. 链接：room_doc_links 已有该 documentId → 该文档曾被路由/确认过，
  │      本次是版本更新 → 回原 Room re-ingest，保证"更新不漂移"
  │   b. 规则：用户显式配置的映射规则（默认为空，可选逃生舱），
  │      如 来源标签/文件名前缀/邮件线程 → Room/全局。
  │      ※ 不做确认/撤销自动回写（§3.1 设计决定）
  ▼ （①② 未命中 = 需要判断，以下全部汇入 ⑤）
  ③ 实体匹配【候选层：只排序，不判决】
  │   标题 + 首段抽关键词 → 比对各 Room wiki 的页面标题索引
  │   （gateway 缓存各 wiki page/ls 结果，ingest 完成后失效重拉）
  │   ※ 实现：文档侧 bigram 切分 + 停用词过滤；Room 侧用 wiki
  │     entity/concept 页标题当术语表（KS ingest 已做实体抽取，直接复用）。
  │     token 对标题做包含匹配，按区分度加权：
  │     weight = log(Room总数/命中该token的Room数)，score = Σweight——
  │     各 Room 都有的词（"评审/方案"）权重趋零，独占词高权重。
  │     纯字符串运算，零 API 成本。
  ▼
  ④ 向量层【候选层：只排序，不判决】（M2）
  │   文档 embedding vs 各 Room wiki 的质心（近期文档向量均值）
  │   ※ 规模分析：Room 质心数量级为百级以内，1 查询向量 vs N 质心
  │     纯内存暴力余弦即可（微秒级），**无需引入向量数据库**。
  │     质心向量存 room_wikis.centroid（BLOB ~4KB），ingest 成功后用
  │     指数滑动平均增量更新 centroid = norm(centroid·(1-α) + new·α)，
  │     不存逐文档向量；centroid_docs < 5 时视为冷启动，本级跳过。
  │     唯一外部依赖是 embedding API（复用 NXCORE_AI_* 或独立配置）。
  ▼
  ③④ 综合排序 → 取 top 3~5 Room 作为候选集（origin=auto 的 Room 同等参与）
  ▼
  ⑤ LLM 仲裁【终审，非确定性文档必经】（decidedBy=llm）
      输入（卷宗）：
        - 文档摘要（LLM 预抽，≤300 字）
        - 各候选 wiki 的 name + summary（KS update-meta 维护）+ 代表页面标题
        - ③④ 证据：各候选的实体匹配分 / 向量相似度（明确标注是参考信号）
      输出（严格 JSON）：
        { action: "existing" | "create_new",
          room_ids: [],                        // action=existing 时
          new_room: { name, summary },         // action=create_new 时
          confidence: 0~1, reason }
      裁判规则：按主题归属判，不只看字面重叠；可多归；拿不准就低 confidence；
      create_new 仅当"内容构成连贯新主题且确无现有 Room 匹配"且 confidence ≥ 0.8
      才允许（防碎片化，见 §4.2）；低置信 + 无匹配 → 低 confidence 输出，
      由待归类队列处理（卡片附"按建议新建 Room"按钮）。
  ▼
（阈值只作用于 ⑤ 的输出）
confidence < 0.6 → status=awaiting_review（待归类队列，reason 作为给用户的建议）
0.6 ~ 0.8      → 自动执行（action 限 existing），status=auto（UI 可撤销）
≥ 0.8          → 自动执行（含 create_new），status=auto
```

**M1 阶段的过渡形态**：⑤ 尚未上线时，③④ 的候选结果连同证据直接落待归类队列，**人工就是仲裁者**（确认时看到"实体匹配建议 Room A、向量建议 Room A/B"）。M2 上线⑤后 LLM 接管大部分判决，人只处理低置信的尾部。

**成本边界**：LLM 仲裁只发生在"①② 未命中"的文档上——EverRoom 内部文档（绝大多数流量）在①零成本出结果；真正花 LLM 的是外部采集源的增量，量级可控（每天几十份纪要/邮件）。若未来量涨到需要优化，预留开关：超高置信（如 ③④ 双料 ≥0.9 且一致）可直通——**默认关闭**，符合"宁可多花一次仲裁，不要静默错分"的取向。

### 5.3 决策执行（ingest-worker）

消费 `jobs` 表（per-wiki 串行，KS 409 busy 退避重试）：

```text
1. ensureWikiForRoom(primaryRoomId)          → knowledgeId
2. exporter: Tiptap → markdown
3. POST /v3/wiki/raw/write { wiki_id, files:[{filename, content}] }
4. POST /v3/wiki/ingest { wiki_id }          → 202（异步）
5. 轮询 /v3/wiki/get 直到 status 离开 processing（超时 10 分钟标 failed）
6. 成功：routeDecisions.status=confirmed；
   ingest 后失效该 wiki 的 page/ls 标题缓存（供 ③ 层下次用）
7. linkedRoomIds → 写 room_doc_links（不 ingest）
```

### 5.4 待归类队列与人在回路

- REST（见 §7）：`GET /knowledge/pending`、`POST /knowledge/route/:decisionId/confirm`（body: `roomIds[]` 或 `createRoom: {name}`）；
- 用户确认 = `decidedBy=user`，只作用于**该文档本身**（写 room_doc_links），不生成规则（设计决定见 §3.1）；
- 撤销（`POST /knowledge/route/:decisionId/revert`）：`/v3/wiki/raw/rm` 删源（KS 按 sources 并集级联清理页面）→ 重新路由。

### 5.5 更新与删除

| 场景 | 处理 |
| --- | --- |
| 文档新版本 commit | ②a 命中原 Room → raw/write 覆盖同名文件 → re-ingest。KS merge 按实体 slug 命中旧页走合并：内容未变则规则判重零成本；冲突保留双方并标注分歧（`MemoryKnowledge/src/engines/wiki/ingest-v2/merge.ts` 三原则） |
| 文档移出 Room（用户手动） | revert + 重新路由（同 5.4） |
| document.deleted | `/v3/wiki/raw/rm` + 决策记录标 reverted |
| Room 归档 | wiki 不再挂载，数据保留 |

## 6. Agent 侧消费

### 6.1 会话级解析（`apps/gateway/src/modules/agent/service.ts`）

创建 agent 会话时（已有 `agentSessions.roomId`）：

```text
resolveKnowledge(roomId):
  roomWikis[roomId]   → roomKnowledgeId（无 → null）
返回 KnowledgeRuntimeConfig { baseUrl, serviceId, wikis: [roomKnowledgeId?] }
```

未配置 knowledge 或 Room 尚无 wiki → 本会话不启用 knowledge 工具（与现状未配置时行为一致）。Room 尚无 wiki 的情况会被 §4.2 的懒创建收敛：第一份文档路由进来时 wiki 就存在了。
未配置 knowledge 或 Room 尚无 wiki → 仅全局（或完全不启用，与现状一致）。

### 6.2 pi runtime 改动（`packages/agent-runtime-pi/src/knowledge/`）

- `KnowledgeRuntimeConfig` 增加 `wikiId: string` → `wikiIds: string[]`（保持向后兼容：`wikiId` 为 `wikiIds[0]` 别名）；
- `KnowledgeServiceClient` 请求体携带当前目标 wiki_id（接口本身就是 per-request `wiki_id`，客户端改动很小）；
- 工具签名（`tools.ts`）不变：`knowledge_search` 检索会话对应 Room 的 wiki，结果带 `wiki` 标注；`knowledge_pages_ls/read` 增加可选 wiki 参数，默认 room wiki。
- 降级：wiki 404/超时时 knowledge 工具返回空结果（沿用现有 3s 超时 + 上层降级策略）。

### 6.3 预检索注入（M3，可选增强）

仿照 pi memory 的内联扩展模式（`docs/pi-agent-memory-plan.md` 方案 B）：

```text
before_agent_start:
  用户 query → 本 Room wiki /search top-k（≤3 条，每条 ≤300 字）
  → 自定义消息注入 <relevant-knowledge wiki="..." page="..." date="...">
agent_end 写 L0 前:
  剥离注入块（防反馈环——避免 wiki 内容被当作用户发言再沉淀成记忆）
```

这一步解决"用户不主动提 wiki，agent 也带着文档上下文"。

## 7. 配置与 API

### 7.1 环境变量（`apps/gateway/src/config.ts` 新增块）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED` | `false` | Room 级 wiki 总开关（灰度用） |
| `NXCORE_KNOWLEDGE_ROUTER_ENABLED` | `false` | 自动归类路由总开关 |
| `NXCORE_KNOWLEDGE_ROUTE_THRESHOLD_AUTO` | `0.8` | 高置信自动执行阈值 |
| `NXCORE_KNOWLEDGE_ROUTE_THRESHOLD_REVIEW` | `0.6` | 低于此值进待归类队列 |
| `NXCORE_KNOWLEDGE_INGEST_DEBOUNCE_MS` | `600000` | 文档 commit 防抖窗口 |
| `NXCORE_KNOWLEDGE_LLM_BASE_URL/KEY/MODEL` | 空 | ④⑤ 层与摘要抽取用的 LLM（可复用 NXCORE_AI_*） |

| `NXCORE_KNOWLEDGE_AUTO_CREATE_ROOM_ENABLED` | `false` | ⑤ 的 create_new 自动建 Room 开关（独立灰度，可只在 LLM 仲裁稳定后放开） |
| `NXCORE_KNOWLEDGE_LLM_BASE_URL/KEY/MODEL` | 空 | ④⑤ 层与摘要抽取用的 LLM（可复用 NXCORE_AI_*） |

`NXCORE_KNOWLEDGE_WIKI_ID` **废弃**（全局 wiki 取消，仅作旧配置兼容读取并告警提示）。desktop supervisor 不再引导 `everroom-wiki`，只负责拉起 KS 进程并探活。

### 7.2 REST（`apps/gateway/src/modules/knowledge/routes.ts`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/knowledge/rooms` | Room 注册表（`?origin=auto` 过滤自动创建的，渲染器同步用） |
| POST | `/knowledge/rooms` | 渲染器上报登记本地 Room（幂等，origin=user） |
| PATCH | `/knowledge/rooms/:id` | 重命名 / 合并进其他 Room（M3，auto Room 治理） |
| GET | `/knowledge/wikis` | Room↔wiki 映射列表（含状态、页面数） |
| GET | `/knowledge/wikis/:roomId` | 单 Room wiki 详情（KS `/get` 透传） |
| GET | `/knowledge/pending` | 待归类队列 |
| POST | `/knowledge/route/:decisionId/confirm` | 用户确认路由（body: `roomIds[]` 或 `createRoom: {name}`） |
| POST | `/knowledge/route/:decisionId/revert` | 撤销路由（清源 + 重路由） |
| POST | `/knowledge/route/manual` | 手动触发某文档路由（"立即沉淀"入口，外部连接器契约） |
| POST | `/knowledge/rules` | 增删 ②b 层映射规则 |

## 8. 代码改动清单

| 位置 | 改动 | 量级 |
| --- | --- | --- |
| `apps/desktop/src/main/knowledge/knowledge-supervisor.ts` | 去掉 `everroom-wiki` 引导与 `NXCORE_KNOWLEDGE_WIKI_ID` 注入，只保留拉起 KS 进程 + 探活 | 小 |
| `apps/gateway/src/config.ts` | 新增 knowledge router 配置块（§7.1），废弃 WIKI_ID 项 | 小 |
| `apps/gateway/src/infrastructure/database/schema.ts` | +`rooms`、`+room_wikis`、`+route_decisions`、`+routing_rules`、迁移 SQL | 小 |
| `apps/gateway/src/modules/knowledge/`（新） | `rooms.ts`（注册表）/ `registry.ts` / `router.ts` / `ingest-worker.ts` / `exporter.ts` / `routes.ts` | **主体工作量** |
| `apps/gateway/src/modules/documents/service.ts` | `document.committed` / `document.deleted` 挂载 → 入队 route job | 小 |
| `apps/gateway/src/modules/agent/service.ts` | 会话创建时 `resolveKnowledge(roomId)` 注入配置 | 小 |
| `packages/agent-runtime-pi/src/knowledge/` | `types.ts` wikiIds、`client.ts` per-request wiki、`tools.ts` 检索标注 wiki 来源 | 中 |
| `packages/agent-contract` | 不动（`DocumentEvent` 已够用） | 无 |
| 渲染器（后续） | Room 上报登记（origin=user）、拉取显示 auto Room（角标）、待归类确认、路由撤销、重命名/合并、规则编辑 | 中（M3） |

## 9. 实施里程碑

| 阶段 | 内容 | 出口标准 |
| --- | --- | --- |
| **M0 基线**（~3 天） | room_wikis 表 + `ensureWikiForRoom` + 会话级 wikiId 解析 + pi 双 wiki 客户端。**无自动路由**，Room 内文档手动/入口直连 ingest | Room A 文档问 Room B agent 查不到；Room A agent 命中本 Room wiki |
| **M1 路由 MVP**（1~2 周） | committed 触发 + ①② 决策层 + ③ 候选层 + ingest-worker（jobs 队列、防抖、409 重试）+ 待归类 REST。⑤ 未上线，**人工即仲裁者**（确认时展示③的候选建议） | 内部试用：Room 文档自动进对 wiki，错分可撤销 |
| **M2 智能路由** | ④ embedding 候选层（gateway 侧自算，质心存 room_wikis）+ ⑤ LLM 终审上线（③④ 分数进卷宗作证据）+ wiki summary 缓存 + confidence 阈值调优 + **create_new 自动建 Room**（先以 `AUTO_CREATE_ROOM_ENABLED=false` 观察 ⑤ 判决质量，再放开） | 外部无 roomId 信封（模拟会议纪要）≥80% 由 LLM 正确归类或低置信进队列；**不存在 ③④ 直接终态的决策**；放开 auto-create 后连续 20 份孤立文档产生的 auto Room 无重复主题（防碎片化验收） |
| **M3 消费增强** | 预检索注入（§6.3）+ Room 面板管理 UI（含 auto Room 重命名/合并、手动规则编辑） | "不提 wiki 也能答文档内容" 的内部演示 |
| **后续** | 会议纪要/邮件/云盘连接器 → 以 `route/manual` 契约接入 router | —— |

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 路由错分污染 wiki（错误文档长进实体页，反向带偏 ③ 层匹配） | D5 保守阈值 + 待归类队列 + revert（raw/rm 级联清理）；不引入自动规则回写这一额外污染面 |
| KS ingest 成本与时延（每 wiki 一次 LLM 全量管线） | commit 防抖；per-wiki 串行；KS merge 规则判重（内容未变零 LLM 成本）；多归属只 ingest 主 Room |
| 512KB/5MB raw 限制 | exporter 截断标注；连接器分片（后续） |
| Room 粒度碎片化（Room 很细时 wiki 过多、跨 Room 检索贵） | room_wikis 预留升级路径：加 `spaceId` 列即可演进为"Room 归属 Space，Space 对应 wiki"，瀑布不变 |
| **auto Room 泛滥**（无全局兜底后，孤立文档持续催生新 Room） | §4.2 三约束：create_new 仅⑤高置信可判 + 新 Room 立即入候选池（同类文档第二轮归入）+ 重名去重归并；独立开关分阶段放开；M3 提供合并/重命名收敛手段 |
| Room 双源真相（渲染器 localStorage vs gateway rooms 表）漂移 | 上报登记幂等 + auto Room 单向同步（gateway → 渲染器）；完整双向同步列为 §12 开放问题，不在本方案内 |
| KS 进程资源随 wiki 数增长（每 wiki 独立 data dir） | 懒创建 + archived 归档；上限保护（如活跃 wiki > 200 告警） |
| ingest 与用户阅读竞态（页面正在重建时检索） | 检索侧容忍（KS search 读旧快照）；状态透出到 UI（processing 徽标） |

## 11. 验收标准

1. **隔离**：Room A 的文档（含 ingest 产物）在 Room B agent 的 `knowledge_search` 结果中不出现。
2. **自动归类**：Room 内新建文档 commit 后 ≤10 分钟（含防抖）完成 ingest；同一文档反复 commit 只触发一次 ingest。
3. **更新合并**：修改文档中某实体的描述并 re-ingest 后，对应 wiki 页面内容更新且未丢失其他实体；内容未变的 re-ingest 不产生 LLM 合并调用（日志可验证）。
4. **撤销**：revert 后该文档内容从对应 wiki 检索中消失（sources 级联清理生效）。
5. **待归类**：低置信文档出现在 `GET /knowledge/pending`，确认后按用户选择执行（`decidedBy=user`）；该文档后续版本更新走 ②a 直接回确认的 Room，不生成任何规则。
6. **降级**：KS 不可用时 agent 会话正常（knowledge 工具返回空/禁用，不阻断对话）——与现状记忆降级策略一致。

## 12. 开放问题

1. Room 删除时 wiki 的保留策略（当前：归档不删，是否提供"删 Room 即删 wiki"选项）？
2. 共享 Room（多用户协作）场景下 room wiki 的归属与 KS 的 user/team 语义如何映射？
3. ④ 层 embedding 的模型与存储位置：KS 尚无向量检索，gateway 自算的成本与一致性（文档改版后向量更新）需在 M2 评估；KS 支持向量后是否切换。
4. Tiptap → markdown 导出对富内容（画板、Base 嵌入）的降级表达是否足以让 LLM ingest 有效利用。
5. auto Room 的治理节奏：LLM 起的名字质量参差，何时提示用户重命名（首次打开时？沉淀满 N 份文档时？）；多个 auto Room 语义相近时是自动建议合并还是仅提示。
6. Room 的单一事实源：本方案以 gateway `rooms` 表为注册表、渲染器 localStorage 为展示态做最小闭环；长期是否把 Room 完全上收到 gateway（渲染器只读）需要产品层面决策。
