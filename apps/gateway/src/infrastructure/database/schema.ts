import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  RealityCaptureDevice,
  RealityInsights,
  RealityMarker,
  RealityTranscriptSegment,
} from "@nxcore/reality-contract";

export const gatewayMetadata = sqliteTable("gateway_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  payload: text("payload", { mode: "json" }).notNull(),
  result: text("result", { mode: "json" }),
  error: text("error", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  roomId: text("room_id"),
  pageLabel: text("page_label").notNull(),
  runtimeId: text("runtime_id").notNull(),
  runtimeSessionRef: text("runtime_session_ref"),
  title: text("title"),
  status: text("status", {
    enum: ["idle", "running", "interrupted", "closed"],
  })
    .notNull()
    .default("idle"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["accepted", "running", "completed", "failed", "cancelled", "interrupted"],
    })
      .notNull()
      .default("accepted"),
    prompt: text("prompt").notNull(),
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("agent_runs_session_idempotency_idx").on(table.sessionId, table.idempotencyKey)],
);

export const agentMessages = sqliteTable("agent_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("agent_events_run_seq_idx").on(table.runId, table.seq)],
);

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  contentJson: text("content_json", { mode: "json" }).notNull(),
  version: integer("version").notNull().default(0),
  status: text("status", { enum: ["draft", "active"] }).notNull().default("draft"),
  activeTransactionId: text("active_transaction_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const roomDocumentLinks = sqliteTable(
  "room_doc_links",
  {
    roomId: text("room_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    linkedAt: integer("linked_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_doc_links_room_document_idx").on(table.roomId, table.documentId),
    index("room_doc_links_room_idx").on(table.roomId),
  ],
);

export const documentVersions = sqliteTable(
  "doc_versions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentJson: text("content_json", { mode: "json" }).notNull(),
    sourceTransactionId: text("source_transaction_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("doc_versions_document_version_idx").on(table.documentId, table.version)],
);

export const documentTransactions = sqliteTable(
  "doc_transactions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    roomId: text("room_id").notNull(),
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    status: text("status", {
      enum: ["open", "committed", "aborted", "expired", "interrupted"],
    }).notNull().default("open"),
    nextSequence: integer("next_sequence").notNull().default(1),
    totalBytes: integer("total_bytes").notNull().default(0),
    workingContentJson: text("working_content_json", { mode: "json" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("doc_transactions_session_idx").on(table.agentSessionId),
    index("doc_transactions_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const documentOps = sqliteTable(
  "doc_ops",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => documentTransactions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    markdown: text("markdown").notNull(),
    sha256: text("sha256").notNull(),
    byteLength: integer("byte_length").notNull(),
    appliedContentJson: text("applied_content_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("doc_ops_transaction_sequence_idx").on(table.transactionId, table.sequence)],
);

// ═══════════════════ Knowledge 路由层（docs/entity-room-plan.md） ═══════════════════
// Room 注册表：Room 长期只存在于渲染器 localStorage，gateway 侧此前无实体表。
// 渲染器 Room 打开/创建/改名时上报 upsert（origin=user），删除时写 deletedAt；
// 实体晋升产出的 Room 写 origin=auto，渲染器经 REST 拉取显示。
// 新表对 rooms 一律松引用（存量 roomId 无注册行不阻塞），完整性由 service 层校验。
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** 对齐渲染器 ContextRoomKind 六值枚举（人物/项目/主题/长期目标/议题/事件）。 */
  kind: text("kind").notNull().default("议题"),
  /** user = 渲染器上报；auto = 实体证据累积晋升时自动创建。上报命中 auto 行 = 认领，翻转为 user。 */
  origin: text("origin", { enum: ["user", "auto"] }).notNull().default("user"),
  /** Room 简介（晋升时"转正登记"综合产出；user Room 由用户维护）。 */
  summary: text("summary"),
  /** 曾用名/同义词（重名去重比对用）；rename/认领时把旧 title 追加。 */
  aliases: text("aliases", { mode: "json" }).$type<string[]>(),
  /** Room 的户口实体（ED4：现有 Room 一律种子化为已晋升实体；渲染器上报时同步维护）。 */
  entityId: text("entity_id"),
  /** 软删除（null = 存活）：候选池/auto 同步/wiki 挂载全部过滤。 */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * 实体注册表（entity-room-plan §3.1）：弱 Room 的本体，也是 Room 的"户口"。
 * weak = 候选（无 wiki 无 ingest，证据累积中）；ready = 推荐（达阈值，等用户
 * 确认创建）；room = 已晋升（roomId 回填）；promoting = 晋升 job 的原子抢占态
 * （崩溃后由启动清扫回 weak）；archived = 老化归档/被合并（不参与解析，新链
 * 接可复活回 weak）。status 列无 CHECK 约束（TEXT 枚举仅类型层），加态免迁移。
 */
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** 曾用名/同义词：解析命中不同叫法时累积；合并时并集。 */
    aliases: text("aliases", { mode: "json" }).$type<string[]>(),
    /** 人物/项目/主题/长期目标/议题/事件。 */
    kind: text("kind", {
      enum: ["人物", "项目", "主题", "长期目标", "议题", "事件"],
    }).notNull().default("主题"),
    /** 晋升时"转正登记"一次性综合产出（弱期为 NULL——依据句日志即事实源，ED7）。 */
    summary: text("summary"),
    status: text("status", {
      enum: ["weak", "ready", "promoting", "room", "archived"],
    }).notNull().default("weak"),
    /** 晋升后回填 rooms.id。 */
    roomId: text("room_id"),
    /** 累计证据分：primary +1.0 / mention +0.4 / manual +1.5（按 source 去重，版本更新调差额）。 */
    evidenceScore: real("evidence_score").notNull().default(0),
    /** 关联资料数（按 sourceId 去重）。 */
    sourceCount: integer("source_count").notNull().default(0),
    /** 质心：弱实体从第一份资料就开始累积（ED：冷启动问题随模型消失）。 */
    centroid: text("centroid"),
    centroidDocs: integer("centroid_docs").notNull().default(0),
    centroidModel: text("centroid_model"),
    /** 审计：被合并进本实体的实体 id（自动/手动合并都记）。 */
    mergedFrom: text("merged_from", { mode: "json" }).$type<string[]>(),
    /** 最近一次链接时间（老化归档依据，E3）。 */
    lastLinkedAt: integer("last_linked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("entities_status_idx").on(table.status),
    index("entities_name_idx").on(table.name),
  ],
);

/**
 * 资料 → 实体链接：归属的单一事实源（原 route_decisions 的归属语义迁到这里）。
 * 一份资料对同一实体只一行（新版本覆盖更新 role/salience/version）。
 */
export const entityDocLinks = sqliteTable(
  "entity_doc_links",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "mail", "file", "cloud-doc"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    /** primary = 资料核心主题（网关侧从 salience 推导）；mention = 顺带提及；manual = 用户挂载。 */
    role: text("role", { enum: ["primary", "mention", "manual"] }).notNull(),
    /** 抽取时的分量快照（0~1）。 */
    salience: real("salience").notNull().default(0),
    /** 抽取依据句（原文短句）——实体详情"为什么存在"的可解释性来源。 */
    evidence: text("evidence"),
    decidedBy: text("decided_by", { enum: ["resolution", "user"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("entity_doc_links_entity_source_idx").on(
      table.entityId,
      table.sourceKind,
      table.sourceId,
    ),
    index("entity_doc_links_source_idx").on(table.sourceKind, table.sourceId),
  ],
);

/** Room ↔ wiki 映射；懒创建（第一份文档路由到该 Room 时才 ensure，见 plan D1）。 */
export const roomWikis = sqliteTable("room_wikis", {
  roomId: text("room_id").primaryKey(),
  /** KS（MemoryKnowledge）侧的 wiki_id。 */
  knowledgeId: text("knowledge_id").notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  /** ④ 向量层用：质心（float32 数组 base64，null = 未初始化）。 */
  centroid: text("centroid"),
  centroidDocs: integer("centroid_docs").notNull().default(0),
  /** 生成质心所用 embedding 模型标识：换模型后旧质心不可比，检测到不一致时整体重算。 */
  centroidModel: text("centroid_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * 抽取审计流水（entity-room-plan §3.2）：归属语义已迁 entity_doc_links，
 * 本表降级为每次路由运行的审计记录（抽取原始输出 + 解析结果 + ingest 状态）。
 * primaryRoomId 回填 primary 实体晋升后的 Room（供撤销/清单 join 用）。
 */
export const routeDecisions = sqliteTable(
  "route_decisions",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "mail", "file", "cloud-doc"],
    }).notNull().default("everroom-doc"),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    /** 外部信封的快照（连接器类源没有 documents 行，晋升批量 ingest 时要还原内容）。 */
    sourceTitle: text("source_title"),
    sourceMarkdown: text("source_markdown"),
    /** primary 实体晋升后的 Room（落 ingest）；null = 弱实体孵化中/未识别。 */
    primaryRoomId: text("primary_room_id"),
    /** 附带 Room（仅写 room_doc_links 链接，不 ingest）——入口直连多 Room 时使用。 */
    linkedRoomIds: text("linked_room_ids", { mode: "json" }).$type<string[]>(),
    newRoomName: text("new_room_name"),
    newRoomSummary: text("new_room_summary"),
    newRoomKind: text("new_room_kind"),
    confidence: real("confidence").notNull(),
    /**
     * entry/rule = 确定性入口；resolution = 实体解析命中已晋升实体；
     * user = 手动挂载；null = 未识别（抽取空/失败）。
     */
    decidedBy: text("decided_by", { enum: ["entry", "rule", "resolution", "user"] }),
    /** 抽取输出与解析结果的快照（JSON：summary/entities/resolution/ingested）。 */
    evidence: text("evidence", { mode: "json" }),
    reason: text("reason"),
    status: text("status", {
      enum: ["pending", "auto", "linked", "awaiting_review", "confirmed", "reverted"],
    }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("route_decisions_source_idx").on(table.sourceKind, table.sourceId),
    index("route_decisions_status_idx").on(table.status),
  ],
);

/** ②b 层映射规则：仅 manual（用户显式配置），默认为空，纯可选逃生舱；不做自动回写。 */
export const routingRules = sqliteTable("routing_rules", {
  id: text("id").primaryKey(),
  /** 匹配条件（JSON）：{ sourceTag?, filenamePrefix?, threadId?, titleKeyword?, creatorId? }，字段间 AND。 */
  matcher: text("matcher", { mode: "json" }).notNull(),
  targetRoomId: text("target_room_id").notNull(),
  origin: text("origin").notNull().default("manual"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastHitAt: integer("last_hit_at", { mode: "timestamp_ms" }),
});

/**
 * 上传文件本体登记（room-wiki 方案 §资料模型修订）。
 * 身份 = 规范化文件名（B 案：同名重传同 ID = 版本更新，改名 = 新文件）；
 * 内容 = 版本：content_hash 变化即新版本，原始字节住对象库。
 */
export const uploadedFiles = sqliteTable("uploaded_files", {
  /** file-<规范化文件名 sha256 前 12 位>：确定性派生，判重闸 1 的身份键。 */
  id: text("id").primaryKey(),
  /** 当前版本的原始字节 sha256（判重闸 1 的内容键）。 */
  contentHash: text("content_hash").notNull(),
  /** 对象库相对路径（相对 gateway dataDir）：files/sha256/<前2字符>/<hash>。 */
  storagePath: text("storage_path").notNull(),
  originalName: text("original_name").notNull(),
  bytes: integer("bytes").notNull(),
  mime: text("mime").notNull().default("text/markdown"),
  /** 当前生效的解析产物（后级路由/ingest 只读 parsed_contents.markdown）。 */
  currentParsedId: text("current_parsed_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * 解析产物表（判重闸 2）：md 是唯一权威派生形态，后级只处理 md。
 * (content_hash, parser_version) 唯一 —— 同内容同解析器零重复解析；
 * 解析器升级（版本号变）是唯一合法的重解析场景。
 */
export const parsedContents = sqliteTable(
  "parsed_contents",
  {
    id: text("id").primaryKey(),
    contentHash: text("content_hash").notNull(),
    parserVersion: text("parser_version").notNull(),
    markdown: text("markdown").notNull(),
    parsedAt: integer("parsed_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("parsed_contents_hash_parser_idx").on(table.contentHash, table.parserVersion),
  ],
);

export const realityEvents = sqliteTable(
  "reality_events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["ongoing", "pending_confirmation", "completed", "failed", "pending_sync"],
    }).notNull(),
    processingState: text("processing_state", {
      enum: ["capturing", "saving", "transcribing", "understanding", "ready", "failed"],
    }).notNull(),
    captureDevice: text("capture_device", { mode: "json" }).$type<RealityCaptureDevice>().notNull(),
    processingDevice: text("processing_device").notNull(),
    audioSource: text("audio_source", { enum: ["microphone", "system"] }).notNull(),
    audioFileName: text("audio_file_name"),
    audioMimeType: text("audio_mime_type"),
    durationMs: integer("duration_ms").notNull().default(0),
    currentTopic: text("current_topic"),
    transcript: text("transcript").notNull().default(""),
    transcriptSegments: text("transcript_segments", { mode: "json" })
      .$type<RealityTranscriptSegment[]>().notNull(),
    transcriptEditedAt: integer("transcript_edited_at", { mode: "timestamp_ms" }),
    insights: text("insights", { mode: "json" }).$type<RealityInsights>().notNull(),
    markers: text("markers", { mode: "json" }).$type<RealityMarker[]>().notNull(),
    important: integer("important", { mode: "boolean" }).notNull().default(false),
    asrJobId: text("asr_job_id"),
    asrSource: text("asr_source", { enum: ["local", "saas"] }),
    resultVersion: integer("result_version").notNull().default(0),
    error: text("error"),
    version: integer("version").notNull().default(1),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("reality_events_asr_job_idx").on(table.asrJobId)],
);

// ═══════════════════ 统一理解引擎（docs/unified-ingest-plan.md）═══════════════════

/** 三链路开关（Room / wiki / 记忆）。wiki 依赖 Room（U2：无 Room 不设全局 wiki）。 */
export interface IngestPipelines {
  room: boolean;
  wiki: boolean;
  memory: boolean;
}

/** 记忆链路扇出结果：成功摘要或错误（失败不阻塞 Room 链路）。 */
export interface IngestMemoryOk {
  documentId: string;
  chunkCount: number;
  deduplicated: boolean;
}

/**
 * 统一进入台账（§6.1/U3）：每次经 /v1/ingest 进入的资料一行，
 * 含类型识别结果与策略快照——晋升/增量 ingest 的 wiki 判定读快照而非
 * 实时 policy（策略事后变化不应让已进入的资料行为漂移）。
 * 引擎只记自己做的；Room/wiki 下游状态继续查 knowledge 既有表（§6.3）。
 */
export const ingestEvents = sqliteTable(
  "ingest_events",
  {
    /** ing-<uuid12> */
    id: text("id").primaryKey(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "mail", "file", "cloud-doc"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    dataType: text("data_type").notNull(),
    /** 识别依据（U1 全确定性）：explicit | json-type | extension | source-kind | sniff */
    detectedBy: text("detected_by").notNull(),
    title: text("title").notNull(),
    /** 源内容指纹（原始字节 / 表引用的规范化序列化）。 */
    contentHash: text("content_hash").notNull(),
    /** 归一化产物（parsed_contents 行；全文，消费端各自截断）。 */
    parsedId: text("parsed_id").notNull(),
    /** 策略快照（U3）json {room, wiki, memory}。 */
    pipelines: text("pipelines", { mode: "json" }).$type<IngestPipelines>().notNull(),
    /** 记忆链路即时结果 json {documentId, chunkCount, deduplicated} | {error} | null */
    memoryResult: text("memory_result", { mode: "json" })
      .$type<IngestMemoryOk | { error: string }>(),
    /** Room 链路 route job 引用（knowledge.route）。 */
    routeJobId: text("route_job_id"),
    /** file | paste-file | connector | reality | everroom-doc | upload */
    originChannel: text("origin_channel").notNull().default("upload"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("ingest_events_source_idx").on(table.sourceKind, table.sourceId),
    index("ingest_events_source_hash_idx").on(table.sourceId, table.contentHash),
  ],
);
