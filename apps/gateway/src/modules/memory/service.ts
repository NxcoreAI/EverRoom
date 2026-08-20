import type { FastifyBaseLogger } from "fastify";
import {
  MemoryCoreClient,
  MemoryCoreError,
  type MemoryAtomicQuery,
  type MemoryConversationQuery,
  type MemoryPipelineStatus,
  type MemoryRuntimeConfig,
} from "@nxcore/agent-runtime-pi";
import { eq } from "drizzle-orm";
import { FilesService } from "../files/service.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentSessions, gatewayMetadata } from "../../infrastructure/database/schema.js";
import { MemoryGatewayError } from "./errors.js";

/** UI 浏览场景的超时：比 agent 注入流程（3s）宽松，但仍在交互可接受范围。 */
const BROWSE_TIMEOUT_MS = 10_000;

/** 渲染层 DTO：L1 原子记忆。 */
export interface MemoryAtomicDto {
  id: string;
  type: string;
  content: string;
  background: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 渲染层 DTO：L0 对话消息。 */
export interface MemoryConversationMessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  sessionId: string | null;
  /** 来源标记：null = 旧数据/未标注；'document' = md 导入的文档会话块。 */
  sourceKind: string | null;
}

export interface DocumentCreationMemoryInput {
  sessionId: string;
  roomId: string;
  documentId: string;
  title: string;
  markdown: string;
}

export interface SelectionRewriteMemoryInput {
  roomId: string;
  documentId: string;
  documentTitle: string;
  instruction: string;
  originalText: string;
  replacementText: string;
}

export interface SourceDocumentMemoryInput {
  sourceId: string;
  sourceKind: string;
  documentId: string;
  title: string;
  markdown: string;
  uri?: string;
  contentHash?: string;
}

export interface MemoryOnboardingInput {
  requestId: string;
  locale: "zh-CN" | "en-US";
  workContext: string;
  currentFocus: string;
  collaborationPreference?: string;
}

export interface MemoryOnboardingResult {
  sessionId: string;
  capturedAt: string;
  accepted: true;
}

interface MemoryOnboardingRecord extends MemoryOnboardingResult {
  status: "pending" | "accepted";
  profileUpdated: boolean;
}

const ONBOARDING_PROFILE_START = "<!-- everroom:onboarding-profile:start -->";
const ONBOARDING_PROFILE_END = "<!-- everroom:onboarding-profile:end -->";
const SCENE_NAVIGATION_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

