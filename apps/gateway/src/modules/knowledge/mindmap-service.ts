/**
 * 聚焦思维导图服务（思路板块聚焦模式改造）：聚焦节点由 mindmap-creator
 * subAgent 生成（NotebookLM 式三层导图），不再走召回链路。
 *
 * 生命周期：渲染端 document-open / 进面板 GET → ensure 落 pending 行 →
 * fire-and-forget await orchestrator.dispatch()（HTTP 立即返回）→ 终态落
 * ready/failed → 渲染端 4s 轮询 GET 取 status+projection。
 *
 * 取数在本文件完成；树校验与投影塑形在 mindmap-projection.ts 纯函数。
 * 幂等：已 ready/生成中 no-op；失败由 ensure 重 kick；网关重启后按
 * invocationKey 反查 subagent_invocations 收敛死 processing 行。
 */

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documents,
  focusMindmaps,
  roomDocumentLinks,
  rooms,
  subagentInvocations,
} from "../../infrastructure/database/schema.js";
import { documentBodyContent, tiptapText } from "../documents/content-model.js";
import { agentDocumentMarkdown } from "../documents/agent-markdown.js";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";
import {
  MINDMAP_PROMPT_VERSION,
  mindmapToProjection,
  parseAgentMindmap,
  type MindmapTree,
} from "./mindmap-projection.js";
import type { EmergenceProjectionResult } from "./emergence-projection.js";

export type MindmapScope = "room" | "document";

export const MINDMAP_AGENT_ID = "mindmap-creator";

/** 素材预算：document 级单篇全文 60k；room 级总量 100k、单篇配额 4k~30k。 */
const DOCUMENT_CONTENT_MAX = 60_000;
const ROOM_CONTENT_MAX = 100_000;
const ROOM_DOC_MIN_QUOTA = 4_000;
const ROOM_DOC_MAX_QUOTA = 30_000;
const ROOM_DOC_HARD_LIMIT = 200;

export class MindmapServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "MindmapServiceError";
  }
}

export interface MindmapStatusView {
  roomId: string;
  scope: MindmapScope;
  scopeId: string;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  generatedAt: string | null;
  promptVersion: number | null;
  /** 仅 ready：树映射成的投影（渲染层 G6 聚焦树直接消费）。 */
  projection: EmergenceProjectionResult | null;
  requestVersion: number;
}

interface MindmapLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

type MindmapRow = typeof focusMindmaps.$inferSelect;

/**
 * kick 决策纯函数（对账后调用）：
 * - 无行 → kick（GET 懒生成与 ensure 同口径）；
 * - ready → 仅 force 重生成；
 * - pending/processing（invocation 仍存活）→ no-op；
 * - failed → 仅 ensure 重试（GET 不自动重试，失败态要能被看到）。
 */
export function nextKickAction(input: {
  row: Pick<MindmapRow, "status"> | null;
  force: boolean;
  mode: "get" | "ensure";
}): "noop" | "kick" {
  if (!input.row) return "kick";
  if (input.row.status === "ready") return input.force ? "kick" : "noop";
  if (input.row.status === "failed") return input.mode === "ensure" ? "kick" : "noop";
  return "noop";
}

