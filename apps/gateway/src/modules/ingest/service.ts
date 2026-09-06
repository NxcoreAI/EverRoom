import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  connectorRecords,
  connectorTodos,
  documents,
  ingestEvents,
  parsedContents,
  realityEvents,
  type IngestFilterVerdict,
  type IngestMemoryOk,
} from "../../infrastructure/database/schema.js";
import { FilesService } from "../files/service.js";
import { contentHashOf, fileIdOf } from "../files/storage.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { MemoryService } from "../memory/service.js";
import { tiptapToMarkdown } from "../knowledge/tiptap-markdown.js";
import { titleOfFilename } from "../knowledge/file-convert.js";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import {
  dataTypeByExtension,
  dataTypeDef,
  IngestError,
  type DetectedBy,
  type IngestInput,
  type OriginChannel,
  type Pipelines,
} from "./types.js";
import {
  dataTypeOfJsonType,
  extensionOf,
  normalizeJsonPayload,
  normalizeMarkdown,
  sniffAsMarkdown,
  truncateUtf8,
} from "./normalizers.js";
import { converterOfExtension } from "@nxcore/connectors-module/converters.js";
import { emptyPolicyLayers, resolvePipelines, validatePipelines, type PolicyLayers } from "./policy.js";
import {
  connectorCalendarEventToMarkdown,
  connectorDocumentToMarkdown,
  connectorEmailToMarkdown,
  connectorGenericRecordToMarkdown,
  connectorTodoToMarkdown,
} from "@nxcore/connectors-module/connector-markdown.js";
import { IngestFilterService, type FilterItem } from "./filter-agent.js";

/**
 * 统一理解引擎（unified-ingest-plan §7）：接入面唯一，normalize → classify →
 * policy → ledger → fan-out 全确定性零 LLM。三条链路各自"理解"：
 * Room 链路的知识抽取在 knowledge.route job，记忆链路的 L1 提炼在 MemoryCore，
 * wiki 沉淀在晋升/ingest 时按台账快照判定（引擎不替它们做决定）。
 *
 * U8（定死）：引擎只收 path / ref——本地路径只读不拷贝，库表引用回读
 * 原始字节；引擎仅有的持久化产物是 parsed_contents（md）+ 内容指纹。
 */

/** 记忆链路消费端截断上限（§7 步骤 8：全文住 parsed_contents，消费端各自截断）。 */
const MEMORY_MAX_BYTES = 2 * 1024 * 1024;

function isoDate(value: Date | null): string | undefined {
  return value?.toISOString();
}

/** 台账 sourceKind（与既有 knowledge SourceKind 对齐，mail/cloud-doc 留给 U4）。 */
export type LedgerSourceKind =
  | "everroom-doc"
  | "reality-event"
  | "file"
  | "mail"
  | "cloud-doc"
  | "calendar-event"
  | "todo"
  | "connector-record"
  | "visual-event";

export interface IngestResult {
  eventId: string;
  deduped: boolean;
  source: { sourceKind: LedgerSourceKind; sourceId: string; sourceVersion: number };
  dataType: string;
  detectedBy: DetectedBy;
  title: string;
  contentHash: string;
  parsedId: string;
  pipelines: Pipelines;
  routeJobId: string | null;
  memoryResult: IngestMemoryOk | { error: string } | null;
  /** 过滤闸状态：null = 直通；pending = 待判定（routeJobId/memoryResult 此时尚空）。 */
  filterStatus: "pending" | "passed" | "filtered" | "bypassed" | null;
  filterVerdict: IngestFilterVerdict | null;
  originChannel: string;
}

export interface IngestEventDto {
  id: string;
  sourceKind: LedgerSourceKind;
  sourceId: string;
  sourceVersion: number;
  dataType: string;
  detectedBy: string;
  title: string;
  contentHash: string;
  parsedId: string;
  pipelines: Pipelines;
  memoryResult: IngestResult["memoryResult"];
  routeJobId: string | null;
  /** 过滤闸状态：null = 直通（豁免/关闭）；pending 待判定；passed/filtered/bypassed 见 schema 注释。 */
  filterStatus: "pending" | "passed" | "filtered" | "bypassed" | null;
  filterVerdict: IngestFilterVerdict | null;
  originChannel: string;
  createdAt: string;
  updatedAt: string;
}

/** 过滤 pending 事件的扇出所需上下文（agent 判定通过后恢复扇出用）。 */
interface PendingFanout {
  eventId: string;
  pipelines: Pipelines;
  markdown: string;
  filename?: string | undefined;
  roomId?: string | undefined;
  entrySignals?: IngestInput["entrySignals"];
}