/** 渲染层 DTO：L2 场景目录项。 */
export interface MemoryScenarioEntryDto {
  path: string;
  summary: string | null;
  isDirectory: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPipelineSessionDto {
  sessionId: string;
  title: string | null;
  latestUserMessage: string | null;
}

/** 渲染层 DTO：单个提炼层的运行状态。 */
export interface MemoryPipelineStageDto {
  queued: number;
  running: number;
  queuedSessions: MemoryPipelineSessionDto[];
  runningSessions: MemoryPipelineSessionDto[];
  idle: boolean;
}

/** 渲染层 DTO：总览。 */
export interface MemoryOverviewDto {
  l1: { total: number; byType: { episodic: number; persona: number; instruction: number } } | null;
  l0: { total: number } | null;
  l2: { total: number } | null;
  l3: { exists: boolean; updatedAt: string | null } | null;
  pipeline: { l1: MemoryPipelineStageDto; l2: MemoryPipelineStageDto; l3: MemoryPipelineStageDto } | null;
}

function toStageDto(
  stage: MemoryPipelineStatus["l1"],
  sessions: Map<string, MemoryPipelineSessionDto>,
): MemoryPipelineStageDto {
  return {
    queued: stage.queued,
    running: stage.running,
    queuedSessions: (stage.queued_sessions ?? []).map((sessionId) => sessions.get(sessionId) ?? {
      sessionId,
      title: null,
      latestUserMessage: null,
    }),
    runningSessions: (stage.running_sessions ?? []).map((sessionId) => sessions.get(sessionId) ?? {
      sessionId,
      title: null,
      latestUserMessage: null,
    }),
    idle: stage.idle,
  };
}

export interface MemoryListOptions {
  type?: MemoryAtomicQuery["type"] | undefined;
  limit: number;
  offset: number;
  timeStart?: string | undefined;
  timeEnd?: string | undefined;
}

export interface MemoryConversationListOptions {
  sessionId?: string | undefined;
  limit: number;
  offset: number;
  timeStart?: string | undefined;
  timeEnd?: string | undefined;
  /** 'conversation' = 仅对话（排除文档会话块）。 */
  sourceKind?: "conversation" | "document" | undefined;
}

/** 渲染层 DTO：导入的文档登记行（MemoryCore documents 表视图）。 */
export interface MemoryDocumentDto {
  id: string;
  title: string;
  /** 调用方资产引用（= EverRoom 知识资产 file id，预览/落盘溯源用）。 */
  callerRef: string;
  version: number;
  sessionId: string;
  chunkCount: number;
  derivedMemoryCount: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 渲染层 DTO：文档分块（含正文与原文行区间，正向溯源预览）。 */
export interface MemoryDocumentChunkDto {
  chunkIndex: number;
  messageId: string;
  headingPath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  recordedAt: string | null;
}

/** 渲染层 DTO：文档派生的 L1 原子（反向溯源入口）。 */
export interface MemoryDocumentMemoryDto {
  id: string;
  type: string;
  content: string;
  background: string | null;
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** 渲染层 DTO：原子记忆溯源锚点。 */
export interface MemoryProvenanceAnchorDto {
  messageId: string;
  role: string;
  content: string;
  recordedAt: string | null;
  sessionId: string | null;
  sourceKind: string;
  headingPath?: string;
  lineStart?: number;
  lineEnd?: number;
  chunkIndex?: number;
}

/** 渲染层 DTO：一站式溯源。 */
export interface MemoryAtomicProvenanceDto {
  memoryId: string;
  type: string;
  content: string;
  kind: string;
  session: { sessionId: string | null; sessionKey: string | null } | null;
  document: {
    documentId: string;
    title: string;
    callerRef: string;
    version: number;
    sessionId: string;
  } | null;
  anchorMessageIds: string[];
  anchors: MemoryProvenanceAnchorDto[];
}

/** md 导入结果（资产化 + MemoryCore 登记双段）。 */
export interface MemoryImportMarkdownResult {
  fileId: string;
  document: MemoryDocumentDto;
  version: string;
  sessionId: string;
  chunkCount: number;
  deduplicated: boolean;
  replacedVersions: number;
  acceptedChunks: number;
}

/** MemoryCore 直导结果（引擎扇出用，无资产段；importMarkdown 的下半段）。 */
export interface MemoryImportDocumentResult {
  document: MemoryDocumentDto;
  version: string;
  sessionId: string;
  chunkCount: number;
  deduplicated: boolean;
  replacedVersions: number;
  acceptedChunks: number;
}

/**
 * MemoryCore 的 gateway 侧门面：注入隔离三元组，把 snake_case 的 v3 响应
 * 映射为稳定的 camelCase DTO；未配置记忆时所有方法抛 memory_disabled。
 */
export class MemoryService {
  private readonly client: MemoryCoreClient | null;
  /** md 导入的资产化通道（modules/files，U9 唯一字节入口）；未配置记忆时为 null。 */
  private readonly files: FilesService | null;
  private readonly db: GatewayDatabase | null;
  private readonly onboardingRequests = new Map<string, Promise<MemoryOnboardingResult>>();