export class FocusMindmapService {
  /** 同进程内已在跑的生成（防并发 GET/ensure 双派发）。 */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: {
    db: GatewayDatabase;
    orchestrator: SubagentOrchestrator;
    log: MindmapLogger;
  }) {}

  async get(
    roomId: string,
    scope: MindmapScope,
    documentId: string | null,
    requestVersion: number,
  ): Promise<MindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const scopeId = scope === "document" ? this.requireDocument(documentId).id : room.id;
    let row = this.loadRow(scope, scopeId);
    row = this.reconcile(row);
    if (nextKickAction({ row, force: false, mode: "get" }) === "kick") {
      await this.kickGeneration(room, scope, scopeId, null);
      row = this.loadRow(scope, scopeId)!;
    }
    return this.toView(row!, room, requestVersion);
  }

  async ensure(roomId: string, input: {
    scope: MindmapScope;
    documentId: string | null;
    force?: boolean;
    requestVersion: number;
  }): Promise<MindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const scopeId = input.scope === "document" ? this.requireDocument(input.documentId).id : room.id;
    let row = this.loadRow(input.scope, scopeId);
    row = this.reconcile(row);
    if (nextKickAction({ row, force: input.force === true, mode: "ensure" }) === "kick") {
      const documentTitle = input.scope === "document" ? this.loadDocumentTitle(scopeId) : null;
      await this.kickGeneration(room, input.scope, scopeId, documentTitle);
      row = this.loadRow(input.scope, scopeId)!;
    }
    return this.toView(row!, room, input.requestVersion);
  }

  // ───────────────────────── 取数 ─────────────────────────

  private resolveRoom(roomId: string): { id: string; title: string; summary: string | null } {
    let current = roomId.trim();
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = this.deps.db
        .select({ id: rooms.id, title: rooms.title, summary: rooms.summary, lifecycle: rooms.lifecycle, mergedIntoRoomId: rooms.mergedIntoRoomId, deletedAt: rooms.deletedAt })
        .from(rooms)
        .where(eq(rooms.id, current))
        .get();
      if (!row || row.deletedAt) break;
      if (row.lifecycle === "merged" && row.mergedIntoRoomId) {
        current = row.mergedIntoRoomId;
        continue;
      }
      return { id: row.id, title: row.title, summary: row.summary };
    }
    throw new MindmapServiceError("room_not_found", 404);
  }

  /** document 级必须能取到有效文档（空 Room 允许生成失败态，文档缺失是 404）。 */
  private requireDocument(documentId: string | null): { id: string } {
    if (!documentId) throw new MindmapServiceError("document_not_found", 404);
    const row = this.deps.db
      .select({ id: documents.id, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, documentId))
      .get();
    if (!row || row.deletedAt) throw new MindmapServiceError("document_not_found", 404);
    return { id: row.id };
  }

  private loadDocumentTitle(documentId: string): string | null {
    const row = this.deps.db
      .select({ title: documents.title })
      .from(documents)
      .where(eq(documents.id, documentId))
      .get();
    return row?.title ?? null;
  }

  private loadRow(scope: MindmapScope, scopeId: string): MindmapRow | null {
    return this.deps.db
      .select()
      .from(focusMindmaps)
      .where(and(eq(focusMindmaps.scope, scope), eq(focusMindmaps.scopeId, scopeId)))
      .get() ?? null;
  }

  /** 素材拼装：document 级=单篇全文；room 级=未删文档逐篇 `## 标题` 拼 markdown。 */
  private assembleMaterial(scope: MindmapScope, scopeId: string, room: {
    id: string;
    title: string;
    summary: string | null;
  }): { content: string; contentTruncated: boolean; documents: Array<{ documentId: string; title: string; charCount: number }> } | null {
    if (scope === "document") {
      const row = this.deps.db
        .select({ id: documents.id, title: documents.title, contentJson: documents.contentJson })
        .from(documents)
        .where(and(eq(documents.id, scopeId), isNull(documents.deletedAt)))
        .get();
      if (!row) return null;
      const markdown = this.serializeMarkdown(row.contentJson);
      const content = markdown.trim().length > 0 ? `${row.title}\n\n${markdown}` : row.title;
      return {
        content: content.slice(0, DOCUMENT_CONTENT_MAX),
        contentTruncated: content.length > DOCUMENT_CONTENT_MAX,
        documents: [{ documentId: row.id, title: row.title, charCount: content.length }],
      };
    }

    const docRows = this.deps.db
      .select({ id: documents.id, title: documents.title, contentJson: documents.contentJson })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(eq(roomDocumentLinks.roomId, room.id), isNull(documents.deletedAt)))
      .orderBy(desc(documents.updatedAt))
      .limit(ROOM_DOC_HARD_LIMIT)
      .all();
    if (docRows.length === 0) return null;
    const quota = Math.min(ROOM_DOC_MAX_QUOTA, Math.max(ROOM_DOC_MIN_QUOTA, Math.floor(ROOM_CONTENT_MAX / docRows.length)));
    let truncated = false;
    const parts: string[] = [`Room：${room.title}`];
    if (room.summary?.trim()) parts.push(`摘要：${room.summary.trim().slice(0, 500)}`);
    const manifest: Array<{ documentId: string; title: string; charCount: number }> = [];
    for (const row of docRows) {
      const markdown = this.serializeMarkdown(row.contentJson);
      const body = `## ${row.title}\n\n${markdown || "（无正文）"}`;
      const budget = body.length > quota ? (truncated = true, body.slice(0, quota)) : body;
      parts.push(budget);
      manifest.push({ documentId: row.id, title: row.title, charCount: body.length });
    }
    let content = parts.join("\n\n");
    if (content.length > ROOM_CONTENT_MAX) {
      truncated = true;
      content = content.slice(0, ROOM_CONTENT_MAX);
    }
    return { content, contentTruncated: truncated, documents: manifest };
  }

  /** 优先 markdown 序列化（保留标题/列表结构，导图质量更高），失败回退纯文本。 */
  private serializeMarkdown(contentJson: unknown): string {
    const content = contentJson as TiptapJsonContent;
    try {
      return agentDocumentMarkdown.serialize(documentBodyContent(content));
    } catch {
      try {
        return tiptapText(documentBodyContent(content));
      } catch {
        return "";
      }
    }
  }

  // ───────────────────────── 生成与对账 ─────────────────────────

  private async kickGeneration(
    room: { id: string; title: string; summary: string | null },
    scope: MindmapScope,
    scopeId: string,
    documentTitle: string | null,
  ): Promise<void> {
    const material = this.assembleMaterial(scope, scopeId, room);
    const now = new Date();
    if (!material) {
      // 空素材不是内部错误：落 failed 让渲染端显示「没有可整理的内容」。
      this.upsertRow(scope, scopeId, room.id, documentTitle, {
        status: "failed",
        error: "mindmap_no_content",
        tree: null,
        generatedAt: null,
        promptVersion: null,
        invocationKey: null,
        contentHash: null,
        updatedAt: now,
      });
      return;
    }

    const invocationKey = `mindmap:${scope}:${scopeId}:${randomUUID()}`;
    this.upsertRow(scope, scopeId, room.id, documentTitle, {
      status: "processing",
      error: null,
      tree: null,
      generatedAt: null,
      promptVersion: null,
      invocationKey,
      contentHash: createHash("sha256").update(material.content).digest("hex"),
      updatedAt: now,
    });

    const agentInput = {
      task: "mindmap",
      roomId: room.id,
      scope,
      title: scope === "document" ? (documentTitle ?? room.title) : room.title,
      ...(scope === "room" && room.summary?.trim() ? { roomSummary: room.summary.slice(0, 2000) } : {}),
      content: material.content,
      contentTruncated: material.contentTruncated,
      documents: material.documents,
    };

    const flightKey = `${scope}:${scopeId}`;
    if (this.inFlight.has(flightKey)) return;
    this.inFlight.add(flightKey);
    void this.runGeneration(flightKey, scope, scopeId, invocationKey, agentInput);
  }

  private async runGeneration(
    flightKey: string,
    scope: MindmapScope,
    scopeId: string,
    invocationKey: string,
    agentInput: Record<string, unknown>,
  ): Promise<void> {
    try {
      let invocation;
      try {
        invocation = await this.deps.orchestrator.dispatch({
          agentId: MINDMAP_AGENT_ID,
          task: "生成聚焦思维导图",
          input: agentInput,
          idempotencyKey: invocationKey,
          source: "internal_workflow",
          parentSessionId: null,
          parentRunId: null,
        });
      } catch (error) {
        // subagent 未启用/未加载/并发限额：落 failed 由 ensure 重试
        this.markFailed(scope, scopeId, error instanceof Error ? error.message : String(error));
        return;
      }
      if (invocation.status !== "completed" || !invocation.result?.structuredOutput) {
        this.markFailed(scope, scopeId, invocation.errorMessage
          ?? invocation.errorCode
          ?? `mindmap_invocation_${invocation.status}`);
        return;
      }
      let tree: MindmapTree;
      try {
        tree = parseAgentMindmap(invocation.result.structuredOutput);
      } catch (error) {
        this.markFailed(scope, scopeId, `mindmap_parse_failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.deps.db
        .update(focusMindmaps)
        .set({
          status: "ready",
          tree,
          error: null,
          promptVersion: MINDMAP_PROMPT_VERSION,
          generatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(focusMindmaps.scope, scope), eq(focusMindmaps.scopeId, scopeId)))
        .run();
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  /**
   * 网关重启对账：行 processing/pending 时按 invocationKey 反查 subagent_invocations，
   * 调用方进程已丢（dispatch 的 await 随进程消失），invocation 非存活即收敛 failed。
   */
  private reconcile(row: MindmapRow | null): MindmapRow | null {
    if (!row || (row.status !== "pending" && row.status !== "processing") || !row.invocationKey) return row;
    const invocation = this.deps.db
      .select({ status: subagentInvocations.status })
      .from(subagentInvocations)
      .where(and(
        eq(subagentInvocations.source, "internal_workflow"),
        isNull(subagentInvocations.parentRunId),
        eq(subagentInvocations.idempotencyKey, row.invocationKey),
      ))
      .get();
    const alive = invocation?.status === "accepted" || invocation?.status === "running";
    // 存活（本进程在等 / 重启后的孤儿在跑）→ 保留行等终态；孤儿跑完也无人
    // 写 tree，下一次对账时 invocation 已终态，自然收敛 failed 可重试。
    if (alive) return row;
    this.deps.db
      .update(focusMindmaps)
      .set({ status: "failed", error: "mindmap_invocation_lost", updatedAt: new Date() })
      .where(and(eq(focusMindmaps.scope, row.scope), eq(focusMindmaps.scopeId, row.scopeId)))
      .run();
    this.deps.log.warn(
      { event: "knowledge.mindmap.invocation_lost", scope: row.scope, scopeId: row.scopeId, invocationKey: row.invocationKey },
      "focus mindmap invocation lost after restart; row converged to failed",
    );
    return { ...row, status: "failed", error: "mindmap_invocation_lost" };
  }

  private markFailed(scope: MindmapScope, scopeId: string, message: string): void {
    this.deps.db
      .update(focusMindmaps)
      .set({ status: "failed", error: message.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(focusMindmaps.scope, scope), eq(focusMindmaps.scopeId, scopeId)))
      .run();
    this.deps.log.warn(
      { event: "knowledge.mindmap.generation_failed", scope, scopeId, error: message.slice(0, 500) },
      "focus mindmap generation failed",
    );
  }

  private upsertRow(
    scope: MindmapScope,
    scopeId: string,
    roomId: string,
    documentTitle: string | null,
    values: Partial<typeof focusMindmaps.$inferInsert> & { updatedAt: Date },
  ): void {
    const existing = this.loadRow(scope, scopeId);
    if (existing) {
      this.deps.db
        .update(focusMindmaps)
        .set(values)
        .where(and(eq(focusMindmaps.scope, scope), eq(focusMindmaps.scopeId, scopeId)))
        .run();
      return;
    }
    this.deps.db
      .insert(focusMindmaps)
      .values({
        scope,
        scopeId,
        roomId,
        documentTitle,
        status: "pending",
        ...values,
      })
      .onConflictDoNothing()
      .run();
  }

  private toView(row: MindmapRow, room: { id: string; title: string }, requestVersion: number): MindmapStatusView {
    const generatedAt = row.generatedAt instanceof Date ? row.generatedAt.toISOString() : null;
    let projection: EmergenceProjectionResult | null = null;
    if (row.status === "ready" && row.tree) {
      try {
        projection = mindmapToProjection({
          tree: parseAgentMindmap(row.tree),
          scope: row.scope as MindmapScope,
          roomId: room.id,
          roomTitle: room.title,
          documentId: row.scope === "document" ? row.scopeId : null,
          documentTitle: row.documentTitle,
          generatedAt: generatedAt ?? new Date().toISOString(),
          requestVersion,
        });
      } catch {
        // 落库树解析失败（理论不可达，双保险）：按失败态暴露
        this.markFailed(row.scope as MindmapScope, row.scopeId, "mindmap_parse_failed: stored tree invalid");
        return {
          roomId: room.id,
          scope: row.scope as MindmapScope,
          scopeId: row.scopeId,
          status: "failed",
          error: "mindmap_parse_failed",
          generatedAt,
          promptVersion: row.promptVersion,
          projection: null,
          requestVersion,
        };
      }
    }
    return {
      roomId: room.id,
      scope: row.scope as MindmapScope,
      scopeId: row.scopeId,
      status: row.status as MindmapStatusView["status"],
      error: row.error,
      generatedAt,
      promptVersion: row.promptVersion,
      projection,
      requestVersion,
    };
  }
}