export class IngestService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly files: FilesService,
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
    private readonly logger: Logger,
    /** 两层策略文件（①工程默认 ingest-policy-defaults.json ②部署覆盖 ingest-policies.json），启动时整表读入。 */
    private readonly policyLayers: PolicyLayers = emptyPolicyLayers(),
    /** agent 过滤器（第一级闸门）；null = 过滤关闭，全量直通。 */
    private readonly filter: IngestFilterService | null = null,
  ) {}

  /** 过滤闸 worker：去抖批（N 条或 M ms）→ agent 判定 → 放行扇出 / 记 filtered。 */
  private pendingFanouts = new Map<string, PendingFanout>();
  private filterTimer: NodeJS.Timeout | null = null;
  private filterRunning = false;

  /** 只读展示：当前生效的两层策略（REST GET /v1/ingest/policies 数据源）。 */
  get policy(): PolicyLayers {
    return this.policyLayers;
  }

  /**
   * 引擎主流程（§7 八步）：intake → 读源 → 指纹/闸1 → 归一化 → 解析落库 →
   * 策略快照 → 台账 → 扇出。闸1 命中直接返回既有事件（零成本跳过）。
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    if (input.dataType && !dataTypeDef(input.dataType)) {
      throw new IngestError(`未知数据类型：${input.dataType}`, "unknown_data_type");
    }
    const hasPath = typeof input.source.path === "string" && input.source.path!.length > 0;
    const hasRef = input.source.ref !== undefined;
    if (!hasPath && !hasRef) {
      throw new IngestError("source.path 与 source.ref 必须二选一", "source_required");
    }
    if (hasPath && hasRef) {
      throw new IngestError("source.path 与 source.ref 只能提供一个", "source_conflict");
    }
    return hasPath ? this.ingestFromPath(input) : this.ingestFromRef(input);
  }

  /**
   * 连接器接入（unified-ingest-plan U4「json 信封」预留位的落地形态）：
   * 归一化 markdown 由连接器模块渲染好直传（家在 connectors.sqlite，引擎不回读），
   * 共用台账（闸1 同源同指纹幂等）与三链路扇出。
   * calendar 用独立的 sourceKind "calendar-event"（台账/路由信封枚举均已含；
   * 历史上曾复用 "mail" 靠 dataType 区分，路由投影里会显成错误来源标签）。
   */
  async ingestConnector(unit: {
    kind: "cloud-doc" | "mail" | "calendar-event" | "todo";
    sourceId: string;
    dataType: "document" | "mail" | "calendar" | "todo";
    title: string;
    markdown: string;
    occurredAt?: string;
    entrySignals?: IngestInput["entrySignals"];
    pipelines?: Pipelines;
  }): Promise<IngestResult> {
    const contentHash = contentHashOf(Buffer.from(unit.markdown, "utf8"));
    return this.processNormalized(
      { pipelines: unit.pipelines, ...(unit.entrySignals ? { entrySignals: unit.entrySignals } : {}) },
      {
        sourceKind: unit.kind,
        sourceId: unit.sourceId,
        sourceVersion: this.nextLedgerVersion(unit.kind, unit.sourceId),
        dataType: unit.dataType,
        detectedBy: "source-kind",
        title: unit.title,
        markdown: unit.markdown,
        occurredAt: unit.occurredAt,
        contentHash,
        origin: "connector",
      },
    );
  }

  async ingestVisualEvent(unit: {
    sourceId: string;
    sourceVersion: number;
    title: string;
    markdown: string;
    occurredAt: string;
    pipelines: Pipelines;
  }): Promise<IngestResult> {
    return this.processNormalized(
      { pipelines: unit.pipelines },
      {
        sourceKind: "visual-event",
        sourceId: unit.sourceId,
        sourceVersion: unit.sourceVersion,
        dataType: "perception-event",
        detectedBy: "source-kind",
        title: unit.title,
        markdown: unit.markdown,
        occurredAt: unit.occurredAt,
        contentHash: contentHashOf(Buffer.from(unit.markdown, "utf8")),
        origin: "reality",
      },
    );
  }

  /**
   * Commit Core 的内部摄取入口。Everroom 文档已有确定 Room，因此即使实体
   * router 关闭也可以走入口确定性路由；未启用的下游会从策略中裁掉。
   */
  async ingestCommittedDocument(
    documentId: string,
    expectedVersion: number,
  ): Promise<IngestResult | null> {
    const document = this.db.select().from(documents).where(eq(documents.id, documentId)).get();
    if (!document
      || document.deletedAt
      || document.status !== "active"
      || document.version !== expectedVersion
      || document.version <= 0) {
      return null;
    }
    if (!tiptapToMarkdown(document.contentJson as TiptapJsonContent).trim()) return null;

    const configured = resolvePipelines("document", undefined, this.policyLayers);
    const pipelines: Pipelines = {
      room: configured.room && this.knowledge.enabled,
      wiki: configured.wiki && this.knowledge.enabled,
      memory: configured.memory && this.memory.enabled,
    };
    if (!pipelines.room && !pipelines.wiki && !pipelines.memory) return null;

    const result = await this.ingest({
      source: { ref: { sourceKind: "everroom-doc", sourceId: documentId } },
      dataType: "document",
      pipelines,
      originChannel: "everroom-doc",
    });
    if (result.deduped) return this.resumeDocumentFanout(result, document.updatedAt.toISOString());
    if (!result.memoryResult || !("error" in result.memoryResult)) return result;
    throw new Error(`document memory ingest failed: ${result.memoryResult.error}`);
  }

  /**
   * 撤销一个已 ingest 来源的下游可见性，同时保留历史台账。
   * 软删除后的旧 hash 不参与幂等命中，因此来源恢复时会重新扇出。
   */
  async cleanupSource(sourceKind: LedgerSourceKind, sourceId: string): Promise<void> {
    if (this.knowledge.routerEnabled) this.knowledge.requestSourceCleanup(sourceKind, sourceId);
    await this.memory.deleteDocumentsByCallerRef(sourceId);
    this.db.update(ingestEvents).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(
      eq(ingestEvents.sourceKind, sourceKind),
      eq(ingestEvents.sourceId, sourceId),
      isNull(ingestEvents.deletedAt),
    )).run();
  }

  // ───────────────────────── intake：path / ref ─────────────────────────

  private async ingestFromPath(input: IngestInput): Promise<IngestResult> {
    const path = input.source.path!;
    const filename = basename(path);
    let buffer: Buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      throw new IngestError(`路径不可读：${path}（${(error as Error).message}）`, "path_unreadable");
    }
    // U8：path 只读不拷贝——不进对象库，sourceId 仍按确定性文件身份铸造
    const sourceId = fileIdOf(filename);
    const origin: OriginChannel = input.originChannel ?? "file";
    return this.processBytes(input, {
      sourceKind: "file",
      sourceId,
      filename,
      buffer,
      origin,
      touchFileRow: false,
    });
  }

  private async ingestFromRef(input: IngestInput): Promise<IngestResult> {
    const { sourceKind, sourceId, sourceVersionId } = input.source.ref!;
    switch (sourceKind) {
      case "file": {
        if (sourceVersionId) {
          const context = this.files.getVersionContext(sourceId, sourceVersionId);
          if (!context) throw new IngestError(`file_versions 无此版本：${sourceVersionId}`, "ref_not_found", 404);
          let buffer: Buffer;
          try {
            buffer = await readFile(context.storagePath);
          } catch (error) {
            throw new IngestError(
              `对象库字节不可读：${context.storagePath}（${(error as Error).message}）`,
              "path_unreadable",
            );
          }
          if (contentHashOf(buffer) !== context.version.contentHash) {
            throw new IngestError("本地文件在解析前发生变化，请等待重新扫描", "path_unreadable");
          }
          return this.processBytes(input, {
            sourceKind: "file",
            sourceId,
            sourceVersion: context.version.versionNo,
            filename: context.entry.originalName,
            buffer,
            origin: context.entry.sourceKind === "manual-upload" ? "upload" : "file",
            parserVersion: `${context.version.parserId}@${context.version.parserVersion}`,
            touchFileRow: false,
          });
        }
        const row = this.files.get(sourceId);
        if (!row) throw new IngestError(`uploaded_files 无此行：${sourceId}`, "ref_not_found", 404);
        const storagePath = this.files.storagePathOf(sourceId);
        let buffer: Buffer;
        try {
          buffer = await readFile(storagePath!);
        } catch (error) {
          throw new IngestError(
            `对象库字节不可读：${storagePath}（${(error as Error).message}）`,
            "path_unreadable",
          );
        }
        return this.processBytes(input, {
          sourceKind: "file",
          sourceId,
          filename: row.originalName,
          buffer,
          origin: input.originChannel ?? "upload",
          touchFileRow: true,
        });
      }
      case "everroom-doc": {
        const row = this.db.select().from(documents).where(eq(documents.id, sourceId)).get();
        if (!row) throw new IngestError(`documents 无此行：${sourceId}`, "ref_not_found", 404);
        const markdown = tiptapToMarkdown(row.contentJson as TiptapJsonContent);
        if (!markdown.trim()) throw new IngestError("文档内容为空", "empty_content");
        // 表引用的规范化序列化指纹（§6.1：不读原始字节时的内容键）
        const contentHash = contentHashOf(Buffer.from(JSON.stringify({
          title: row.title,
          contentJson: row.contentJson,
        }), "utf8"));
        return this.processNormalized(input, {
          sourceKind: "everroom-doc",
          sourceId,
          sourceVersion: row.version,
          dataType: input.dataType ?? "document",
          detectedBy: input.dataType ? "explicit" : "source-kind",
          title: input.title ?? row.title,
          markdown,
          contentHash,
          occurredAt: input.occurredAt ?? row.updatedAt.toISOString(),
          origin: input.originChannel ?? "everroom-doc",
        });
      }
      case "reality-event": {
        const row = this.db.select().from(realityEvents).where(eq(realityEvents.id, sourceId)).get();
        if (!row) throw new IngestError(`reality_events 无此行：${sourceId}`, "ref_not_found", 404);
        const markdown = realityEventToMarkdown(row);
        if (!markdown.trim()) throw new IngestError("现实事件尚无转录/洞察内容", "empty_content");
        const contentHash = contentHashOf(Buffer.from(
          JSON.stringify({
            title: row.title,
            transcript: row.transcript,
            transcriptSegments: row.transcriptSegments.map((segment) => ({
              text: segment.text,
              beginTime: segment.beginTime,
              speakerId: segment.speakerId,
            })),
            insights: row.insights,
          }),
          "utf8",
        ));
        return this.processNormalized(input, {
          sourceKind: "reality-event",
          sourceId,
          sourceVersion: row.version,
          dataType: input.dataType ?? "meeting-minutes",
          detectedBy: input.dataType ? "explicit" : "source-kind",
          title: input.title ?? row.title,
          markdown,
          contentHash,
          occurredAt: input.occurredAt ?? (row.endedAt ?? row.startedAt).toISOString(),
          origin: input.originChannel ?? "reality",
        });
      }
      case "connector-email": {
        const row = this.db.select().from(connectorEmails).where(eq(connectorEmails.id, sourceId)).get();
        if (!row) throw new IngestError(`connector_emails 无此行：${sourceId}`, "ref_not_found", 404);
        const markdown = connectorEmailToMarkdown(row);
        return this.processNormalized({
          ...input,
          entrySignals: input.entrySignals ?? {
            sourceTag: `connector:${row.service}`,
            ...(row.threadId ? { threadId: row.threadId } : {}),
          },
        }, {
          sourceKind: "mail",
          sourceId,
          sourceVersion: this.nextLedgerVersion("mail", sourceId),
          dataType: input.dataType ?? "connector-email",
          detectedBy: input.dataType ? "explicit" : "source-kind",
          title: input.title ?? row.subject,
          markdown,
          contentHash: contentHashOf(Buffer.from(markdown, "utf8")),
          occurredAt: input.occurredAt ?? isoDate(row.sentAt ?? row.sourceUpdatedAt),
          origin: input.originChannel ?? "connector",
        });
      }
      case "connector-document": {
        const row = this.db.select().from(connectorDocuments).where(eq(connectorDocuments.id, sourceId)).get();
        if (!row) throw new IngestError(`connector_documents 无此行：${sourceId}`, "ref_not_found", 404);
        const markdown = connectorDocumentToMarkdown(row);
        return this.processNormalized({
          ...input,
          entrySignals: input.entrySignals ?? { sourceTag: `connector:${row.service}` },
        }, {
          sourceKind: "cloud-doc",
          sourceId,
          sourceVersion: this.nextLedgerVersion("cloud-doc", sourceId),
          dataType: input.dataType ?? "connector-document",
          detectedBy: input.dataType ? "explicit" : "source-kind",
          title: input.title ?? row.title,
          markdown,
          contentHash: contentHashOf(Buffer.from(markdown, "utf8")),
          occurredAt: input.occurredAt ?? isoDate(row.sourceUpdatedAt),
          origin: input.originChannel ?? "connector",
        });
      }
      case "connector-calendar": {
        const row = this.db.select().from(connectorCalendarEvents).where(eq(connectorCalendarEvents.id, sourceId)).get();
        if (!row) throw new IngestError(`connector_calendar_events 无此行：${sourceId}`, "ref_not_found", 404);
        const markdown = connectorCalendarEventToMarkdown(row);
        return this.processNormalized({
          ...input,
          entrySignals: input.entrySignals ?? { sourceTag: `connector:${row.service}` },
        }, {
          sourceKind: "calendar-event",
          sourceId,
          sourceVersion: this.nextLedgerVersion("calendar-event", sourceId),
          dataType: input.dataType ?? "connector-calendar",
          detectedBy: input.dataType ? "explicit" : "source-kind",
          title: input.title ?? row.title,
          markdown,
          contentHash: contentHashOf(Buffer.from(markdown, "utf8")),
          occurredAt: input.occurredAt ?? isoDate(row.startAt ?? row.sourceUpdatedAt),
          origin: input.originChannel ?? "connector",
        });
      }
      case "connector-todo": {
        const row = this.db.select().from(connectorTodos).where(eq(connectorTodos.id, sourceId)).get();
        if (!row) throw new IngestError(`connector_todos 无此行：${sourceId}`, "ref_not_found", 404);
        const markdown = connectorTodoToMarkdown(row);
        return this.processNormalized({
          ...input,
          // 清单级 listId 进规则信号（与日历的 calendarId 对等）：规则可只匹配某个清单的待办。
          entrySignals: input.entrySignals ?? {
            sourceTag: `connector:${row.service}`,
            ...(row.listId ? { listId: row.listId } : {}),
          },
        }, {
          sourceKind: "todo",
          sourceId,
          sourceVersion: this.nextLedgerVersion("todo", sourceId),
          dataType: input.dataType ?? "connector-todo",
          detectedBy: input.dataType ? "explicit" : "source-kind",
          title: input.title ?? row.title,
          markdown,
          contentHash: contentHashOf(Buffer.from(markdown, "utf8")),
          occurredAt: input.occurredAt ?? isoDate(row.dueAt ?? row.completedAt ?? row.sourceUpdatedAt),
          origin: input.originChannel ?? "connector",
        });
      }
      case "connector-record": {
        const row = this.db.select().from(connectorRecords).where(eq(connectorRecords.id, sourceId)).get();
        if (!row) throw new IngestError(`connector_records 无此行：${sourceId}`, "ref_not_found", 404);
        const markdown = connectorGenericRecordToMarkdown(row);
        return this.processNormalized({
          ...input,
          entrySignals: input.entrySignals ?? { sourceTag: `connector:${row.service}` },
        }, {
          sourceKind: "connector-record",
          sourceId,
          sourceVersion: this.nextLedgerVersion("connector-record", sourceId),
          dataType: input.dataType ?? "connector-record",
          detectedBy: input.dataType ? "explicit" : "source-kind",
          title: input.title ?? row.dataset,
          markdown,
          contentHash: contentHashOf(Buffer.from(markdown, "utf8")),
          occurredAt: input.occurredAt ?? isoDate(row.sourceUpdatedAt),
          origin: input.originChannel ?? "connector",
        });
      }
    }
  }

  // ───────────────────── 归一化 + 台账 + 扇出（共用主流程） ─────────────────────

  private async processBytes(
    input: IngestInput,
    ctx: {
      sourceKind: LedgerSourceKind;
      sourceId: string;
      filename: string;
      buffer: Buffer;
      origin: OriginChannel;
      sourceVersion?: number;
      parserVersion?: string;
      /** ref 形态回填 uploaded_files.current_parsed_id；path 形态无登记行。 */
      touchFileRow: boolean;
    },
  ): Promise<IngestResult> {
    const contentHash = contentHashOf(ctx.buffer);

    // 闸1（台账层）：同源同指纹零成本跳过——归一化/解析/扇出全免
    const existing = this.ledgerHit(ctx.sourceKind, ctx.sourceId, contentHash);
    if (existing) return this.toResult(existing, true);

    const normalized = await normalizeFileBytes(ctx.filename, ctx.buffer, input.dataType);
    return this.processNormalized(input, {
      sourceKind: ctx.sourceKind,
      sourceId: ctx.sourceId,
      sourceVersion: ctx.sourceVersion ?? this.nextLedgerVersion(ctx.sourceKind, ctx.sourceId),
      dataType: normalized.dataType,
      detectedBy: normalized.detectedBy,
      title: input.title ?? normalized.title,
      markdown: normalized.markdown,
      occurredAt: input.occurredAt,
      contentHash,
      origin: ctx.origin,
      jsonType: normalized.jsonType,
      touchFileRow: ctx.touchFileRow,
      parserVersion: ctx.parserVersion,
      filename: ctx.filename,
    });
  }

  private async processNormalized(
    input: Pick<IngestInput, "pipelines" | "entrySignals" | "roomId">,
    unit: {
      sourceKind: LedgerSourceKind;
      sourceId: string;
      sourceVersion: number;
      dataType: string;
      detectedBy: DetectedBy;
      title: string;
      markdown: string;
      occurredAt?: string | undefined;
      contentHash: string;
      origin: OriginChannel;
      jsonType?: string | undefined;
      touchFileRow?: boolean | undefined;
      parserVersion?: string | undefined;
      filename?: string | undefined;
    },
  ): Promise<IngestResult> {
    const existing = this.ledgerHit(unit.sourceKind, unit.sourceId, unit.contentHash);
    if (existing) return this.toResult(existing, true);

    // 策略解析（请求覆盖 > 配置文件 > defaults）+ 组合校验 + router 前置
    const pipelines = resolvePipelines(unit.dataType, input.pipelines, this.policyLayers);
    const invalid = validatePipelines(pipelines);
    if (invalid) throw new IngestError("链路开关组合非法（wiki 依赖 Room；至少开一条链路）", invalid);
    if (pipelines.room && !this.knowledge.routerEnabled && unit.sourceKind !== "everroom-doc") {
      throw new IngestError("Room 链路需要开启 knowledge router（roomWikisEnabled）", "router_disabled", 400);
    }

    // 解析产物（闸2 同 hash 同 parser 幂等）；file ref 顺带回填登记行指针
    const parsedId = this.files.ensureParsed(unit.contentHash, unit.markdown, unit.parserVersion);
    if (unit.touchFileRow) this.files.touchParsed(unit.sourceId, parsedId);

    // 台账：类型识别 + 策略快照落定（晋升/增量 ingest 的 wiki 判定读快照）
    const eventId = `ing-${randomUUID().slice(0, 12)}`;

    // 过滤闸（第一级）：开启且不豁免 → 记 pending 不扇出，去抖批送 agent 判定
    // A user-authored web clip is an explicit save intent. It must be normalized
    // and fan out to Memory/Knowledge even when the generic noise filter is on.
    const filterGate = this.filter && this.filter.enabled
      && unit.origin !== "web-clipper"
      && !this.filter.exempt(unit.sourceKind);
    if (filterGate) {
      this.db.insert(ingestEvents).values({
        id: eventId,
        sourceKind: unit.sourceKind,
        sourceId: unit.sourceId,
        sourceVersion: unit.sourceVersion,
        dataType: unit.dataType,
        detectedBy: unit.detectedBy,
        title: unit.title,
        contentHash: unit.contentHash,
        parsedId,
        pipelines,
        originChannel: unit.origin,
        filterStatus: "pending",
      }).run();
      this.pendingFanouts.set(eventId, {
        eventId,
        pipelines,
        markdown: unit.markdown,
        filename: unit.filename,
        roomId: input.roomId,
        entrySignals: input.entrySignals,
      });
      this.scheduleFilterBatch();
      this.logger.info(
        { event: "ingest.filter.pending", eventId, sourceKind: unit.sourceKind, sourceId: unit.sourceId },
        "ingest event pending filter verdict",
      );
      return {
        eventId,
        deduped: false,
        source: {
          sourceKind: unit.sourceKind,
          sourceId: unit.sourceId,
          sourceVersion: unit.sourceVersion,
        },
        dataType: unit.dataType,
        detectedBy: unit.detectedBy,
        title: unit.title,
        contentHash: unit.contentHash,
        parsedId,
        pipelines,
        routeJobId: null,
        memoryResult: null,
        filterStatus: "pending",
        filterVerdict: null,
        originChannel: unit.origin,
      };
    }

    this.db.insert(ingestEvents).values({
      id: eventId,
      sourceKind: unit.sourceKind,
      sourceId: unit.sourceId,
      sourceVersion: unit.sourceVersion,
      dataType: unit.dataType,
      detectedBy: unit.detectedBy,
      title: unit.title,
      contentHash: unit.contentHash,
      parsedId,
      pipelines,
      originChannel: unit.origin,
    }).run();

    return this.fanOut({
      ...unit,
      eventId,
      pipelines,
      parsedId,
      entrySignals: input.entrySignals,
      roomId: input.roomId,
    });
  }

  /**
   * 三链路扇出（原 processNormalized 后半段）：过滤直通路径与判定放行路径共用。
   * 失败只记 memoryResult/routeJobId 错误，不抛出（闸门视角扇出已不可重试地决定）。
   */
  private async fanOut(unit: {
    eventId: string;
    sourceKind: LedgerSourceKind;
    sourceId: string;
    sourceVersion: number;
    dataType: string;
    detectedBy: string;
    title: string;
    markdown: string;
    occurredAt?: string | undefined;
    contentHash: string;
    parsedId: string;
    origin: OriginChannel;
    pipelines: Pipelines;
    filename?: string | undefined;
    roomId?: string | undefined;
    entrySignals?: IngestInput["entrySignals"];
  }): Promise<IngestResult> {
    const eventId = unit.eventId;

    // 扇出 ①：记忆链路（失败只记 memoryResult，不阻塞 Room 链路）
    let memoryResult: IngestResult["memoryResult"] = null;
    if (unit.pipelines.memory) {
      if (!this.memory.enabled) {
        memoryResult = { error: "memory_core_disabled" };
      } else {
        try {
          const imported = await this.memory.importToMemoryCore({
            title: unit.title,
            markdown: truncateUtf8(
              unit.markdown,
              MEMORY_MAX_BYTES,
              "<!-- 截断：原文超 2MB 消费端上限，全文见文件中心 -->",
            ),
            callerRef: unit.sourceId,
          });
          memoryResult = {
            documentId: imported.document.id,
            chunkCount: imported.chunkCount,
            deduplicated: imported.deduplicated,
          };
        } catch (error) {
          memoryResult = { error: (error as Error).message };
          this.logger.warn(
            { event: "ingest.memory.failed", eventId, sourceId: unit.sourceId, err: (error as Error).message },
            "memory pipeline fan-out failed",
          );
        }
      }
    }
    if (memoryResult !== null) {
      this.db.update(ingestEvents)
        .set({ memoryResult, updatedAt: new Date() })
        .where(eq(ingestEvents.id, eventId))
        .run();
    }

    // 扇出 ②：Room 链路（knowledge.route job；wiki 沉淀在晋升/ingest 时按快照判定）
    let routeJobId: string | null = null;
    if (unit.pipelines.room) {
      const entrySignals = unit.entrySignals ?? (unit.filename
        ? { filenamePrefix: unit.filename }
        : undefined);
      const submitted = unit.sourceKind === "everroom-doc"
        ? this.knowledge.submitCommittedDocument({
            documentId: unit.sourceId,
            sourceVersion: unit.sourceVersion,
            title: unit.title,
            markdown: unit.markdown,
            ...(unit.occurredAt ? { occurredAt: unit.occurredAt } : {}),
          })
        : this.knowledge.submitEnvelope({
            sourceKind: unit.sourceKind,
            sourceId: unit.sourceId,
            sourceVersion: unit.sourceVersion,
            title: unit.title,
            markdown: unit.markdown,
            ...(unit.occurredAt ? { occurredAt: unit.occurredAt } : {}),
            ...(unit.roomId ? { entryRoomId: unit.roomId } : {}),
            ...(entrySignals ? { entrySignals } : {}),
          });
      routeJobId = submitted.jobId;
    }

    if (memoryResult !== null || routeJobId !== null) {
      this.db.update(ingestEvents)
        .set({ memoryResult, routeJobId, updatedAt: new Date() })
        .where(eq(ingestEvents.id, eventId))
        .run();
    }

    this.logger.info(
      {
        event: "ingest.completed",
        eventId,
        sourceKind: unit.sourceKind,
        sourceId: unit.sourceId,
        dataType: unit.dataType,
        pipelines: unit.pipelines,
        routeJobId,
      },
      "ingest event completed",
    );
    return {
      eventId,
      deduped: false,
      source: {
        sourceKind: unit.sourceKind,
        sourceId: unit.sourceId,
        sourceVersion: unit.sourceVersion,
      },
      dataType: unit.dataType,
      detectedBy: unit.detectedBy as DetectedBy,
      title: unit.title,
      contentHash: unit.contentHash,
      parsedId: unit.parsedId,
      pipelines: unit.pipelines,
      routeJobId,
      memoryResult,
      filterStatus: null,
      filterVerdict: null,
      originChannel: unit.origin,
    };
  }

  // ───────────────────────── 过滤闸 worker（去抖批） ─────────────────────────

  /** 去抖：攒 batchSize 条或 batchDelayMs 触发一次 agent 批量判定。 */
  private scheduleFilterBatch(): void {
    if (!this.filter) return;
    const batchFull = this.pendingFanouts.size >= this.filter.batchSizeOf();
    if (this.filterTimer && !batchFull) return;
    if (this.filterTimer) {
      clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      void this.runFilterBatch();
    }, batchFull ? 0 : this.filter.delayMsOf());
    this.filterTimer.unref?.();
  }

  private async runFilterBatch(): Promise<void> {
    if (!this.filter || this.filterRunning || this.pendingFanouts.size === 0) return;
    this.filterRunning = true;
    const batch = [...this.pendingFanouts.values()].slice(0, this.filter.batchSizeOf());
    try {
      const items: FilterItem[] = batch.map((pending) => {
        const row = this.db.select().from(ingestEvents)
          .where(eq(ingestEvents.id, pending.eventId)).get();
        return {
          eventId: pending.eventId,
          title: row?.title ?? "",
          dataType: row?.dataType ?? "document",
          sourceKind: row?.sourceKind ?? "file",
          occurredAt: row?.createdAt.toISOString(),
          markdown: pending.markdown,
        };
      });
      const outcomes = await this.filter.judgeBatch(items);
      const enforce = this.filter.enforce();
      for (const pending of batch) {
        this.pendingFanouts.delete(pending.eventId);
        const outcome = outcomes.get(pending.eventId);
        if (!outcome) {
          // 不应发生（judgeBatch 缺项兜底），fail-open 兜底
          await this.releasePending(pending, "bypassed", failOpenVerdict("outcome_missing"));
          continue;
        }
        if (enforce && !outcome.verdict.informative) {
          // enforce + 判定无价值：拦下，不进下游链路（台账可见可 reinstate）
          this.db.update(ingestEvents)
            .set({ filterStatus: "filtered", filterVerdict: outcome.verdict, updatedAt: new Date() })
            .where(eq(ingestEvents.id, pending.eventId)).run();
          this.logger.info(
            { event: "ingest.filter.blocked", eventId: pending.eventId, category: outcome.verdict.category },
            "ingest event filtered out",
          );
          continue;
        }
        const status = outcome.kind === "fail-open" ? "bypassed" : "passed";
        await this.releasePending(pending, status, outcome.verdict);
      }
    } catch (error) {
      // judgeBatch 内部已 fail-open，这里只是防御：整批放行
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ event: "ingest.filter.batch_error", error: message }, "ingest filter batch crashed");
      for (const pending of batch) {
        this.pendingFanouts.delete(pending.eventId);
        await this.releasePending(pending, "bypassed", failOpenVerdict(message)).catch(() => undefined);
      }
    } finally {
      this.filterRunning = false;
      if (this.pendingFanouts.size > 0) this.scheduleFilterBatch();
    }
  }

  /** pending → 终态（passed/bypassed）并恢复扇出。 */
  private async releasePending(
    pending: PendingFanout,
    status: "passed" | "bypassed",
    verdict: IngestFilterVerdict,
  ): Promise<void> {
    this.db.update(ingestEvents)
      .set({ filterStatus: status, filterVerdict: verdict, updatedAt: new Date() })
      .where(eq(ingestEvents.id, pending.eventId)).run();
    const row = this.db.select().from(ingestEvents)
      .where(eq(ingestEvents.id, pending.eventId)).get();
    if (!row) return;
    await this.fanOut({
      eventId: row.id,
      sourceKind: row.sourceKind as LedgerSourceKind,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
      dataType: row.dataType,
      detectedBy: row.detectedBy,
      title: row.title,
      markdown: pending.markdown,
      contentHash: row.contentHash,
      parsedId: row.parsedId,
      origin: row.originChannel as OriginChannel,
      pipelines: pending.pipelines,
      filename: pending.filename,
      roomId: pending.roomId,
      entrySignals: pending.entrySignals,
    });
  }

  /** 误杀恢复：filtered 事件重新放行扇出（POST /v1/ingest/events/:id/reinstate）。 */
  async reinstate(eventId: string): Promise<IngestEventDto | null> {
    const row = this.db.select().from(ingestEvents)
      .where(eq(ingestEvents.id, eventId)).get();
    if (!row) return null;
    if (row.filterStatus !== "filtered") throw new IngestError("仅 filtered 状态的事件可恢复", "not_filtered", 409);
    const parsed = this.db.select().from(parsedContents)
      .where(eq(parsedContents.id, row.parsedId)).get();
    if (!parsed) throw new IngestError("归一化产物缺失，无法恢复", "parsed_missing", 410);
    this.db.update(ingestEvents)
      .set({ filterStatus: "passed", reinstatedAt: new Date(), updatedAt: new Date() })
      .where(eq(ingestEvents.id, eventId)).run();
    await this.fanOut({
      eventId: row.id,
      sourceKind: row.sourceKind as LedgerSourceKind,
      sourceId: row.sourceId,
      sourceVersion: row.sourceVersion,
      dataType: row.dataType,
      detectedBy: row.detectedBy,
      title: row.title,
      markdown: parsed.markdown,
      occurredAt: row.createdAt.toISOString(),
      contentHash: row.contentHash,
      parsedId: row.parsedId,
      origin: row.originChannel as OriginChannel,
      pipelines: row.pipelines,
    });
    return this.getEvent(eventId);
  }

  /** 启动恢复：pending 滞留（进程被杀时去抖批未跑）重新入队。 */
  recoverPendingFilters(): void {
    if (!this.filter?.enabled) return;
    const rows = this.db.select({ id: ingestEvents.id })
      .from(ingestEvents)
      .where(eq(ingestEvents.filterStatus, "pending"))
      .all();
    for (const row of rows) {
      const event = this.db.select().from(ingestEvents)
        .where(eq(ingestEvents.id, row.id)).get();
      if (!event) continue;
      const parsed = this.db.select().from(parsedContents)
        .where(eq(parsedContents.id, event.parsedId)).get();
      if (!parsed) {
        // 产物缺失无法扇出，fail-open 落终态避免永久滞留
        this.db.update(ingestEvents)
          .set({ filterStatus: "bypassed", filterVerdict: failOpenVerdict("parsed_missing_on_recover"), updatedAt: new Date() })
          .where(eq(ingestEvents.id, row.id)).run();
        continue;
      }
      this.pendingFanouts.set(row.id, {
        eventId: row.id,
        pipelines: event.pipelines,
        markdown: parsed.markdown,
      });
    }
    if (this.pendingFanouts.size > 0) {
      this.logger.info({ count: this.pendingFanouts.size }, "recovered pending filter fanouts");
      this.scheduleFilterBatch();
    }
  }

  disposeFilter(): void {
    if (this.filterTimer) clearTimeout(this.filterTimer);
    this.filterTimer = null;
    this.pendingFanouts.clear();
  }

  // ───────────────────────── 台账读取 ─────────────────────────

  listEvents(query: {
    limit?: number;
    offset?: number;
    sourceKind?: string;
    sourceId?: string;
  }): { items: IngestEventDto[]; total: number } {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const conditions = [
      query.sourceKind ? eq(ingestEvents.sourceKind, query.sourceKind as LedgerSourceKind) : undefined,
      query.sourceId ? eq(ingestEvents.sourceId, query.sourceId) : undefined,
    ].filter((condition) => condition !== undefined);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = this.db.select().from(ingestEvents)
      .where(where)
      .orderBy(desc(ingestEvents.createdAt), desc(ingestEvents.id))
      .limit(limit)
      .offset(offset)
      .all();
    const total = this.db.select({ id: ingestEvents.id }).from(ingestEvents)
      .where(where)
      .all().length;
    return { items: rows.map(toEventDto), total };
  }

  getEvent(id: string): IngestEventDto | null {
    const row = this.db.select().from(ingestEvents).where(eq(ingestEvents.id, id)).get();
    return row ? toEventDto(row) : null;
  }

  /** 事件归一化产物全文（台账详情查看用；产物缺失 404 由调用方处理）。 */
  getEventContent(id: string): { markdown: string; parsedAt: string } | null {
    const row = this.db.select({ parsedId: ingestEvents.parsedId })
      .from(ingestEvents).where(eq(ingestEvents.id, id)).get();
    if (!row) return null;
    const parsed = this.db.select().from(parsedContents)
      .where(eq(parsedContents.id, row.parsedId)).get();
    if (!parsed) return null;
    return { markdown: parsed.markdown, parsedAt: parsed.parsedAt.toISOString() };
  }

  /** 台账取某源最新事件（wiki 快照判定 / 桌面端导入记录用）。 */
  latestEventOf(sourceKind: LedgerSourceKind, sourceId: string): IngestEventDto | null {
    const row = this.db.select().from(ingestEvents)
      .where(and(
        eq(ingestEvents.sourceKind, sourceKind),
        eq(ingestEvents.sourceId, sourceId),
        isNull(ingestEvents.deletedAt),
      ))
      .orderBy(desc(ingestEvents.createdAt), desc(ingestEvents.id))
      .limit(1)
      .get();
    return row ? toEventDto(row) : null;
  }

  private ledgerHit(sourceKind: LedgerSourceKind, sourceId: string, contentHash: string) {
    return this.db.select().from(ingestEvents)
      .where(and(
        eq(ingestEvents.sourceKind, sourceKind),
        eq(ingestEvents.sourceId, sourceId),
        eq(ingestEvents.contentHash, contentHash),
        isNull(ingestEvents.deletedAt),
      ))
      .orderBy(desc(ingestEvents.createdAt))
      .limit(1)
      .get() ?? null;
  }

  /** file 源版本流：引擎台账自身记账（knowledge route 版本由扇出带回）。 */
  private nextLedgerVersion(sourceKind: LedgerSourceKind, sourceId: string): number {
    const row = this.db.select({ sourceVersion: ingestEvents.sourceVersion })
      .from(ingestEvents)
      .where(and(eq(ingestEvents.sourceKind, sourceKind), eq(ingestEvents.sourceId, sourceId)))
      .orderBy(desc(ingestEvents.sourceVersion))
      .limit(1)
      .get();
    return (row?.sourceVersion ?? 0) + 1;
  }

  /** 命中摄取台账后恢复尚未成功的扇出，避免部分成功被内容去重吞掉。 */
  private async resumeDocumentFanout(result: IngestResult, occurredAt: string): Promise<IngestResult> {
    const event = this.db.select().from(ingestEvents).where(eq(ingestEvents.id, result.eventId)).get();
    const parsed = event
      ? this.db.select().from(parsedContents).where(eq(parsedContents.id, event.parsedId)).get()
      : null;
    if (!event || !parsed) return result;

    let memoryResult = event.memoryResult;
    if (event.pipelines.memory
      && this.memory.enabled
      && (!memoryResult || "error" in memoryResult)) {
      const imported = await this.memory.importToMemoryCore({
        title: event.title,
        markdown: truncateUtf8(
          parsed.markdown,
          MEMORY_MAX_BYTES,
          "<!-- 截断：原文超 2MB 消费端上限，全文见文件中心 -->",
        ),
        callerRef: event.sourceId,
      });
      memoryResult = {
        documentId: imported.document.id,
        chunkCount: imported.chunkCount,
        deduplicated: imported.deduplicated,
      } satisfies IngestMemoryOk;
      this.db.update(ingestEvents).set({ memoryResult, updatedAt: new Date() })
        .where(eq(ingestEvents.id, event.id)).run();
    }

    let routeJobId = event.routeJobId;
    if (event.pipelines.room && this.knowledge.enabled && !routeJobId) {
      routeJobId = this.knowledge.submitCommittedDocument({
        documentId: event.sourceId,
        sourceVersion: event.sourceVersion,
        title: event.title,
        markdown: parsed.markdown,
        occurredAt,
      }).jobId;
      this.db.update(ingestEvents).set({ routeJobId, updatedAt: new Date() })
        .where(eq(ingestEvents.id, event.id)).run();
    }
    return { ...result, memoryResult, routeJobId };
  }

  private toResult(row: typeof ingestEvents.$inferSelect, deduped: boolean): IngestResult {
    const dto = toEventDto(row);
    return {
      eventId: dto.id,
      deduped,
      source: { sourceKind: dto.sourceKind, sourceId: dto.sourceId, sourceVersion: dto.sourceVersion },
      dataType: dto.dataType,
      detectedBy: dto.detectedBy as DetectedBy,
      title: dto.title,
      contentHash: dto.contentHash,
      parsedId: dto.parsedId,
      pipelines: dto.pipelines,
      routeJobId: dto.routeJobId,
      memoryResult: dto.memoryResult,
      filterStatus: dto.filterStatus,
      filterVerdict: dto.filterVerdict,
      originChannel: dto.originChannel,
    };
  }
}