  constructor(
    config: MemoryRuntimeConfig | null,
    private readonly logger: FastifyBaseLogger,
    /** md 导入的资产化落点：gateway 数据库（uploaded_files/parsed_contents）与对象库根。 */
    assets: { db: GatewayDatabase; dataDir: string } | null,
  ) {
    this.client = config ? new MemoryClientWithTimeout(config) : null;
    this.files = assets ? new FilesService(assets.db, assets.dataDir) : null;
    this.db = assets?.db ?? null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async overview(): Promise<MemoryOverviewDto> {
    const client = this.require();
    const [l1All, l1Episodic, l1Persona, l1Instruction, l0, l2, l3, pipeline] = await Promise.allSettled([
      client.countAtomic(),
      client.countAtomic("episodic"),
      client.countAtomic("persona"),
      client.countAtomic("instruction"),
      client.countConversation(),
      client.countScenario(),
      client.readCoreFile(),
      client.pipelineStatus(),
    ]);
    // 总览页允许单路失败：失败的层置 null，前端按"未知"渲染，而不是整页 502。
    const counted = (result: PromiseSettledResult<number>) =>
      result.status === "fulfilled" ? result.value : null;
    const l1Total = counted(l1All);
    const episodic = counted(l1Episodic);
    const persona = counted(l1Persona);
    const instruction = counted(l1Instruction);
    if (l1Total === null && episodic === null && persona === null && instruction === null) {
      // L1 全部探测失败说明 MemoryCore 整体不可用，总览不应假装"未知"。
      this.mapFailure((l1All as PromiseRejectedResult).reason);
    }
    const pipelineSessions = pipeline.status === "fulfilled"
      ? await this.loadPipelineSessions(pipeline.value)
      : new Map<string, MemoryPipelineSessionDto>();

    return {
      l1: {
        total: l1Total ?? (episodic ?? 0) + (persona ?? 0) + (instruction ?? 0),
        byType: {
          episodic: episodic ?? 0,
          persona: persona ?? 0,
          instruction: instruction ?? 0,
        },
      },
      l0: l0.status === "fulfilled" ? { total: l0.value } : null,
      l2: l2.status === "fulfilled" ? { total: l2.value } : null,
      l3: l3.status === "fulfilled"
        ? { exists: l3.value.content != null, updatedAt: l3.value.updated_at || null }
        : null,
      pipeline: pipeline.status === "fulfilled"
        ? {
            l1: toStageDto(pipeline.value.l1, pipelineSessions),
            l2: toStageDto(pipeline.value.l2, pipelineSessions),
            l3: toStageDto(pipeline.value.l3, pipelineSessions),
          }
        : null,
    };
  }

  /** Pipeline status only carries session IDs; resolve a small active subset for the desktop. */
  private async loadPipelineSessions(status: MemoryPipelineStatus): Promise<Map<string, MemoryPipelineSessionDto>> {
    const ids = [...new Set([
      ...(status.l1.queued_sessions ?? []),
      ...(status.l1.running_sessions ?? []),
      ...(status.l2.queued_sessions ?? []),
      ...(status.l2.running_sessions ?? []),
      ...(status.l3.queued_sessions ?? []),
      ...(status.l3.running_sessions ?? []),
    ])].slice(0, 6);
    const resolved = await Promise.all(ids.map(async (sessionId) => {
      const row = this.db
        ?.select({ title: agentSessions.title })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .get();
      let latestUserMessage: string | null = null;
      try {
        const page = await this.call(() => this.require().queryConversation({ sessionId, limit: 20, offset: 0 }));
        const latest = page.messages
          .filter((message) => message.role === "user")
          .slice()
          .sort((left, right) => {
            const leftTime = Date.parse(left.timestamp ?? left.recorded_at ?? "");
            const rightTime = Date.parse(right.timestamp ?? right.recorded_at ?? "");
            return leftTime - rightTime;
          })
          .at(-1);
        latestUserMessage = latest?.content?.trim().slice(0, 180) || null;
      } catch {
        // A pipeline session can disappear between status and conversation read.
      }
      return [sessionId, {
        sessionId,
        title: row?.title?.trim() || null,
        latestUserMessage,
      }] as const;
    }));
    return new Map(resolved);
  }

  async listAtomic(options: MemoryListOptions): Promise<{ items: MemoryAtomicDto[]; total: number }> {
    const client = this.require();
    const page = await this.call(() => client.queryAtomic({
      type: options.type,
      limit: options.limit,
      offset: options.offset,
      timeStart: options.timeStart,
      timeEnd: options.timeEnd,
    }));
    return {
      items: page.items.map((item) => ({
        id: item.id,
        type: item.type,
        content: item.content,
        background: item.background ?? null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      })),
      total: page.total,
    };
  }

  async searchAtomic(query: string, limit: number): Promise<{ items: (MemoryAtomicDto & { score: number })[] }> {
    const client = this.require();
    const items = await this.call(() => client.searchAtomic(query, limit));
    return {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        content: item.content,
        background: item.background ?? null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        score: item.score ?? 0,
      })),
    };
  }

  async updateAtomic(
    id: string,
    content: string,
    background?: string,
  ): Promise<{ id: string; version: number; updatedAt: string }> {
    const client = this.require();
    const result = await this.call(() => client.updateAtomic(id, content, background));
    return { id: result.id, version: result.version, updatedAt: result.updated_at };
  }

  async deleteAtomic(ids: string[]): Promise<{ deletedCount: number }> {
    const client = this.require();
    const result = await this.call(() => client.deleteAtomic(ids));
    return { deletedCount: result.deleted_count };
  }

