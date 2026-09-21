/**
 * 写作路线导图服务（聚焦改版 2026-09）：新文档创建时由 route-planner
 * subAgent 逐层生成路线选项，用户点选深入/回退，拍板后派 doc-writer 写正文。
 *
 * 生命周期：渲染端/对话链路 POST start → 落 expanding 行 → fire-and-forget
 * await orchestrator.dispatch()（HTTP 立即返回）→ 终态落 active/failed。
 * expand=选中+无子级续生一层；back=截断 selectionPath（全图保留）；
 * finalize=锁 finalized → doc-writer draft-create → syncExternalMarkdown 落库。
 *
 * 幂等：expanding 中再动=409；失败由 start 重试（expand 失败保图重派）；
 * 网关重启后按 generationKey/writingKey 反查 subagent_invocations 收敛死行。
 *
 * 树操作与素材文本化在 route-mindmap-graph.ts 纯函数；本文件取数与编排。
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documents,
  roomDocumentLinks,
  rooms,
  routeMindmaps,
  subagentInvocations,
} from "../../infrastructure/database/schema.js";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";
import { DOC_WRITER_AGENT_ID } from "../subagents/doc-writer-dispatcher.js";
import type { ProjectionGraph } from "./emergence-projection.js";
import {
  ROUTE_MAX_DEPTH,
  ROUTE_PROMPT_VERSION,
  ROUTE_ROOT_REF,
  attachChildren,
  findNode,
  labelsOfPath,
  materializeGraphMaterial,
  parseRouteOptions,
  pathTo,
  routeContentHash,
  type RouteGraph,
  type RouteNode,
} from "./route-mindmap-graph.js";

export const ROUTE_PLANNER_AGENT_ID = "route-planner";

export class RouteMindmapServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "RouteMindmapServiceError";
  }
}

export type RouteMindmapStatus = "missing" | "expanding" | "active" | "failed" | "finalized";

export interface RouteMindmapStatusView {
  roomId: string;
  documentId: string;
  title: string;
  description: string | null;
  status: RouteMindmapStatus;
  skipped: boolean;
  writing: boolean;
  error: string | null;
  /** expanding 时正在续生的节点；null=初始层生成中或非生成态。 */
  expandingNodeRef: string | null;
  /** 全图（含未选分支与回退历史），未生成过为 null；展示层按 selectionPath 过滤。 */
  graph: RouteGraph | null;
  /** 当前已选路径（nodeRef 数组，含根到当前节点）。 */
  selectionPath: string[] | null;
  finalizedAt: string | null;
  generatedAt: string | null;
  promptVersion: number | null;
  requestVersion: number;
}

interface RouteMindmapLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

type RouteRow = typeof routeMindmaps.$inferSelect;

/** 生成中（expanding）或写正文（writing）需要重启对账的行。 */
function needsReconcile(row: RouteRow): boolean {
  return row.status === "expanding" || row.writing === true;
}