// ───────────────────────── 归一化：文件字节 ─────────────────────────

/**
 * 识别优先级（§4）：显式声明 > jsonType 结构 > 扩展名注册表 > 嗅探。
 * md 族直通；json 载荷按结构归一化；office/html/csv/eml 走 converters（U2）；
 * 未知/无扩展名嗅探 UTF-8 文本，二进制拒绝 unsupported_type。
 */
async function normalizeFileBytes(
  filename: string,
  buffer: Buffer,
  explicitDataType: string | undefined,
): Promise<{ dataType: string; detectedBy: DetectedBy; title: string; markdown: string; jsonType?: string }> {
  const extension = extensionOf(filename);
  const mdFamily = ["md", "markdown", "mdx", "txt", "text"];

  if (extension === "json") {
    let payload: unknown;
    try {
      payload = JSON.parse(buffer.toString("utf8")) as unknown;
    } catch {
      throw new IngestError("JSON 文件解析失败", "convert_failed");
    }
    const normalized = normalizeJsonPayload(payload, undefined, titleOfFilename(filename));
    return {
      dataType: explicitDataType ?? dataTypeOfJsonType(normalized.jsonType) ?? "document",
      detectedBy: explicitDataType ? "explicit" : "json-type",
      title: normalized.title,
      markdown: normalized.markdown,
      jsonType: normalized.jsonType,
    };
  }

  if (mdFamily.includes(extension)) {
    const normalized = normalizeMarkdown(filename, buffer);
    return {
      dataType: explicitDataType ?? "document",
      detectedBy: explicitDataType ? "explicit" : "extension",
      title: normalized.title,
      markdown: normalized.markdown,
    };
  }

  // U2 转换器：docx/xlsx/pptx/csv/html/eml -> md（类型随扩展名注册表）
  const converter = converterOfExtension(extension);
  if (converter) {
    const markdown = await converter(buffer, filename);
    return {
      dataType: explicitDataType ?? dataTypeByExtension(extension)?.key ?? "document",
      detectedBy: explicitDataType ? "explicit" : "extension",
      title: titleOfFilename(filename),
      markdown,
    };
  }

  // 未知/无扩展名：md 嗅探兜底（能按 UTF-8 文本读 → document）
  if (sniffAsMarkdown(buffer)) {
    const normalized = normalizeMarkdown(filename, buffer);
    return {
      dataType: explicitDataType ?? "document",
      detectedBy: explicitDataType ? "explicit" : "sniff",
      title: normalized.title,
      markdown: normalized.markdown,
    };
  }
  throw new IngestError(
    `无法识别 ${filename || "(无扩展名)"} 的内容格式（非 UTF-8 文本，且扩展名不在注册表）`,
    "unsupported_type",
  );
}

