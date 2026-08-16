# Room × Wiki：Room 级知识空间与自动归类 — 实施方案

> 状态：M0/M1/M2 已实现（2026-08-16，含路由瀑布 ①-⑤、待归类队列与 create_new 自动建 Room）；M3a/M3b 已实现（2026-08-16，渲染器 Room 上报与 auto Room 同步/认领、Room 知识库 Tab、md 文件上传自动归类、待归类确认/撤销 UI）；资料模型修订已实现（2026-08-16，§3.3：uploaded_files/parsed_contents + 对象库 + 确定性身份 + 四道判重闸门，WikiPane 来源文件分区）；M3c（预检索注入、auto Room 合并与手动规则编辑）未实现
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
// 渲染器 Room 打开/创建/改名时上报 upsert，删除时上报（写 deletedAt）；
// router 自动创建时写入（origin=auto），渲染器经 REST 拉取 origin=auto 的 Room 显示（带角标）。
// 新表对 rooms 一律松引用（存量 roomId 无注册行不阻塞），完整性由 service 层校验。
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  // 对齐渲染器 ContextRoomKind 六值枚举；⑤ create_new 时 LLM 一并提议 kind，
  // 渲染器按 kind 直接选图标/色调（人物/项目/主题/长期目标/议题/事件）
  kind: text("kind").notNull().default("议题"),
  origin: text("origin").notNull().default("user"),   // user | auto；上报命中 auto 行 = 认领，翻转为 user
  /** origin=auto 时的空间简介（LLM 判"新主题"时产出，供后续路由当候选身份卡） */
  summary: text("summary"),
  /** 曾用名/同义词（JSON string[]）：重名去重比对用；rename/认领时把旧 title 追加 */
  aliases: text("aliases"),
  /** 软删除（null = 存活）：渲染器 deletedRooms 上报触发；候选池/auto 同步/wiki 挂载全部过滤 */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt / updatedAt,
});