export class RouteMindmapService {
  /** 同进程内已在跑的派发（防并发双派发；expand/finalize 进行中再动=409）。 */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: {
    db: GatewayDatabase;
    orchestrator: SubagentOrchestrator;
    /** EmergenceService.buildGraph（三图谱素材源）。 */
    emergence: { buildGraph(roomId: string, roomTitle: string): Promise<ProjectionGraph> };
    /** DocumentService.syncExternalMarkdown（拍板写正文落库）。 */
    documents: {
      syncExternalMarkdown(input: { documentId: string; roomId: string; title: string; markdown: string }): Promise<unknown>;
    };
    log: RouteMindmapLogger;
  }) {}

  // ───────────────────────── 读 ─────────────────────────

  async get(roomId: string, documentId: string, requestVersion: number): Promise<RouteMindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const document = this.requireDocument(room.id, documentId);
    const row = this.reconcile(this.loadRow(document.id));
    return this.toView(row, room.id, document, requestVersion);
  }

  // ───────────────────────── 动作 ─────────────────────────

  /** 创建时触发（渲染端两入口 + 对话链路空正文 commit 钩子）；幂等。 */
  async start(roomId: string, input: {
    documentId: string;
    title?: string;
    description?: string | null;
    requestVersion: number;
  }): Promise<RouteMindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const document = this.requireDocument(room.id, input.documentId);
    const title = (input.title ?? document.title).trim().slice(0, 120);
    if (!title) throw new RouteMindmapServiceError("invalid_title", 400);

    const row = this.reconcile(this.loadRow(document.id));
    if (!row) {
      const inserted = this.insertRow(room.id, document.id, title, input.description ?? null);
      void this.kickInitial(inserted, room.title);
    } else if (row.status === "failed") {
      // 重试：expand 失败保图重派那一层；初始失败从头生成。
      if (row.graph && row.expandingNodeRef) {
        void this.retryExpansion(row, room.title);
      } else {
        this.updateRow(document.id, {
          status: "expanding",
          title,
          description: input.description ?? row.description,
          updatedAt: new Date(),
        });
        void this.kickInitial(this.loadRow(document.id)!, room.title);
      }
    } else if (row.skipped === true) {
      if (row.graph) {
        this.updateRow(document.id, { skipped: false, updatedAt: new Date() });
      } else {
        this.updateRow(document.id, {
          skipped: false,
          status: "expanding",
          title,
          description: input.description ?? row.description,
          updatedAt: new Date(),
        });
        void this.kickInitial(this.loadRow(document.id)!, room.title);
      }
    }
    // expanding/active/finalized：no-op（幂等）。
    return this.toView(this.loadRow(document.id), room.id, document, input.requestVersion);
  }

  /** 点子节点：选中；无子级则续生一层（全图最多四层，末梢层节点不再续生）。expanding/finalized 中=409。 */
  async expand(roomId: string, input: {
    documentId: string;
    nodeRef: string;
    requestVersion: number;
  }): Promise<RouteMindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const document = this.requireDocument(room.id, input.documentId);
    const row = this.requireMutableRow(document.id);
    const graph = this.requireGraph(row);
    const node = findNode(graph.root, input.nodeRef);
    if (!node) throw new RouteMindmapServiceError("route_node_not_found", 404);
    const path = pathTo(graph.root, input.nodeRef)!;

    if (node.children && node.children.length > 0) {
      // 已有子级（换路/续走）：只更新 selectionPath，记录的选项重新露出。
      this.updateRow(document.id, { selectionPath: path, skipped: false, updatedAt: new Date() });
      return this.toView(this.loadRow(document.id), room.id, document, input.requestVersion);
    }

    // 深度上限：目标是第四层（path 含根共四段）时其子层越界，不再派发（旧图更深的已生成层不受影响）。
    if (path.length >= ROUTE_MAX_DEPTH) throw new RouteMindmapServiceError("route_depth_limit", 409);

    if (this.inFlight.has(document.id)) throw new RouteMindmapServiceError("route_busy", 409);
    const generationKey = `route:${document.id}:expand:${randomUUID()}`;
    this.updateRow(document.id, {
      selectionPath: path,
      skipped: false,
      status: "expanding",
      expandingNodeRef: node.ref,
      error: null,
      generationKey,
      updatedAt: new Date(),
    });
    const fresh = this.loadRow(document.id)!;
    void this.withInFlight(document.id, () => this.runExpansion(fresh, generationKey, node, room.title));
    return this.toView(this.loadRow(document.id), room.id, document, input.requestVersion);
  }

  /** 点路径上级：selectionPath 截断到该层；下层已生成选项保留可换路。生成中（expanding）也放行——回退是纯本地操作，与在飞的续生互不干扰。 */
  async back(roomId: string, input: {
    documentId: string;
    toDepth: number;
    requestVersion: number;
  }): Promise<RouteMindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const document = this.requireDocument(room.id, input.documentId);
    const row = this.reconcile(this.loadRow(document.id));
    if (!row) throw new RouteMindmapServiceError("route_not_generated", 409);
    if (row.status === "finalized") throw new RouteMindmapServiceError("route_finalized", 409);
    if (row.status === "failed") throw new RouteMindmapServiceError("route_failed_retry_start", 409);
    if (!row.selectionPath || row.selectionPath.length === 0) {
      throw new RouteMindmapServiceError("route_path_missing", 409);
    }
    const depth = Math.max(0, Math.min(input.toDepth, row.selectionPath.length - 1));
    this.updateRow(document.id, { selectionPath: row.selectionPath.slice(0, depth + 1), updatedAt: new Date() });
    return this.toView(this.loadRow(document.id), room.id, document, input.requestVersion);
  }

  /** 跳过整套流程：不自动生成（有图照常展示，仅不再自动推进）。 */
  async skip(roomId: string, input: { documentId: string; requestVersion: number }): Promise<RouteMindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const document = this.requireDocument(room.id, input.documentId);
    const row = this.loadRow(document.id);
    if (!row) {
      this.insertSkippedRow(room.id, document.id, document.title);
    } else {
      this.updateRow(document.id, { skipped: true, updatedAt: new Date() });
    }
    return this.toView(this.loadRow(document.id), room.id, document, input.requestVersion);
  }

  /**
   * 拍板「就按这条路写」：锁 finalized → doc-writer 照已选路线写正文 →
   * syncExternalMarkdown 落库。finalized+error 的行允许重试（再次派发）。
   */
  async finalize(roomId: string, input: { documentId: string; requestVersion: number }): Promise<RouteMindmapStatusView> {
    const room = this.resolveRoom(roomId);
    const document = this.requireDocument(room.id, input.documentId);
    const row = this.reconcile(this.loadRow(document.id));
    if (!row || !row.graph) throw new RouteMindmapServiceError("route_not_generated", 409);
    const retryable = row.status === "finalized" && row.error !== null && row.writing !== true;
    if (row.status !== "active" && !retryable) throw new RouteMindmapServiceError("route_not_finalizable", 409);
    if (!row.selectionPath || row.selectionPath.length < 2) {
      throw new RouteMindmapServiceError("route_path_empty", 409);
    }
    if (this.inFlight.has(document.id)) throw new RouteMindmapServiceError("route_busy", 409);

    const writingKey = `route:${document.id}:write:${randomUUID()}`;
    this.updateRow(document.id, {
      status: "finalized",
      writing: true,
      writingKey,
      error: null,
      finalizedAt: row.finalizedAt ?? new Date(),
      updatedAt: new Date(),
    });
    const fresh = this.loadRow(document.id)!;
    void this.withInFlight(document.id, () => this.runWriting(fresh, writingKey, room.title));
    return this.toView(this.loadRow(document.id), room.id, document, input.requestVersion);
  }

  // ───────────────────────── 取数 ─────────────────────────

  private resolveRoom(roomId: string): { id: string; title: string } {
    let current = roomId.trim();
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = this.deps.db
        .select({ id: rooms.id, title: rooms.title, lifecycle: rooms.lifecycle, mergedIntoRoomId: rooms.mergedIntoRoomId, deletedAt: rooms.deletedAt })
        .from(rooms)
        .where(eq(rooms.id, current))
        .get();
      if (!row || row.deletedAt) break;
      if (row.lifecycle === "merged" && row.mergedIntoRoomId) {
        current = row.mergedIntoRoomId;
        continue;
      }
      return { id: row.id, title: row.title };
    }
    throw new RouteMindmapServiceError("room_not_found", 404);
  }

  /** 文档须经 room_doc_links 归属到该 Room；不存在 404，未挂到本 Room 409。 */
  private requireDocument(roomId: string, documentId: string): { id: string; title: string } {
    const row = this.deps.db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(eq(documents.id, documentId), eq(roomDocumentLinks.roomId, roomId), isNull(documents.deletedAt)))
      .get();
    if (row) return row;
    const doc = this.deps.db
      .select({ deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, documentId))
      .get();
    if (!doc || doc.deletedAt) throw new RouteMindmapServiceError("document_not_found", 404);
    throw new RouteMindmapServiceError("document_room_mismatch", 409);
  }

  private loadRow(documentId: string): RouteRow | null {
    return this.deps.db
      .select()
      .from(routeMindmaps)
      .where(eq(routeMindmaps.documentId, documentId))
      .get() ?? null;
  }

  /** expand 要求行存在且不在生成/拍板态。 */
  private requireMutableRow(documentId: string): RouteRow {
    const row = this.reconcile(this.loadRow(documentId));
    if (!row) throw new RouteMindmapServiceError("route_not_generated", 409);
    if (row.status === "finalized") throw new RouteMindmapServiceError("route_finalized", 409);
    if (row.status === "expanding") throw new RouteMindmapServiceError("route_busy", 409);
    if (row.status === "failed") throw new RouteMindmapServiceError("route_failed_retry_start", 409);
    return row;
  }

  private requireGraph(row: RouteRow): RouteGraph {
    if (!row.graph) throw new RouteMindmapServiceError("route_not_generated", 409);
    return row.graph as RouteGraph;
  }

  private insertRow(roomId: string, documentId: string, title: string, description: string | null): RouteRow {
    this.deps.db
      .insert(routeMindmaps)
      .values({
        documentId,
        roomId,
        title,
        description,
        status: "expanding",
        selectionPath: [ROUTE_ROOT_REF],
      })
      .onConflictDoNothing()
      .run();
    return this.loadRow(documentId)!;
  }

  private insertSkippedRow(roomId: string, documentId: string, title: string): void {
    this.deps.db
      .insert(routeMindmaps)
      .values({
        documentId,
        roomId,
        title,
        status: "active",
        skipped: true,
      })
      .onConflictDoNothing()
      .run();
  }

  private updateRow(documentId: string, values: Partial<typeof routeMindmaps.$inferInsert> & { updatedAt: Date }): void {
    this.deps.db
      .update(routeMindmaps)
      .set(values)
      .where(eq(routeMindmaps.documentId, documentId))
      .run();
  }

  // ───────────────────────── 素材与派发 ─────────────────────────

  private async assembleMaterial(roomId: string, roomTitle: string): Promise<{ text: string; truncated: boolean } | null> {
    const graph = await this.deps.emergence.buildGraph(roomId, roomTitle);
    return materializeGraphMaterial(graph);
  }

  /** inFlight 归调用方统一管理：进入即占位，终态（含异常）必释放。 */
  private async withInFlight<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
    this.inFlight.add(documentId);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(documentId);
    }
  }

  private async kickInitial(row: RouteRow, roomTitle: string): Promise<void> {
    if (this.inFlight.has(row.documentId)) return;
    const material = await this.assembleMaterial(row.roomId, roomTitle).catch(() => null);
    const now = new Date();
    if (!material) {
      // 空素材不是内部错误：落 failed 让渲染端显示失败与重试。
      this.updateRow(row.documentId, {
        status: "failed",
        error: "route_no_material",
        graph: null,
        selectionPath: null,
        expandingNodeRef: null,
        updatedAt: now,
      });
      return;
    }
    const generationKey = `route:${row.documentId}:initial:${randomUUID()}`;
    this.updateRow(row.documentId, {
      status: "expanding",
      graph: null,
      selectionPath: [ROUTE_ROOT_REF],
      expandingNodeRef: null,
      error: null,
      generationKey,
      contentHash: routeContentHash({ title: row.title, description: row.description, material: material.text }),
      updatedAt: now,
    });
    const fresh = this.loadRow(row.documentId)!;
    await this.withInFlight(row.documentId, () =>
      this.runInitial(fresh.documentId, fresh.roomId, generationKey, row.title, row.description, material, roomTitle),
    );
  }

  private async runInitial(
    documentId: string,
    roomId: string,
    generationKey: string,
    title: string,
    description: string | null,
    material: { text: string; truncated: boolean },
    roomTitle: string,
  ): Promise<void> {
    try {
      const input = {
        task: "initial" as const,
        roomId,
        documentId,
        title,
        ...(description ? { description: description.slice(0, 2000) } : {}),
        material: material.text,
        materialTruncated: material.truncated,
      };
      const options = await this.dispatchPlanner(generationKey, "生成写作路线", input, roomTitle);
      const root: RouteNode = { ref: ROUTE_ROOT_REF, label: title, note: null, children: [] };
      attachChildren(root, options);
      this.updateRow(documentId, {
        status: "active",
        graph: { root } satisfies RouteGraph,
        selectionPath: [ROUTE_ROOT_REF],
        expandingNodeRef: null,
        error: null,
        promptVersion: ROUTE_PROMPT_VERSION,
        generatedAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (error) {
      this.markGenerationFailed(documentId, error);
    }
  }

  private async retryExpansion(row: RouteRow, roomTitle: string): Promise<void> {
    if (this.inFlight.has(row.documentId)) return;
    const graph = this.requireGraph(row);
    const node = findNode(graph.root, row.expandingNodeRef!);
    if (!node) {
      this.updateRow(row.documentId, { status: "failed", error: "route_expand_target_lost", updatedAt: new Date() });
      return;
    }
    const generationKey = `route:${row.documentId}:expand:${randomUUID()}`;
    this.updateRow(row.documentId, { status: "expanding", error: null, generationKey, updatedAt: new Date() });
    const fresh = this.loadRow(row.documentId)!;
    await this.withInFlight(row.documentId, () => this.runExpansion(fresh, generationKey, node, roomTitle));
  }

  private async runExpansion(row: RouteRow, generationKey: string, node: RouteNode, roomTitle: string): Promise<void> {
    const documentId = row.documentId;
    try {
      const graph = this.requireGraph(row);
      const material = await this.assembleMaterial(row.roomId, roomTitle).catch(() => null);
      if (!material) throw new RouteMindmapServiceError("route_no_material", 500);
      const path = pathTo(graph.root, node.ref) ?? [ROUTE_ROOT_REF];
      const chain = labelsOfPath(graph.root, path);
      const input = {
        task: "expand" as const,
        roomId: row.roomId,
        documentId,
        title: row.title,
        ...(row.description ? { description: row.description.slice(0, 2000) } : {}),
        pathContext: chain.join(" > ").slice(0, 2000),
        targetLabel: node.label,
        material: material.text,
        materialTruncated: material.truncated,
      };
      const options = await this.dispatchPlanner(generationKey, "扩展写作路线", input, roomTitle);
      const freshGraph = this.requireGraph(this.loadRow(documentId)!);
      const target = findNode(freshGraph.root, node.ref);
      if (!target) throw new RouteMindmapServiceError("route_expand_target_lost", 500);
      attachChildren(target, options);
      this.updateRow(documentId, {
        status: "active",
        graph: freshGraph,
        expandingNodeRef: null,
        error: null,
        promptVersion: ROUTE_PROMPT_VERSION,
        generatedAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (error) {
      this.markGenerationFailed(documentId, error);
    }
  }

  /** 派发 route-planner 并解析选项；非终态/解析失败均抛错。 */
  private async dispatchPlanner(
    generationKey: string,
    taskLabel: string,
    input: Record<string, unknown>,
    roomTitle: string,
  ): Promise<Array<{ label: string; note: string | null }>> {
    let invocation;
    try {
      invocation = await this.deps.orchestrator.dispatch({
        agentId: ROUTE_PLANNER_AGENT_ID,
        task: taskLabel,
        input,
        idempotencyKey: generationKey,
        source: "internal_workflow",
        parentSessionId: null,
        parentRunId: null,
      });
    } catch (error) {
      throw new RouteMindmapServiceError(
        `route_dispatch_failed: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
    if (invocation.status !== "completed" || !invocation.result?.structuredOutput) {
      throw new RouteMindmapServiceError(
        `route_invocation_${invocation.status}:${invocation.errorMessage ?? invocation.errorCode ?? ""}`,
        500,
      );
    }
    return parseRouteOptions(invocation.result.structuredOutput);
  }

  private async runWriting(row: RouteRow, writingKey: string, roomTitle: string): Promise<void> {
    const documentId = row.documentId;
    try {
      const graph = this.requireGraph(this.loadRow(documentId)!);
      const path = row.selectionPath ?? [ROUTE_ROOT_REF];
      const chain = labelsOfPath(graph.root, path);
      const material = await this.assembleMaterial(row.roomId, roomTitle).catch(() => null);
      const instruction = [
        `为文档《${row.title}》撰写完整正文。`,
        `写作路线（已由用户在路线导图上逐层选定，正文必须沿这条路线展开）：${chain.join(" > ")}。`,
        row.description ? `用户需求：${row.description}` : "",
        "正文使用 Markdown，从二级标题（##）开始组织章节；不要包含一级标题，不要重复文档标题。",
      ].filter(Boolean).join("");
      const invocation = await this.deps.orchestrator.dispatch({
        agentId: DOC_WRITER_AGENT_ID,
        task: "起草新文档正文",
        input: {
          task: "draft-create",
          instruction,
          material: material?.text ?? "",
          roomId: row.roomId,
          roomTitle,
          documentName: row.title,
          documentId,
        },
        idempotencyKey: writingKey,
        source: "internal_workflow",
        parentSessionId: null,
        parentRunId: null,
      });
      if (invocation.status !== "completed" || !invocation.result?.structuredOutput) {
        throw new RouteMindmapServiceError(
          `route_writing_${invocation.status}:${invocation.errorMessage ?? invocation.errorCode ?? ""}`,
          500,
        );
      }
      const output = invocation.result.structuredOutput as Record<string, unknown>;
      const markdown = typeof output.contentMarkdown === "string" && output.contentMarkdown.trim()
        ? output.contentMarkdown
        : Array.isArray(output.appendChunks)
          ? output.appendChunks.filter((chunk): chunk is string => typeof chunk === "string").join("")
          : "";
      if (!markdown.trim()) throw new RouteMindmapServiceError("route_writing_empty_draft", 500);
      await this.deps.documents.syncExternalMarkdown({
        documentId,
        roomId: row.roomId,
        title: row.title,
        markdown,
      });
      this.updateRow(documentId, { writing: false, error: null, updatedAt: new Date() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateRow(documentId, { writing: false, error: message.slice(0, 500), updatedAt: new Date() });
      this.deps.log.warn(
        { event: "knowledge.routeMindmap.writing_failed", documentId, error: message.slice(0, 500) },
        "route mindmap finalize writing failed",
      );
    }
  }

  // ───────────────────────── 对账与落败 ─────────────────────────

  /**
   * 重启对账：expanding/writing 行按 key 反查 subagent_invocations，
   * invocation 非存活即收敛（expanding→failed 保图；writing→错误态可重试）。
   * 本进程在跑（inFlight）或 key 未落（素材组装中）的行不动。
   */
  private reconcile(row: RouteRow | null): RouteRow | null {
    if (!row || !needsReconcile(row)) return row;
    if (this.inFlight.has(row.documentId)) return row;
    const key = row.writing === true ? row.writingKey : row.generationKey;
    if (!key) return row;
    const invocation = this.deps.db
      .select({ status: subagentInvocations.status })
      .from(subagentInvocations)
      .where(and(
        eq(subagentInvocations.source, "internal_workflow"),
        isNull(subagentInvocations.parentRunId),
        eq(subagentInvocations.idempotencyKey, key),
      ))
      .get();
    const alive = invocation?.status === "accepted" || invocation?.status === "running";
    if (alive) return row;
    if (row.writing === true) {
      this.updateRow(row.documentId, { writing: false, error: "route_writing_invocation_lost", updatedAt: new Date() });
      this.deps.log.warn(
        { event: "knowledge.routeMindmap.writing_lost", documentId: row.documentId },
        "route mindmap writing invocation lost after restart; row converged to retryable error",
      );
      return { ...row, writing: false, error: "route_writing_invocation_lost" };
    }
    this.updateRow(row.documentId, { status: "failed", error: "route_invocation_lost", updatedAt: new Date() });
    this.deps.log.warn(
      { event: "knowledge.routeMindmap.invocation_lost", documentId: row.documentId },
      "route mindmap generation invocation lost after restart; row converged to failed",
    );
    return { ...row, status: "failed", error: "route_invocation_lost" };
  }

  /** 生成失败：保图与 expandingNodeRef（start 重试按它重派那一层）。 */
  private markGenerationFailed(documentId: string, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    this.updateRow(documentId, { status: "failed", error: message, updatedAt: new Date() });
    this.deps.log.warn(
      { event: "knowledge.routeMindmap.generation_failed", documentId, error: message },
      "route mindmap generation failed",
    );
  }

  // ───────────────────────── 视图 ─────────────────────────

  private toView(
    row: RouteRow | null,
    roomId: string,
    document: { id: string; title: string },
    requestVersion: number,
  ): RouteMindmapStatusView {
    if (!row) {
      return {
        roomId,
        documentId: document.id,
        title: document.title,
        description: null,
        status: "missing",
        skipped: false,
        writing: false,
        error: null,
        expandingNodeRef: null,
        graph: null,
        selectionPath: null,
        finalizedAt: null,
        generatedAt: null,
        promptVersion: null,
        requestVersion,
      };
    }
    return {
      roomId,
      documentId: row.documentId,
      title: row.title,
      description: row.description,
      status: row.status as RouteMindmapStatusView["status"],
      skipped: row.skipped === true,
      writing: row.writing === true,
      error: row.error,
      expandingNodeRef: row.expandingNodeRef,
      graph: (row.graph as RouteGraph | null) ?? null,
      selectionPath: row.selectionPath ?? null,
      finalizedAt: row.finalizedAt instanceof Date ? row.finalizedAt.toISOString() : null,
      generatedAt: row.generatedAt instanceof Date ? row.generatedAt.toISOString() : null,
      promptVersion: row.promptVersion,
      requestVersion,
    };
  }
}