/** reality_events 行 → 会议纪要 md（§5.2 模板；转录段说话人按 speakerId 标注）。 */
function realityEventToMarkdown(row: typeof realityEvents.$inferSelect): string {
  const insights = row.insights ?? {};
  const segments = (row.transcriptSegments ?? []).map((segment) => ({
    speaker: segment.speakerId === null ? "" : `说话人${segment.speakerId + 1}`,
    text: segment.text,
    at: formatMillis(segment.beginTime),
  }));
  const parts: string[] = [`# ${row.title}`];
  const summary = typeof insights.summary === "string" ? insights.summary.trim() : "";
  if (summary) parts.push(`## 摘要\n\n${summary}`);
  const keyPoints = Array.isArray(insights.keyPoints)
    ? insights.keyPoints.filter((point) => typeof point === "string" && point.trim())
    : [];
  if (keyPoints.length > 0) parts.push(`## 要点\n\n${keyPoints.map((point) => `- ${point}`).join("\n")}`);
  const decisions = Array.isArray(insights.decisions)
    ? insights.decisions.filter((item) => typeof item === "string" && item.trim())
    : [];
  if (decisions.length > 0) parts.push(`## 决议\n\n${decisions.map((item) => `- ${item}`).join("\n")}`);
  const actionItems = Array.isArray(insights.actionItems)
    ? insights.actionItems.filter((item) => typeof item === "string" && item.trim())
    : [];
  if (actionItems.length > 0) parts.push(`## 行动项\n\n${actionItems.map((item) => `- ${item}`).join("\n")}`);
  if (segments.length > 0) {
    parts.push(`## 逐字稿\n\n${segments
      .map((segment) => `- **${segment.speaker || "发言者"}**（${segment.at}）：${segment.text}`)
      .join("\n")}`);
  } else if (typeof row.transcript === "string" && row.transcript.trim()) {
    parts.push(`## 逐字稿\n\n${row.transcript.trim()}`);
  }
  return parts.join("\n\n");
}

function formatMillis(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function toEventDto(row: typeof ingestEvents.$inferSelect): IngestEventDto {
  return {
    id: row.id,
    sourceKind: row.sourceKind as LedgerSourceKind,
    sourceId: row.sourceId,
    sourceVersion: row.sourceVersion,
    dataType: row.dataType,
    detectedBy: row.detectedBy,
    title: row.title,
    contentHash: row.contentHash,
    parsedId: row.parsedId,
    pipelines: row.pipelines,
    memoryResult: row.memoryResult ?? null,
    routeJobId: row.routeJobId ?? null,
    filterStatus: row.filterStatus ?? null,
    filterVerdict: row.filterVerdict ?? null,
    originChannel: row.originChannel,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 过滤器故障放行 verdict（bypassed 终态记录失败原因）。 */
function failOpenVerdict(reason: string): IngestFilterVerdict {
  return {
    informative: true,
    reason: `过滤器故障放行：${reason.slice(0, 200)}`,
    category: "other",
    confidence: 0,
  };
}
