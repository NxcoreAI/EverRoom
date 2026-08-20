import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documents,
  ingestEvents,
  parsedContents,
  realityEvents,
  type IngestMemoryOk,
} from "../../infrastructure/database/schema.js";
import { FilesService } from "../files/service.js";
import { contentHashOf, fileIdOf } from "../files/storage.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { MemoryService } from "../memory/service.js";
import { normalizeInsightTags } from "../reality/insight-tags.js";
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
  extensionOf,
  normalizeJsonPayload,
  normalizeMarkdown,
  sniffAsMarkdown,
  truncateUtf8,
} from "./normalizers.js";
import { converterOfExtension } from "./converters.js";
import { emptyPolicyLayers, resolvePipelines, validatePipelines, type PolicyLayers } from "./policy.js";

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

/** 台账 sourceKind（与既有 knowledge SourceKind 对齐；mail/cloud-doc 为连接器预留位）。 */
export type LedgerSourceKind = "everroom-doc" | "reality-event" | "visual-event" | "file" | "mail" | "cloud-doc";

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
  originChannel: string;
  createdAt: string;
  updatedAt: string;
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
  ) {}

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
   * ponytail: calendar 复用 sourceKind "mail"（schema 预留位只有 mail/cloud-doc），
   * 靠 dataType=calendar 区分；要独立枚举时再加迁移。
   */
  async ingestConnector(unit: {
    kind: "cloud-doc" | "mail";
    sourceId: string;
    dataType: "document" | "mail" | "calendar";
    title: string;
    markdown: string;
    occurredAt?: string;
    pipelines?: Pipelines;
  }): Promise<IngestResult> {
    const contentHash = contentHashOf(Buffer.from(unit.markdown, "utf8"));
    return this.processNormalized(
      { pipelines: unit.pipelines },
      {
        sourceKind: unit.kind,
        sourceId: unit.sourceId,
        sourceVersion: this.nextLedgerVersion(unit.sourceId),
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
    const { sourceKind, sourceId } = input.source.ref!;
    switch (sourceKind) {
      case "file": {
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
          JSON.stringify({ title: row.title, transcript: row.transcript, insights: row.insights, version: row.version }),
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
      /** ref 形态回填 uploaded_files.current_parsed_id；path 形态无登记行。 */
      touchFileRow: boolean;
    },
  ): Promise<IngestResult> {
    const contentHash = contentHashOf(ctx.buffer);

    // 闸1（台账层）：同源同指纹零成本跳过——归一化/解析/扇出全免
    const existing = this.ledgerHit(ctx.sourceId, contentHash);
    if (existing) return this.toResult(existing, true);

    const normalized = await normalizeFileBytes(ctx.filename, ctx.buffer, input.dataType);
    return this.processNormalized(input, {
      sourceKind: ctx.sourceKind,
      sourceId: ctx.sourceId,
      sourceVersion: this.nextLedgerVersion(ctx.sourceId),
      dataType: normalized.dataType,
      detectedBy: normalized.detectedBy,
      title: input.title ?? normalized.title,
      markdown: normalized.markdown,
      occurredAt: input.occurredAt,
      contentHash,
      origin: ctx.origin,
      jsonType: normalized.jsonType,
      touchFileRow: ctx.touchFileRow,
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
      filename?: string | undefined;
    },
  ): Promise<IngestResult> {
    const existing = this.ledgerHit(unit.sourceId, unit.contentHash);
    if (existing) return this.toResult(existing, true);

    // 策略解析（请求覆盖 > 配置文件 > defaults）+ 组合校验 + router 前置
    const pipelines = resolvePipelines(unit.dataType, input.pipelines, this.policyLayers);
    const invalid = validatePipelines(pipelines);
    if (invalid) throw new IngestError("链路开关组合非法（wiki 依赖 Room；至少开一条链路）", invalid);
    if (pipelines.room && !this.knowledge.routerEnabled && unit.sourceKind !== "everroom-doc") {
      throw new IngestError("Room 链路需要开启 knowledge router（roomWikisEnabled）", "router_disabled", 400);
    }

    // 解析产物（闸2 同 hash 同 parser 幂等）；file ref 顺带回填登记行指针
    const parsedId = this.files.ensureParsed(unit.contentHash, unit.markdown);
    if (unit.touchFileRow) this.files.touchParsed(unit.sourceId, parsedId);

    // 台账：类型识别 + 策略快照落定（晋升/增量 ingest 的 wiki 判定读快照）
    const eventId = `ing-${randomUUID().slice(0, 12)}`;
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

    // 扇出 ①：记忆链路（失败只记 memoryResult，不阻塞 Room 链路）
    let memoryResult: IngestResult["memoryResult"] = null;
    if (pipelines.memory) {
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
    if (pipelines.room) {
      const entrySignals = input.entrySignals ?? (unit.filename
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
            ...(input.roomId ? { entryRoomId: input.roomId } : {}),
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
        pipelines,
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
      detectedBy: unit.detectedBy,
      title: unit.title,
      contentHash: unit.contentHash,
      parsedId,
      pipelines,
      routeJobId,
      memoryResult,
      originChannel: unit.origin,
    };
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

  /** 台账取某源最新事件（wiki 快照判定 / 桌面端导入记录用）。 */
  latestEventOf(sourceKind: LedgerSourceKind, sourceId: string): IngestEventDto | null {
    const row = this.db.select().from(ingestEvents)
      .where(and(eq(ingestEvents.sourceKind, sourceKind), eq(ingestEvents.sourceId, sourceId)))
      .orderBy(desc(ingestEvents.createdAt), desc(ingestEvents.id))
      .limit(1)
      .get();
    return row ? toEventDto(row) : null;
  }

  private ledgerHit(sourceId: string, contentHash: string) {
    return this.db.select().from(ingestEvents)
      .where(and(eq(ingestEvents.sourceId, sourceId), eq(ingestEvents.contentHash, contentHash)))
      .orderBy(desc(ingestEvents.createdAt))
      .limit(1)
      .get() ?? null;
  }

  /** file 源版本流：引擎台账自身记账（knowledge route 版本由扇出带回）。 */
  private nextLedgerVersion(sourceId: string): number {
    const row = this.db.select({ sourceVersion: ingestEvents.sourceVersion })
      .from(ingestEvents)
      .where(eq(ingestEvents.sourceId, sourceId))
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
      originChannel: dto.originChannel,
    };
  }
}

// ───────────────────────── 归一化：文件字节 ─────────────────────────

/**
 * 识别优先级（§4）：显式声明 > jsonType 结构 > 扩展名注册表 > 嗅探。
 * md 族直通；json 载荷按结构归一化；office/html/csv 走 converters（U2）；
 * 未知/无扩展名嗅探 UTF-8 文本，二进制拒绝 unsupported_type。
 */
async function normalizeFileBytes(
  filename: string,
  buffer: Buffer,
  explicitDataType: string | undefined,
): Promise<{ dataType: string; detectedBy: DetectedBy; title: string; markdown: string; jsonType?: string }> {
  const extension = extensionOf(filename);
  const mdFamily = ["md", "markdown", "txt"];

  if (extension === "json") {
    let payload: unknown;
    try {
      payload = JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      throw new IngestError(`json 解析失败：${(error as Error).message}`, "convert_failed");
    }
    const normalized = normalizeJsonPayload(payload, undefined, titleOfFilename(filename));
    const dataType = explicitDataType ?? normalized.dataType ?? dataTypeOfJsonTypeSafe(normalized.jsonType);
    return {
      dataType,
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

  // U2 转换器：docx/xlsx/pptx/csv/html → md（类型随扩展名注册表）
  const converter = converterOfExtension(extension);
  if (converter) {
    const markdown = await converter(buffer);
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
  const tags = normalizeInsightTags(insights.representativeTags);
  if (tags.length > 0) parts.push(`## 实体与事实\n\n${tags.map((tag) => {
    const value = tag.kind === "fact"
      ? `${tag.subject} ${tag.predicate} ${tag.object}`
      : `${tag.label}（${tag.entityType ?? "other"}）`;
    return `- [${tag.kind}] ${value}${tag.evidence ? `；证据：${tag.evidence}` : ""}`;
  }).join("\n")}`);
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

function dataTypeOfJsonTypeSafe(jsonType: string): string {
  return jsonType === "meeting-minutes" ? "meeting-minutes" : "document";
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
    originChannel: row.originChannel,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