export const roomWikis = sqliteTable("room_wikis", {
  roomId: text("room_id").primaryKey(),
  knowledgeId: text("knowledge_id").notNull(),        // KS wiki_id
  status: text("status").notNull().default("active"), // active | archived
  // ④ 向量层用：质心（float32 数组序列化，~4KB）与参与文档数（冷启动判断）
  centroid: text("centroid"),                         // base64 BLOB；null = 未初始化
  centroidDocs: integer("centroid_docs").notNull().default(0),
  /** 生成质心所用 embedding 模型标识：换模型后旧质心不可比，检测到不一致时整体重算 */
  centroidModel: text("centroid_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const routeDecisions = sqliteTable("route_decisions", {
  id: text("id").primaryKey(),
  // 溯源 = DocEnvelope.ref（§5.1）：资料实体留在各自表（documents / reality_events / ...），
  // 决策只记 kind+id。两列设计避免接入新资料源时迁移。
  sourceKind: text("source_kind").notNull().default("everroom-doc"),
  sourceId: text("source_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
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

> **实现与 §3.1 原稿的三处偏差（0005 迁移落地）**：
> 1. `decided_by` 允许 NULL——M1 人审提案与 M2 低置信判决在得到结论前没有决策者（原稿 NOT NULL 的前提是"decision 行只在有结论时创建"；实现选择先落行后补结论，让待归类队列有实体可挂）。终态语义不变：confirmed/auto 行必有 decidedBy。
> 2. 新增 `source_title` / `source_markdown` 快照列——外部信封（mail/cloud-doc 等）没有 documents 行可回查，确认/撤销的异步执行要靠快照还原内容（everroom-doc 不存，可随时重建，省库）。
> 3. 新增 `new_room_kind` 列——⑤ 的 create_new 提议带 kind（渲染器按 kind 选图标），确认卡片需要完整提案。

### 3.2 复用的既有结构

| 结构 | 用途 |
| --- | --- |
| `room_doc_links` | 多归属附带链接；L0 层"版本更新回原 Room"的判定依据 |
| `jobs`（schema.ts:17） | ingest 队列：`type: "knowledge.ingest"`，payload 携带 sourceRef（kind+id）+ knowledgeId |

> 注：原方案中 `gateway_metadata` 存全局 wiki_id 的用途随全局 wiki 取消而移除。

> **资料聚合是派生视图，不进 rooms 行**："某 Room 聚合了哪些资料" = `room_doc_links` ⨝ `documents`（documents 表本身**无 roomId 列**，归属 100% 走链接表，多归属天然成立），经 `GET /knowledge/rooms/:id/materials` 输出；主/附归属看 route_decisions（可选优化：给 room_doc_links 加 role 列免 join）；知识层内容由 `room_wikis.knowledgeId` → KS `page/ls` 派生。不把清单快照存进 rooms——JSON 数组会与 documents 漂移（渲染器 `ContextRoomRecord.materials` 即反例）。

### 3.3 上传文件的资料模型（0006 迁移，2026-08-16 修订）

上传文件此前没有实体表：`file-<随机 UUID>` 的 sourceId 悬空（对应不到任何表），既无法判重（同名同内容重传全链路重跑），也没有统一查询面。修订为**三层存储 + 确定性身份**：

```ts
// 本体（字节）：对象库 files/sha256/<前2字符>/<hash>（gateway dataDir 下，内容寻址，
// 与 reality evidence 的 objects/sha256 同款约定）——同内容天然只存一份。

export const uploadedFiles = sqliteTable("uploaded_files", {
  // 身份键：file-<规范化文件名 sha256 前 12 位>（B 案）
  id: text("id").primaryKey(),
  contentHash: text("content_hash").notNull(),   // 当前版本原始字节的 sha256
  storagePath: text("storage_path").notNull(),   // 对象库相对路径
  originalName: text("original_name").notNull(),
  bytes: integer("bytes").notNull(),
  mime: text("mime").notNull().default("text/markdown"),
  currentParsedId: text("current_parsed_id"),   // → parsed_contents.id，后级只读 md
  createdAt / updatedAt,
});

export const parsedContents = sqliteTable("parsed_contents", {
  id: text("id").primaryKey(),
  contentHash: text("content_hash").notNull(),
  parserVersion: text("parser_version").notNull(),  // 当前 "md-v1"
  markdown: text("markdown").notNull(),
  parsedAt,
}, (t) => [uniqueIndex("parsed_contents_hash_parser_idx").on(t.contentHash, t.parserVersion)]);
```

**身份（B 案）**：`sourceId = file-<sha256(规范化文件名)[0:12]>`，规范化 = basename + NFC + 去首尾空白/点 + 折叠空白 + 小写。同名重传 = 同 ID（版本更新，②a 链接层回原 Room + KS 同名覆盖，零 LLM 成本）；改名 = 新文件（符合直觉）。已知取舍：不同目录下同名不同内容的文件会归并成同一身份的版本序列——单用户桌面场景可接受。

**四道判重闸门**（重复进入管线时的成本闸）：

| 闸 | 位置 | 判定 | 效果 |
| --- | --- | --- | --- |
| 闸1 | `submitFileUpload`（service.ts） | 同 sourceId 且 content_hash 相同 | 全跳过：不存对象、不解析、不入队 |
| 闸2 | `parsed_contents` 唯一索引 | (content_hash, parser_version) 已有 | 解析是纯函数，零重复解析；解析器升级（版本号变）是唯一合法重解析场景 |
| 闸3 | ②a 链接层 | file_id 已有归属决策 | 归属不变 → 版本更新走原 Room，不重新路由 |
| 闸4 | KS 确定性文件名 | `${kind}-${id}__title.md` 同名覆盖 + merge 判重 | wiki 侧覆盖而非追加，不产生重复页面 |

**后级只处理 md**：路由瀑布与 ingest 从 `parsed_contents.markdown` 读内容（经 route job 的信封快照透传），本体字节只服务"显示原件"（`shell.showItemInFolder`）。

**存量回填**（`backfillUploadedFiles`，gateway_metadata 键 `knowledge.files_backfill_v1` 打标一次性执行）：旧随机 sourceId 的 file 决策改写为确定性 ID，决策快照 markdown 补落 parsed、字节补落对象库——重传旧文件即可被闸 1/闸 3 认出。

**查询面**：`GET /knowledge/rooms/:id/files`（uploaded_files ⨝ 该 Room 最新归属决策，含状态徽标数据）、`GET /knowledge/files/:id/markdown`（预览）、`GET /knowledge/files/:id/storage`（reveal 本体）。渲染器 WikiPane "来源文件" 分区消费。

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
- **重名去重**：create_new 前用 title 相似度（bigram 重合 + rooms.aliases 曾用名）比对现有 Room，命中即归并到现有 Room 而非新建；
- **人工可收敛**：origin=auto 的 Room 在面板可重命名、可合并进其他 Room（合并 = room_doc_links 迁移 + wiki raw/rm 级联清理 + 目标 Room re-ingest，M3 提供 UI）。

> 渲染器 Room 目前存于 localStorage（`nexcore:context-room:state:v1`），gateway 侧 `rooms` 表是新增的权威注册表：渲染器 Room 首次被打开/文档挂载时上报登记（origin=user，幂等），自动创建的 Room 反向经 REST 同步下去。Room 的"单一事实源"问题在本方案内只做最小闭环，完整双向同步不在范围内（见 §12）。

### 4.3 资料导出约定（DocEnvelope → KS raw）

- 文件名：`${sourceKind}-${sourceId}__${title-sanitized}.md`（稳定可重入；sources 溯源可读）；
- 内容：各源自负责转 markdown（即 DocEnvelope.markdown）——everroom-doc 由 Tiptap JSON 导出（新增 exporter，表格/列表基本覆盖；画板等富块降级为链接说明）；reality-event 由 transcript + insights 组装；
- **KS 硬约束**（`MemoryKnowledge/src/routes/wiki.ts:263-266`）：单文件 ≤ 512KB、单批 ≤ 10 文件、总量 ≤ 5MB。超限策略：截断正文并附"已截断"标注（Room 文档极少超限，会议纪要连接器接入时需分片）。

## 5. 自动归类路由层（核心）

### 5.1 触发点

挂在 `documents` 模块的事务提交完成处（`document.committed`，即 `doc_transactions` 落定后）：

- **不在** `appended`/`commit-requested` 时触发（草稿噪音）；
- **防抖**：同一文档 10 分钟窗口内多次 commit 只入队最后一次（比较 version，jobs 去重）；
- 失败重试：`document.deleted` 触发清理任务（见 5.5）。

**输入归一化：DocEnvelope（路由器的输入契约）**。路由层不关心资料本体存在哪张表，只消费归一化信封——各资料实体留在自己的表里，信封是无状态的过路结构：

```ts
interface DocEnvelope {
  ref: {
    kind: "everroom-doc" | "reality-event" | "mail" | "file" | "cloud-doc";
    id: string;          // 对应表的主键（documents.id / reality_events.id / ...）
    version: number;     // 幂等与去重依据
  };
  title: string;
  markdown: string;      // 各源自负责转 markdown：doc→Tiptap 导出（§4.3）；reality-event→transcript+insights 组装
  occurredAt?: string;   // 业务时间（会议/邮件发生时间），≠入库时间，⑤ 卷宗展示用
  entrySignals?: { sourceTag?: string; threadId?: string; filenamePrefix?: string; creatorId?: string };
}
```

- 现成的第二源：`reality_events`（schema.ts:227，实录事件——transcript/insights/markers/音频元数据俱全）即"会议纪要连接器"的真实数据源，接入时把 processingState=ready 的事件组装成 `kind: "reality-event"` 信封即可，**无需新建资料表**；
- 本地文件（fileItems，hostfsPath 为设备态）与云文档后续作为新 kind 接入，信封结构不变；
- 对应地 `route_decisions` 以 `sourceKind + sourceId` 溯源（见 §3.1）。

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
      只有候选确实是资料的主题归属才选它，弱相关不硬塞——内容构成连贯新主题时
      判 create_new（confidence ≥ 0.8 才自动执行，防碎片化见 §4.2）；
      低置信 + 无合适归属 → 低 confidence 输出，
      由待归类队列处理（卡片附"按建议新建 Room"按钮）。
      ※ 2026-08-17 提示词修订：原判据"确无现有 Room 匹配才可新建"门槛过高，
      叠加候选菜单的呈现偏差，导致有 Room 后几乎不再新建、异构资料被硬塞进
      先到的 Room（"大杂烩"倾向）。改为质量门槛式表述，并明确通用词命中
      （用户/API/系统等）不构成主题相关。
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
2. exporter: 按 sourceKind 生成 DocEnvelope.markdown
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
| `NXCORE_KNOWLEDGE_AUTO_CREATE_ROOM_ENABLED` | `false` | ⑤ 的 create_new 自动建 Room 开关（独立灰度，可只在 LLM 仲裁稳定后放开） |
| `NXCORE_KNOWLEDGE_LLM_BASE_URL/KEY/MODEL` | 空 | ④⑤ 层与摘要抽取用的 LLM（可复用 NXCORE_AI_*） |
| `NXCORE_KNOWLEDGE_EMBEDDING_MODEL` | 空 | ④ 层 embedding 模型（端点复用 LLM 配置）；空 = 关闭向量层 |

`NXCORE_KNOWLEDGE_WIKI_ID` **废弃**（全局 wiki 取消，仅作旧配置兼容读取并告警提示）。desktop supervisor 不再引导 `everroom-wiki`，只负责拉起 KS 进程并探活。

### 7.2 REST（`apps/gateway/src/modules/knowledge/routes.ts`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/knowledge/rooms` | Room 注册表（`?origin=auto` 过滤自动创建的，渲染器同步用） |
| GET | `/knowledge/rooms/:id/materials` | Room 的资料清单（**派生视图**）：documents 原生 + room_doc_links 链接 + 路由信息。auto Room 下发后渲染器本地无状态，从这里拉 |
| POST | `/knowledge/rooms` | 渲染器上报本地 Room，**upsert 语义**：按 id 更新 title/kind；命中 origin=auto 行视为认领（翻转为 user，旧 title 记入 aliases） |
| DELETE | `/knowledge/rooms/:id` | 渲染器上报删除（对应 localStorage deletedRooms）。默认策略：wiki 归档不删（§4.1）、documents/room_doc_links 保留悬挂（与现状一致，完整级联归 RoomService 第③步）、路由候选池剔除 |
| PATCH | `/knowledge/rooms/:id` | 重命名 / 合并进其他 Room（M3，auto Room 治理） |
| GET | `/knowledge/wikis` | Room↔wiki 映射列表（含状态、页面数） |
| GET | `/knowledge/wikis/:roomId` | 单 Room wiki 详情（KS `/get` 透传） |
| GET | `/knowledge/rooms/:id/files` | Room 的上传文件清单（uploaded_files ⨝ 最新归属决策，§3.3） |
| GET | `/knowledge/files/:id/markdown` | 文件解析产物 md（预览） |
| GET | `/knowledge/files/:id/storage` | 文件本体绝对路径（"显示原件"reveal 用） |
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
| **M0 基线**（~3 天）✅ 已实现 | room_wikis 表 + `ensureWikiForRoom` + 会话级 wikiId 解析 + pi 双 wiki 客户端。**无自动路由**，Room 内文档手动/入口直连 ingest | Room A 文档问 Room B agent 查不到；Room A agent 命中本 Room wiki |
| **M1 路由 MVP**（1~2 周）✅ 已实现 | committed 触发 + ①② 决策层 + ③ 候选层 + ingest-worker（jobs 队列、防抖、409 重试）+ 待归类 REST。⑤ 未上线，**人工即仲裁者**（确认时展示③的候选建议） | 内部试用：Room 文档自动进对 wiki，错分可撤销 |
| **M2 智能路由** ✅ 已实现 | ④ embedding 候选层（gateway 侧自算，质心存 room_wikis）+ ⑤ LLM 终审上线（③④ 分数进卷宗作证据）+ wiki summary 缓存 + confidence 阈值调优 + **create_new 自动建 Room**（先以 `AUTO_CREATE_ROOM_ENABLED=false` 观察 ⑤ 判决质量，再放开） | 外部无 roomId 信封（模拟会议纪要）≥80% 由 LLM 正确归类或低置信进队列；**不存在 ③④ 直接终态的决策**；放开 auto-create 后连续 20 份孤立文档产生的 auto Room 无重复主题（防碎片化验收） |
| **M3a/M3b 闭环 UI** ✅ 已实现 | 渲染器 Room 上报登记（origin=user，幂等）+ auto Room 单向同步与"打开/改名即认领"+ RoomCard 角标 + Room 知识库 Tab（页面列表/阅读/上传）+ 首页"资料归类"面板（待归类确认/按建议新建/最近归类撤销）+ md 文件上传（`POST /v1/knowledge/files`，主进程文件选择框） | 上传 md → 自动进 Room wiki 或进队列确认；错分可撤销重路由 |
| **资料模型修订** ✅ 已实现 | §3.3：uploaded_files/parsed_contents 两表 + `files/sha256` 对象库 + 确定性身份（B 案：规范化文件名）+ 四道判重闸门 + 存量决策回填 + WikiPane"来源文件"分区（预览/显示原件） | 同名同内容重传零成本（闸 1）；同名新内容为版本更新（闸 3 回原 Room）；Room 文件清单单一查询面 |
| **M3c 消费增强**（剩余） | 预检索注入（§6.3）+ auto Room 合并、手动规则编辑 | "不提 wiki 也能答文档内容" 的内部演示 |
| **后续** | 会议纪要/邮件/云盘连接器 → 以 `route/manual` 契约接入 router | —— |

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 路由错分污染 wiki（错误文档长进实体页，反向带偏 ③ 层匹配） | D5 保守阈值 + 待归类队列 + revert（raw/rm 级联清理）；不引入自动规则回写这一额外污染面 |
| KS ingest 成本与时延（每 wiki 一次 LLM 全量管线） | commit 防抖；per-wiki 串行；KS merge 规则判重（内容未变零 LLM 成本）；多归属只 ingest 主 Room |
| 512KB/5MB raw 限制 | exporter 截断标注；连接器分片（后续） |
| Room 粒度碎片化（Room 很细时 wiki 过多、跨 Room 检索贵） | room_wikis 预留升级路径：加 `spaceId` 列即可演进为"Room 归属 Space，Space 对应 wiki"，瀑布不变 |
| **auto Room 泛滥**（无全局兜底后，孤立文档持续催生新 Room） | §4.2 三约束：create_new 仅⑤高置信可判 + 新 Room 立即入候选池（同类文档第二轮归入）+ 重名去重归并；独立开关分阶段放开；M3 提供合并/重命名收敛手段 |
| Room 双源真相（渲染器 localStorage vs gateway rooms 表）漂移 | 上报 upsert（含改名）+ 删除上报（deletedRooms → deletedAt）+ auto Room 单向同步（gateway → 渲染器）；完整双向同步列为 §12 开放问题，不在本方案内 |
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
6. Room 的单一事实源与**服务化演进**：本方案以 gateway `rooms` 表为注册表、渲染器 localStorage 为展示态做最小闭环。完整 RoomService（`modules/room`，对照 documents 模块的模式：全量 schema + CRUD + WS 同步，localStorage 降级为缓存）建议按三步独立推进：① 注册表（本方案）→ ② 展示字段服务端派生 → ③ 全量 CRUD + 多端同步（iOS 端展示 Room 列表时为硬性触发条件）。不与 room-wiki 链路绑定。
   服务化的路径是**拆解而非整体搬迁**——现状 `ContextRoomRecord`（渲染器 `context-room/ported/types.ts:216`）混合了四类状态，各字段的目标归属：

   | 渲染器字段（现状 localStorage） | 服务端的家 | 状态 |
   | --- | --- | --- |
   | id / title / kind / roomCode | `rooms` 注册表 | 本方案第①步 |
   | materials[type=文档] | `documents` + `room_doc_links` | **已有**（documents 模块已服务化） |
   | materials[type=邮件/会议]（含 transcript） | 外部采集连接器信封 | 后续 |
   | fileItems（hostfsPath 为本地路径） | 本地文件索引（设备态，难上收） | 开放 |
   | memoryItems / pendingMemoryItems | MemoryCore（L1-L3 + 待确认流） | pi-memory 方案 |
   | actionItems | 将来的 `room_items` 表 | 第③步 |
   | graphEdges | 从共享文档 / 路由决策派生 | 可派生 |
   | stats / timeline / riskCount | 服务端派生下发 | 第②步 |
   | icon / tone / starred / lastViewed / 邮件 replyDraft·unread | 永留客户端（展示与交互态） | 不上收 |

   另注：`context-room/types.ts` 与 `ported/types.ts` 存在**两套同名 `ContextRoomRecord`**（简化版/完整版），服务化前需先合并，避免映射歧义。
