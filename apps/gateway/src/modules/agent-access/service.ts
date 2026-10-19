import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentAccessEvents,
  agentConnections,
  agentSubmissions,
} from "../../infrastructure/database/schema.js";
import {
  type AgentAccessScopes,
  type AgentConnectionStatus,
  type AgentConnectionView,
  type AgentSubmissionItem,
  type AgentSubmissionItemResult,
  type AgentSubmissionOutcome,
  type ResolvedAgentConnection,
} from "./types.js";

/** 每连接保留的调试事件条数（agent_access_events，PRD 7.5 调试页数据源）。 */
const EVENT_RETENTION_PER_CONNECTION = 200;
/** 单次提交的条目上限（防止一次调用撑爆载荷）。 */
const SUBMISSION_ITEM_LIMIT = 50;
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ArtifactImportOutcome {
  fileEntryId: string;
  contentHash: string;
  filename: string;
}

export interface AgentAccessServiceDeps {
  /**
   * 产物入库入口（filesService.importFileStream 的薄适配，sourceKind=agent-generated）。
   * 独立注入以便测试替换，也让本模块不依赖 files 服务的完整签名。
   */
  importArtifact: (input: {
    filename: string;
    buffer: Buffer;
    roomId: string | null;
    sourceKey: string;
  }) => Promise<ArtifactImportOutcome>;
  log?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

type ConnectionRow = typeof agentConnections.$inferSelect;
type SubmissionRow = typeof agentSubmissions.$inferSelect;

function mintToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `evr_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    tokenPrefix: token.slice(0, 12),
  };
}

function toView(row: ConnectionRow): AgentConnectionView {
  return {
    id: row.id,
    name: row.name,
    tool: row.tool,
    status: row.status,
    scopes: row.scopes as AgentAccessScopes,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    exampleQueryAt: row.exampleQueryAt ? row.exampleQueryAt.toISOString() : null,
  };
}

export class AgentAccessService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly deps: AgentAccessServiceDeps,
  ) {}

  // ---------------------------------------------------------------- connections

  createConnection(input: {
    name: string;
    tool: string;
    scopes: AgentAccessScopes;
  }): { connection: AgentConnectionView; token: string } {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error("agent_access_name_required");
    const { token, tokenHash, tokenPrefix } = mintToken();
    const row: typeof agentConnections.$inferInsert = {
      id: randomUUID(),
      name,
      tool: input.tool as typeof agentConnections.$inferInsert["tool"],
      tokenHash,
      tokenPrefix,
      scopes: input.scopes,
      status: "active",
    };
    this.db.insert(agentConnections).values(row).run();
    const created = this.db.select().from(agentConnections).where(eq(agentConnections.id, row.id!)).get();
    this.deps.log?.("info", "agent_access.connection.created", {
      connectionId: row.id,
      tool: input.tool,
    });
    return { connection: toView(created!), token };
  }

  listConnections(): AgentConnectionView[] {
    return this.db
      .select()
      .from(agentConnections)
      .orderBy(desc(agentConnections.createdAt))
      .all()
      .map(toView);
  }

  getConnection(id: string): AgentConnectionView | null {
    const row = this.db.select().from(agentConnections).where(eq(agentConnections.id, id)).get();
    return row ? toView(row) : null;
  }

  updateConnection(
    id: string,
    patch: { name?: string; scopes?: AgentAccessScopes; status?: Exclude<AgentConnectionStatus, "revoked"> },
  ): AgentConnectionView | null {
    const row = this.db.select().from(agentConnections).where(eq(agentConnections.id, id)).get();
    if (!row || row.status === "revoked") return null;
    const next: Partial<typeof agentConnections.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 80);
      if (!name) throw new Error("agent_access_name_required");
      next.name = name;
    }
    if (patch.scopes !== undefined) next.scopes = patch.scopes;
    if (patch.status !== undefined) next.status = patch.status;
    this.db.update(agentConnections).set(next).where(eq(agentConnections.id, id)).run();
    return this.getConnection(id);
  }

  revokeConnection(id: string): AgentConnectionView | null {
    const row = this.db.select().from(agentConnections).where(eq(agentConnections.id, id)).get();
    if (!row || row.status === "revoked") return null;
    this.db
      .update(agentConnections)
      .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentConnections.id, id))
      .run();
    this.deps.log?.("info", "agent_access.connection.revoked", { connectionId: id });
    return this.getConnection(id);
  }

  rotateToken(id: string): { connection: AgentConnectionView; token: string } | null {
    const row = this.db.select().from(agentConnections).where(eq(agentConnections.id, id)).get();
    if (!row || row.status === "revoked") return null;
    const { token, tokenHash, tokenPrefix } = mintToken();
    this.db
      .update(agentConnections)
      .set({ tokenHash, tokenPrefix, updatedAt: new Date() })
      .where(eq(agentConnections.id, id))
      .run();
    this.deps.log?.("info", "agent_access.connection.token_rotated", { connectionId: id });
    return { connection: this.getConnection(id)!, token };
  }

  /** 安装代写流程校验：桌面端持创建时返回的明文 token 换取安装内容。 */
  verifyTokenMatch(id: string, token: string): boolean {
    const row = this.db.select().from(agentConnections).where(eq(agentConnections.id, id)).get();
    if (!row) return false;
    return row.tokenHash === createHash("sha256").update(token).digest("hex");
  }

  /** MCP 端点鉴权：仅 active 连接放行；顺带刷新 lastSeenAt。 */
  verifyBearer(token: string): ResolvedAgentConnection | null {
    if (!token.startsWith("evr_")) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const row = this.db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.tokenHash, tokenHash))
      .get();
    if (!row || row.status !== "active") return null;
    this.db
      .update(agentConnections)
      .set({ lastSeenAt: new Date() })
      .where(eq(agentConnections.id, row.id))
      .run();
    return {
      id: row.id,
      name: row.name,
      tool: row.tool,
      scopes: row.scopes as AgentAccessScopes,
    };
  }

  markExampleQuery(id: string): void {
    this.db
      .update(agentConnections)
      .set({ exampleQueryAt: new Date() })
      .where(eq(agentConnections.id, id))
      .run();
  }

  // ---------------------------------------------------------------- submissions

  /**
   * 幂等提交（PRD 7.4「重试复用同一提交标识」）：(connectionId, clientSubmissionId)
   * 唯一；重放返回已存结果并累计 duplicateCount。崩溃遗留的 received 行重入处理。
   */
  async submit(
    connection: ResolvedAgentConnection,
    clientSubmissionId: string,
    items: AgentSubmissionItem[],
  ): Promise<AgentSubmissionOutcome> {
    if (!SUBMISSION_ID_PATTERN.test(clientSubmissionId)) {
      throw new Error("agent_access_submission_id_invalid");
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > SUBMISSION_ITEM_LIMIT) {
      throw new Error("agent_access_submission_items_invalid");
    }

    const existing = this.db
      .select()
      .from(agentSubmissions)
      .where(
        and(
          eq(agentSubmissions.connectionId, connection.id),
          eq(agentSubmissions.clientSubmissionId, clientSubmissionId),
        ),
      )
      .get();
    if (existing && existing.status !== "received") {
      this.db
        .update(agentSubmissions)
        .set({ duplicateCount: existing.duplicateCount + 1, updatedAt: new Date() })
        .where(eq(agentSubmissions.id, existing.id))
        .run();
      this.recordEvent(connection.id, "submit", {
        status: "duplicate",
        detail: { clientSubmissionId },
      });
      return {
        submissionId: existing.id,
        clientSubmissionId,
        status: "duplicate",
        results: (existing.results as AgentSubmissionItemResult[] | null) ?? [],
      };
    }
    const rowId = existing?.id ?? randomUUID();
    if (!existing) {
      this.db
        .insert(agentSubmissions)
        .values({
          id: rowId,
          connectionId: connection.id,
          clientSubmissionId,
          items: items as unknown[],
          status: "received",
        })
        .run();
    }

    const results: AgentSubmissionItemResult[] = [];
    for (let index = 0; index < items.length; index += 1) {
      results.push(await this.processItem(connection, rowId, clientSubmissionId, index, items[index]!));
    }
    const hasRejected = results.some((item) => item.status === "rejected");
    this.db
      .update(agentSubmissions)
      .set({
        status: hasRejected ? "partial_failed" : "completed",
        results: results as unknown[],
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentSubmissions.id, rowId))
      .run();
    this.recordEvent(connection.id, "submit", {
      status: hasRejected ? "partial_failed" : "ok",
      detail: { clientSubmissionId, itemCount: items.length },
    });
    return { submissionId: rowId, clientSubmissionId, status: "accepted", results };
  }

  getSubmission(connectionId: string, clientSubmissionId: string): {
    submissionId: string;
    clientSubmissionId: string;
    status: string;
    itemCount: number;
    results: AgentSubmissionItemResult[];
    duplicateCount: number;
    createdAt: string;
  } | null {
    const row = this.db
      .select()
      .from(agentSubmissions)
      .where(
        and(
          eq(agentSubmissions.connectionId, connectionId),
          eq(agentSubmissions.clientSubmissionId, clientSubmissionId),
        ),
      )
      .get();
    return row ? this.toSubmissionView(row) : null;
  }

  listSubmissions(connectionId: string, limit = 50): Array<ReturnType<AgentAccessService["toSubmissionView"]>> {
    return this.db
      .select()
      .from(agentSubmissions)
      .where(eq(agentSubmissions.connectionId, connectionId))
      .orderBy(desc(agentSubmissions.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200))
      .all()
      .map((row) => this.toSubmissionView(row));
  }

  private toSubmissionView(row: SubmissionRow) {
    return {
      submissionId: row.id,
      clientSubmissionId: row.clientSubmissionId,
      status: row.status,
      itemCount: (row.items as unknown[]).length,
      results: (row.results as AgentSubmissionItemResult[] | null) ?? [],
      duplicateCount: row.duplicateCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async processItem(
    connection: ResolvedAgentConnection,
    submissionId: string,
    clientSubmissionId: string,
    index: number,
    item: AgentSubmissionItem,
  ): Promise<AgentSubmissionItemResult> {
    const base = { index, kind: item.kind };
    try {
      if (item.kind === "session_increment") {
        if (!item.platform || !item.threadId || !Array.isArray(item.messages) || item.messages.length === 0) {
          return { ...base, status: "rejected", error: "session_increment_requires_platform_thread_messages" };
        }
        // 载荷整体保存在 agent_submissions.items（含两链合并键：平台/线程/消息 ID+内容）；
        // 并入 external_agent_threads 同步链是阶段 2 集成点（设计文档 §5.4）。
        return {
          ...base,
          status: "recorded",
          objectId: `${submissionId}:${index}`,
          objectType: "session_increment_record",
        };
      }
      if (item.kind === "result_text" || item.kind === "artifact_file") {
        const filename =
          item.kind === "result_text"
            ? `${this.sanitizeFilename(item.title) || "agent-result"}.md`
            : item.filename;
        const buffer =
          item.kind === "result_text"
            ? Buffer.from(item.content, "utf8")
            : Buffer.from(item.contentBase64, "base64");
        const roomId = item.roomId ?? connection.scopes.writebackRoomId ?? null;
        if (item.kind === "artifact_file" && roomId && !this.roomAllowed(connection, roomId)) {
          return { ...base, status: "rejected", error: "room_out_of_scope" };
        }
        const imported = await this.deps.importArtifact({
          filename,
          buffer,
          roomId,
          sourceKey: `agent-sub:${connection.id}:${clientSubmissionId}:${index}`,
        });
        return {
          ...base,
          status: "saved",
          objectId: imported.fileEntryId,
          objectType: "file_entry",
          title: imported.filename,
          deepLink: `everroom://open/file/${imported.fileEntryId}`,
        };
      }
      if (item.kind === "citation") {
        return {
          ...base,
          status: "recorded",
          objectId: `${submissionId}:${index}`,
          objectType: "citation_record",
        };
      }
      // candidate：三路治理（PRD 6.3.6）接入前统一 pending_review 暂存，
      // 不自动写记忆——宁可保守，不可重复污染（发布门槛 G3）。
      const candidate = item as Extract<AgentSubmissionItem, { kind: "candidate" }>;
      if (!candidate.content?.trim()) {
        return { ...base, status: "rejected", error: "candidate_content_required" };
      }
      return {
        ...base,
        status: "pending_review",
        objectId: `${submissionId}:${index}`,
        objectType: `candidate:${candidate.candidateType}`,
        title: candidate.content.slice(0, 80),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, status: "rejected", error: message };
    }
  }

  private roomAllowed(connection: ResolvedAgentConnection, roomId: string): boolean {
    return connection.scopes.roomIds === "all" || connection.scopes.roomIds.includes(roomId);
  }

  private sanitizeFilename(title: string): string {
    return title.replace(/[\\/:*?"<>|\n\r\t]/g, " ").trim().slice(0, 60);
  }

  // ---------------------------------------------------------------- events

  recordEvent(
    connectionId: string,
    kind: "call" | "connect" | "submit",
    fields: { tool?: string | null; status: string; durationMs?: number; detail?: Record<string, unknown> | null },
  ): void {
    this.db
      .insert(agentAccessEvents)
      .values({
        id: randomUUID(),
        connectionId,
        kind,
        tool: fields.tool ?? null,
        status: fields.status,
        durationMs: fields.durationMs ?? null,
        detail: fields.detail ?? null,
      })
      .run();
    // 保留窗口裁剪：删掉本连接第 EVENT_RETENTION_PER_CONNECTION 条之前的旧事件。
    const cutoff = this.db
      .select({ createdAt: agentAccessEvents.createdAt })
      .from(agentAccessEvents)
      .where(eq(agentAccessEvents.connectionId, connectionId))
      .orderBy(desc(agentAccessEvents.createdAt))
      .limit(1)
      .offset(EVENT_RETENTION_PER_CONNECTION)
      .get();
    if (cutoff) {
      this.db
        .delete(agentAccessEvents)
        .where(
          and(
            eq(agentAccessEvents.connectionId, connectionId),
            lt(agentAccessEvents.createdAt, cutoff.createdAt),
          ),
        )
        .run();
    }
  }

  listEvents(connectionId: string, limit = 50): Array<{
    id: string;
    kind: string;
    tool: string | null;
    status: string;
    durationMs: number | null;
    detail: Record<string, unknown> | null;
    createdAt: string;
  }> {
    return this.db
      .select()
      .from(agentAccessEvents)
      .where(eq(agentAccessEvents.connectionId, connectionId))
      .orderBy(desc(agentAccessEvents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200))
      .all()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        tool: row.tool,
        status: row.status,
        durationMs: row.durationMs,
        detail: row.detail ?? null,
        createdAt: row.createdAt.toISOString(),
      }));
  }

  /** 调试页/自检用的提交计数。 */
  countSubmissions(connectionId: string): number {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(agentSubmissions)
      .where(eq(agentSubmissions.connectionId, connectionId))
      .get();
    return row?.count ?? 0;
  }
}