  async listScenarios(pathPrefix?: string): Promise<{ entries: MemoryScenarioEntryDto[]; total: number }> {
    const client = this.require();
    const entries = await this.call(() => client.listScenarios());
    const filtered = pathPrefix
      ? entries.filter((entry) => entry.path.startsWith(pathPrefix))
      : entries;
    return {
      entries: filtered.map((entry) => ({
        path: entry.path,
        summary: entry.summary ?? null,
        isDirectory: entry.path.endsWith("/"),
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
      })),
      total: filtered.length,
    };
  }

  async readScenario(path: string): Promise<{
    path: string;
    content: string | null;
    version: number;
    updatedAt: string;
  }> {
    const client = this.require();
    const file = await this.call(() => client.readScenario(path));
    return {
      path: file.path,
      content: file.content,
      version: file.version,
      updatedAt: file.updated_at,
    };
  }

  async readCore(): Promise<{ content: string | null; version: number; updatedAt: string }> {
    const client = this.require();
    const file = await this.call(() => client.readCoreFile());
    return { content: file.content, version: file.version, updatedAt: file.updated_at };
  }

  async writeCore(content: string): Promise<{ version: number; updatedAt: string }> {
    const client = this.require();
    const result = await this.call(() => client.writeCore(content));
    return { version: result.version, updatedAt: result.updated_at };
  }

