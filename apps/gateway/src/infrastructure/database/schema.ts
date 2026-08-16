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

// ═══════════════════ Knowledge 路由层（docs/room-wiki-plan.md §3.1） ═══════════════════
// Room 注册表：Room 长期只存在于渲染器 localStorage，gateway 侧此前无实体表。
// 渲染器 Room 打开/创建/改名时上报 upsert（origin=user），删除时写 deletedAt；
// router 自动创建的 Room 写 origin=auto，渲染器经 REST 拉取显示。
// 新表对 rooms 一律松引用（存量 roomId 无注册行不阻塞），完整性由 service 层校验。
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** 对齐渲染器 ContextRoomKind 六值枚举（人物/项目/主题/长期目标/议题/事件）。 */
  kind: text("kind").notNull().default("议题"),
  /** user = 渲染器上报；auto = 路由层 ⑤ 判"新主题"时自动创建。上报命中 auto 行 = 认领，翻转为 user。 */
  origin: text("origin", { enum: ["user", "auto"] }).notNull().default("user"),
  /** origin=auto 时的空间简介（LLM 产出，供后续路由当候选身份卡）。 */
  summary: text("summary"),
  /** 曾用名/同义词（重名去重比对用）；rename/认领时把旧 title 追加。 */
  aliases: text("aliases", { mode: "json" }).$type<string[]>(),
  /** 软删除（null = 存活）：候选池/auto 同步/wiki 挂载全部过滤。 */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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

/** 路由决策流水：溯源 = DocEnvelope.ref（资料实体留在各自表，决策只记 kind+id）。 */
export const routeDecisions = sqliteTable(
  "route_decisions",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "mail", "file", "cloud-doc"],
    }).notNull().default("everroom-doc"),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    /** 外部信封的快照（连接器类源没有 documents 行，待归类/确认执行时要还原内容）。 */
    sourceTitle: text("source_title"),
    sourceMarkdown: text("source_markdown"),
    /** 主 Room（落 ingest）；null = 待归类（含 create_new 待执行）。 */
    primaryRoomId: text("primary_room_id"),
    /** 附带 Room（仅写 room_doc_links 链接，不 ingest）。 */
    linkedRoomIds: text("linked_room_ids", { mode: "json" }).$type<string[]>(),
    /** ⑤ 判 create_new 时的提议（执行后回填 primaryRoomId）。 */
    newRoomName: text("new_room_name"),
    newRoomSummary: text("new_room_summary"),
    /** ⑤ 提议的 Room 类型（对齐渲染器六值枚举）。 */
    newRoomKind: text("new_room_kind"),
    confidence: real("confidence").notNull(),
    /**
     * 终态决策者五种；null = 尚无判决（M1 人审提案 / M2 低置信等待确认）。
     * ③④ 只产候选与证据，不落 decidedBy（plan §5.2）。
     */
    decidedBy: text("decided_by", { enum: ["entry", "link", "rule", "llm", "user"] }),
    /** ③④ 的分数快照（JSON），供复盘与待归类确认展示。 */
    evidence: text("evidence", { mode: "json" }),
    reason: text("reason"),
    status: text("status", {
      enum: ["pending", "auto", "awaiting_review", "confirmed", "reverted"],
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