  async listConversations(
    options: MemoryConversationListOptions,
  ): Promise<{ messages: MemoryConversationMessageDto[]; total: number }> {
    const client = this.require();
    const page = await this.call(() => client.queryConversation({
      sessionId: options.sessionId,
      limit: options.limit,
      offset: options.offset,
      timeStart: options.timeStart,
      timeEnd: options.timeEnd,
      sourceKind: options.sourceKind,
    }));
    return {
      messages: page.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestamp ?? null,
        sessionId: message.session_id ?? null,
        sourceKind: message.source_kind ?? null,
      })),
      total: page.total,
    };
  }

  async searchConversations(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<{ messages: (MemoryConversationMessageDto & { score: number })[] }> {
    const client = this.require();
    const messages = await this.call(() => client.searchConversation(query, limit, sessionId));
    return {
      messages: messages.map((message) => ({
        id: message.id ?? "",
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
        timestamp: message.timestamp ?? null,
        sessionId: null,
        sourceKind: message.source_kind ?? null,
        score: message.score ?? 0,
      })),
    };
  }

  async deleteConversations(target: {
    sessionIds?: string[] | undefined;
    messageIds?: string[] | undefined;
  }): Promise<{ deletedCount: number }> {
    const client = this.require();
    const result = await this.call(() => client.deleteConversation(target));
    return { deletedCount: result.deleted_count };
  }

  // ───────────────────────── md 文档导入（资产化 + /v3/document/import） ─────────────────────────

  /**
   * md 一等来源导入（docs/memory-md-source-plan.md §6）：
   * ① 资产化——file-storage 原语落对象库 + uploaded_files/parsed_contents
   *   （与文件上传同一套确定性身份，但不触发 knowledge 的 wiki 路由）；
   * ② 代理 MemoryCore /v3/document/import，caller_ref = file id。
   * 原文字节只落资产层；MemoryCore 仅存 caller_ref 与内容指纹。
   */
  async importMarkdown(input: {
    title: string;
    markdown: string;
    filename?: string | undefined;
  }): Promise<MemoryImportMarkdownResult> {
    const client = this.require();
    const files = this.requireAssets();

    const filename = input.filename?.trim() || `${input.title.trim()}.md`;
    const buffer = Buffer.from(input.markdown, "utf8");

    // 资产段经 modules/files（U9）：闸1 同名同内容 deduped 跳过；同名新内容
    // 版本更新。此处与知识上传共用同一套确定性身份与对象库。
    const uploaded = await files.upload({ filename, buffer });
    if (!uploaded.deduped) {
      const parsedId = files.ensureParsed(uploaded.contentHash, input.markdown);
      files.touchParsed(uploaded.fileId, parsedId);
    }
    const fileId = uploaded.fileId;

    const result = await this.call(() => client.importDocument({
      title: input.title.trim(),
      markdown: input.markdown,
      callerRef: fileId,
    }));
    return {
      fileId,
      document: this.toDocumentDto(result.document),
      version: result.version,
      sessionId: result.session_id,
      chunkCount: result.chunk_count,
      deduplicated: result.deduplicated,
      replacedVersions: result.replaced_versions,
      acceptedChunks: result.accepted_chunks,
    };
  }

  async listDocuments(
    limit = 50,
    offset = 0,
  ): Promise<{ documents: MemoryDocumentDto[]; total: number }> {
    const client = this.require();
    const page = await this.call(() => client.listDocuments({ limit, offset }));
    return {
      documents: page.documents.map((item) => this.toDocumentDto(item)),
      total: page.total,
    };
  }

  async getDocument(documentId: string): Promise<{
    document: MemoryDocumentDto;
    chunks: MemoryDocumentChunkDto[];
    memories: MemoryDocumentMemoryDto[];
  }> {
    const client = this.require();
    const detail = await this.call(() => client.getDocument(documentId));
    return {
      document: this.toDocumentDto(detail.document),
      chunks: detail.chunks.map((chunk) => ({
        chunkIndex: chunk.chunk_index,
        messageId: chunk.message_id,
        headingPath: chunk.heading_path,
        lineStart: chunk.line_start,
        lineEnd: chunk.line_end,
        content: chunk.content,
        recordedAt: chunk.recorded_at ?? null,
      })),
      memories: detail.memories.map((memory) => ({
        id: memory.id,
        type: memory.type,
        content: memory.content,
        background: memory.background ?? null,
        sourceMessageIds: memory.source_message_ids ?? [],
        createdAt: memory.created_at ?? "",
        updatedAt: memory.updated_at ?? "",
      })),
    };
  }

  async deleteDocument(documentId: string): Promise<{ documentId: string; deleted: boolean }> {
    const client = this.require();
    const result = await this.call(() => client.deleteDocument(documentId));
    return { documentId: result.document_id, deleted: true };
  }

  async atomicProvenance(memoryId: string): Promise<MemoryAtomicProvenanceDto> {
    const client = this.require();
    const provenance = await this.call(() => client.atomicProvenance(memoryId));
    return {
      memoryId: provenance.memory_id,
      type: provenance.type,
      content: provenance.content,
      kind: provenance.kind,
      session: provenance.session
        ? {
          sessionId: provenance.session.session_id ?? null,
          sessionKey: provenance.session.session_key ?? null,
        }
        : null,
      document: provenance.document
        ? {
          documentId: provenance.document.document_id,
          title: provenance.document.title,
          callerRef: provenance.document.caller_ref,
          version: provenance.document.version,
          sessionId: provenance.document.session_id,
        }
        : null,
      anchorMessageIds: provenance.anchor_message_ids,
      anchors: provenance.anchors.map((anchor) => ({
        messageId: anchor.message_id,
        role: anchor.role,
        content: anchor.content,
        recordedAt: anchor.recorded_at ?? null,
        sessionId: anchor.session_id ?? null,
        sourceKind: anchor.source_kind,
        ...(anchor.heading_path !== undefined ? { headingPath: anchor.heading_path } : {}),
        ...(anchor.line_start !== undefined ? { lineStart: anchor.line_start } : {}),
        ...(anchor.line_end !== undefined ? { lineEnd: anchor.line_end } : {}),
        ...(anchor.chunk_index !== undefined ? { chunkIndex: anchor.chunk_index } : {}),
      })),
    };
  }

  /**
   * 记忆导入下半段（unified-ingest-plan §7）：不经资产化直调 MemoryCore
   * ——理解引擎扇出用（原文归 files 模块管，引擎只传 callerRef + 内容）。
   * markdown 由调用方（引擎）按 2MB 消费端上限截断后再传入。
   */
  async importToMemoryCore(input: {
    title: string;
    markdown: string;
    callerRef: string;
  }): Promise<MemoryImportDocumentResult> {
    const client = this.require();
    const result = await this.call(() => client.importDocument({
      title: input.title.trim(),
      markdown: input.markdown,
      callerRef: input.callerRef,
    }));
    return {
      document: this.toDocumentDto(result.document),
      version: result.version,
      sessionId: result.session_id,
      chunkCount: result.chunk_count,
      deduplicated: result.deduplicated,
      replacedVersions: result.replaced_versions,
      acceptedChunks: result.accepted_chunks,
    };
  }

  /**
   * 文件删除级联（modules/files 调用）：按 caller_ref 反查并删除 MemoryCore
   * 文档（级联清 L0 会话/分块/派生 L1）。MemoryCore 未启用返回空列表。
   */
  async deleteDocumentsByCallerRef(callerRef: string): Promise<string[]> {
    if (!this.client || !this.enabled) return [];
    const client = this.client;
    const deleted: string[] = [];
    // listDocuments 按身份键取最新版本：分页扫全量，caller_ref 命中即删
    for (let offset = 0; ; offset += 100) {
      const page = await this.call(() => client.listDocuments({ limit: 100, offset }));
      for (const item of page.documents) {
        if (item.caller_ref !== callerRef) continue;
        await this.call(() => client.deleteDocument(item.document_id));
        deleted.push(item.document_id);
      }
      if (offset + 100 >= page.total) break;
    }
    return deleted;
  }

  /** 解析产物幂等入库（闸2）已移交 modules/files——资产原语不再本地实现。 */
  private toDocumentDto(item: {
    document_id: string;
    title: string;
    caller_ref: string;
    version: number;
    session_id: string;
    chunk_count: number;
    created_at: string;
    updated_at: string;
    derived_memory_count?: number;
  }): MemoryDocumentDto {
    return {
      id: item.document_id,
      title: item.title,
      callerRef: item.caller_ref,
      version: item.version,
      sessionId: item.session_id,
      chunkCount: item.chunk_count,
      derivedMemoryCount: item.derived_memory_count ?? null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    };
  }

  /** 解析产物幂等入库（闸2）已移交 modules/files（U9）——资产原语不再本地实现。 */

  private requireAssets(): FilesService {
    if (!this.files) {
      throw new MemoryGatewayError(
        "memory_disabled",
        "memory document assets are not available on this gateway",
        503,
      );
    }
    return this.files;
  }

  async captureDocumentCreation(input: DocumentCreationMemoryInput): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const timestamp = new Date().toISOString();
    await this.call(() => client.addConversation(input.sessionId, [
      {
        role: "user",
        content: `[document:create] 在 Context Room ${input.roomId} 中创建文档。`,
        timestamp,
      },
      {
        role: "assistant",
        // 正文由统一 ingest 以文档来源导入；对话只保留操作事实，避免全文双写。
        content: `[document:${input.documentId}] 已创建文档《${input.title}》。`,
        timestamp,
      },
    ]));
    return true;
  }

  async captureSelectionRewrite(input: SelectionRewriteMemoryInput): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const timestamp = new Date().toISOString();
    await this.call(() => client.addConversation(`document:${input.documentId}`, [
      {
        role: "user",
        content: [
          `[document:rewrite] 文档《${input.documentTitle}》（Room ${input.roomId}）选区重写。`,
          `改写要求：${input.instruction}`,
          "原文：",
          input.originalText,
        ].join("\n"),
        timestamp,
      },
      {
        role: "assistant",
        content: ["已接受并应用以下改写结果：", input.replacementText].join("\n"),
        timestamp,
      },
    ]));
    return true;
  }

  async captureSourceDocument(input: SourceDocumentMemoryInput): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const timestamp = new Date().toISOString();
    const sessionId = `wiki:${input.sourceId}:${input.documentId}`.slice(0, 100);
    const metadata = [
      `[wiki:source=${input.sourceKind}]`,
      `[wiki:document=${input.documentId}]`,
      input.uri ? `[wiki:url=${input.uri}]` : '',
      input.contentHash ? `[wiki:sha256=${input.contentHash}]` : '',
    ].filter(Boolean).join(' ');
    await this.call(() => client.addConversation(sessionId, [
      { role: "user", content: `[wiki:sync] 请将以下 Markdown 文档作为可检索知识保存。\n${metadata}\n标题：${input.title}`, timestamp },
      { role: "assistant", content: input.markdown, timestamp },
    ]));
    return true;
  }

  /**
   * 首次记忆引导不经过 Agent runtime，确保 Fake Agent 模式也能把回答交给
   * MemoryCore。requestId 同时决定固定 session，并在 gateway_metadata 中持久判重。
   */
  async captureOnboarding(input: MemoryOnboardingInput): Promise<MemoryOnboardingResult> {
    this.require();
    if (!input.workContext.trim() || !input.currentFocus.trim()) {
      throw new MemoryGatewayError(
        "memory_error",
        "workContext and currentFocus must contain non-whitespace text",
        400,
      );
    }
    const existing = this.readOnboardingRecord(input.requestId);
    if (existing?.status === "accepted" && existing.profileUpdated) {
      return this.toOnboardingResult(existing);
    }

    const running = this.onboardingRequests.get(input.requestId);
    if (running) return running;

    const operation = this.performOnboardingCapture(input, existing).finally(() => {
      this.onboardingRequests.delete(input.requestId);
    });
    this.onboardingRequests.set(input.requestId, operation);
    return operation;
  }

  private async performOnboardingCapture(
    input: MemoryOnboardingInput,
    existing: MemoryOnboardingRecord | null,
  ): Promise<MemoryOnboardingResult> {
    const client = this.require();
    const sessionId = `onboarding:${input.requestId}`;
    const capturedAt = existing?.capturedAt ?? new Date().toISOString();
    const pending: MemoryOnboardingRecord = {
      sessionId,
      capturedAt,
      accepted: true,
      status: "pending",
      profileUpdated: existing?.profileUpdated ?? false,
    };
    this.writeOnboardingRecord(input.requestId, pending);

    // 旧版本已完成 L0 写入但尚未同步画像时，只补齐 L3，不重复追加对话。
    if (existing?.status === "accepted") {
      await this.updateOnboardingProfile(input, capturedAt);
      const accepted = { ...pending, status: "accepted" as const, profileUpdated: true };
      this.writeOnboardingRecord(input.requestId, accepted);
      return this.toOnboardingResult(accepted);
    }

    // 上次可能已写入 MemoryCore、但尚未来得及把本地状态改成 accepted。
    // 固定 session 下发现消息即可完成本地恢复，不再次追加同一轮对话。
    if (existing?.status === "pending") {
      const page = await this.call(() => client.queryConversation({
        sessionId,
        limit: 1,
        offset: 0,
      }));
      if (page.total > 0 || page.messages.length > 0) {
        await this.updateOnboardingProfile(input, capturedAt);
        const accepted = { ...pending, status: "accepted" as const, profileUpdated: true };
        this.writeOnboardingRecord(input.requestId, accepted);
        return this.toOnboardingResult(accepted);
      }
    }

    await this.call(() => client.addConversation(
      sessionId,
      this.onboardingMessages(input, capturedAt),
    ));
    await this.updateOnboardingProfile(input, capturedAt);

    const accepted = { ...pending, status: "accepted" as const, profileUpdated: true };
    this.writeOnboardingRecord(input.requestId, accepted);
    return this.toOnboardingResult(accepted);
  }

  private async updateOnboardingProfile(
    input: MemoryOnboardingInput,
    capturedAt: string,
  ): Promise<void> {
    const client = this.require();
    const current = await this.call(() => client.readCoreFile());
    const block = this.onboardingProfileBlock(input, capturedAt);
    const content = this.mergeOnboardingProfile(current.content ?? "", block);
    await this.call(() => client.writeCore(content));
  }

  private onboardingProfileBlock(input: MemoryOnboardingInput, capturedAt: string): string {
    const quote = (value: string) => value
      .trim()
      .replaceAll("<!--", "&lt;!--")
      .replaceAll("-->", "--&gt;")
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    const preference = input.collaborationPreference?.trim();
    if (input.locale === "en-US") {
      return [
        ONBOARDING_PROFILE_START,
        "## Initial collaboration profile",
        "### Main work",
        quote(input.workContext),
        "### Current focus",
        quote(input.currentFocus),
        ...(preference ? ["### Collaboration preference", quote(preference)] : []),
        `_Captured during first setup at ${capturedAt}_`,
        ONBOARDING_PROFILE_END,
      ].join("\n\n");
    }
    return [
      ONBOARDING_PROFILE_START,
      "## 首次协作画像",
      "### 主要工作",
      quote(input.workContext),
      "### 当前重点",
      quote(input.currentFocus),
      ...(preference ? ["### 协作偏好", quote(preference)] : []),
      `_首次设置记录于 ${capturedAt}_`,
      ONBOARDING_PROFILE_END,
    ].join("\n\n");
  }

  private mergeOnboardingProfile(current: string, block: string): string {
    const start = current.indexOf(ONBOARDING_PROFILE_START);
    const end = start >= 0 ? current.indexOf(ONBOARDING_PROFILE_END, start) : -1;
    if (start >= 0 && end >= 0) {
      const after = end + ONBOARDING_PROFILE_END.length;
      return `${current.slice(0, start).trimEnd()}\n\n${block}\n\n${current.slice(after).trimStart()}`.trim();
    }
    const navigationStart = current.indexOf(SCENE_NAVIGATION_HEADER);
    if (navigationStart >= 0) {
      return [
        current.slice(0, navigationStart).trim(),
        block,
        current.slice(navigationStart).trim(),
      ].filter(Boolean).join("\n\n");
    }
    return [current.trim(), block].filter(Boolean).join("\n\n");
  }

  private onboardingMessages(
    input: MemoryOnboardingInput,
    timestamp: string,
  ): Array<{ role: "user" | "assistant"; content: string; timestamp: string }> {
    const preference = input.collaborationPreference?.trim();
    if (input.locale === "en-US") {
      return [
        {
          role: "user",
          content: [
            "[everroom:onboarding] This is my first memory setup. Extract the information I directly provided below into durable atomic memories.",
            `My main work: ${input.workContext.trim()}`,
            `My current focus: ${input.currentFocus.trim()}`,
            ...(preference ? [`How I want the Agent to collaborate with me: ${preference}`] : []),
          ].join("\n"),
          timestamp,
        },
        {
          role: "assistant",
          content: "[everroom:onboarding:accepted] I have read your answers and will retain your work context, current focus, and any collaboration preference as long-term working memory.",
          timestamp,
        },
      ];
    }
    return [
      {
        role: "user",
        content: [
          "[everroom:onboarding] 这是我的首次记忆设置。请将以下由我直接提供的信息提炼为长期原子记忆。",
          `我的主要工作：${input.workContext.trim()}`,
          `我当前最想推进：${input.currentFocus.trim()}`,
          ...(preference ? [`我希望 Agent 这样与我协作：${preference}`] : []),
        ].join("\n"),
        timestamp,
      },
      {
        role: "assistant",
        content: "[everroom:onboarding:accepted] 我已读取这些回答，并会将你的工作背景、当前重点和已填写的协作偏好作为长期协作记忆。",
        timestamp,
      },
    ];
  }

  private onboardingMetadataKey(requestId: string): string {
    return `memory.onboarding.v1:${requestId}`;
  }

  private readOnboardingRecord(requestId: string): MemoryOnboardingRecord | null {
    if (!this.db) return null;
    const row = this.db.select({ value: gatewayMetadata.value }).from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, this.onboardingMetadataKey(requestId))).get();
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as Partial<MemoryOnboardingRecord>;
      if ((value.status !== "pending" && value.status !== "accepted")
        || typeof value.sessionId !== "string"
        || typeof value.capturedAt !== "string") return null;
      return {
        status: value.status,
        sessionId: value.sessionId,
        capturedAt: value.capturedAt,
        accepted: true,
        profileUpdated: value.profileUpdated === true,
      };
    } catch {
      return null;
    }
  }

  private writeOnboardingRecord(requestId: string, record: MemoryOnboardingRecord): void {
    if (!this.db) return;
    const updatedAt = new Date();
    this.db.insert(gatewayMetadata).values({
      key: this.onboardingMetadataKey(requestId),
      value: JSON.stringify(record),
      updatedAt,
    }).onConflictDoUpdate({
      target: gatewayMetadata.key,
      set: { value: JSON.stringify(record), updatedAt },
    }).run();
  }

  private toOnboardingResult(record: MemoryOnboardingRecord): MemoryOnboardingResult {
    return {
      sessionId: record.sessionId,
      capturedAt: record.capturedAt,
      accepted: true,
    };
  }

  private require(): MemoryCoreClient {
    if (!this.client) {
      throw new MemoryGatewayError(
        "memory_disabled",
        "MemoryCore is not enabled on this gateway (NXCORE_MEMORY_ENABLED)",
        503,
      );
    }
    return this.client;
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MemoryGatewayError) throw error;
      if (error instanceof MemoryCoreError) {
        this.logger.warn({ err: error }, "memory core request failed");
        if (error.kind === "unreachable") {
          throw new MemoryGatewayError(
            "memory_unreachable",
            `MemoryCore is unreachable: ${error.message}`,
            502,
          );
        }
        throw new MemoryGatewayError("memory_error", error.message, 502);
      }
      throw error;
    }
  }

  private mapFailure(reason: unknown): never {
    if (reason instanceof MemoryCoreError) {
      if (reason.kind === "unreachable") {
        throw new MemoryGatewayError("memory_unreachable", `MemoryCore is unreachable: ${reason.message}`, 502);
      }
      throw new MemoryGatewayError("memory_error", reason.message, 502);
    }
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

/** 仅为注入浏览超时的构造包装。 */
class MemoryClientWithTimeout extends MemoryCoreClient {
  constructor(config: MemoryRuntimeConfig) {
    super({ ...config, timeoutMs: BROWSE_TIMEOUT_MS });
  }
}
