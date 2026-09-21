/**
 * 知识涌现服务（PRD v3.0 §7/§8）：漫步模式的取数与编排。
 * 聚焦模式已改由 route-mindmap-service.ts（写作路线导图）承接，
 * mode:"focus" 请求直接 400 focus_mode_removed。
 *
 * 编排顺序（照 overview-service 的 buildBase 模式）：取数在本文件完成，
 * 采样/塑形在 emergence-projection.ts 纯函数。漫步完全不依赖 LLM。
 */

import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documentBlockReferences,
  documents,
  roomDocumentLinks,
  rooms,
} from "../../infrastructure/database/schema.js";
import type { ContextRoomService } from "../context-rooms/service.js";
import type { KnowledgeService } from "./service.js";
import {
  buildWanderProjection,
  WANDER_DEFAULT_CARDS,
  type EmergenceProjectionResult,
  type ProjectionGraph,
  type ProjectionGraphEdge,
  type ProjectionGraphNode,
} from "./emergence-projection.js";

export interface EmergenceRequestInput {
  mode: "focus" | "wander";
  /** 焦点对象已废弃（聚焦走 route-mindmap 路由）；仅 documentId 仍被漫步作起点兜底。 */
  focus: {
    documentId?: string | null;
    selectionText?: string | null;
    blockId?: string | null;
    board?: string | null;
    level?: "selection" | "chapter" | "document" | "room" | null;
    trigger?: "selection-settle" | "chapter-stable" | "document-open" | "panel-open" | "board-switch" | null;
    chapter?: { heading: string | null; bodyText: string } | null;
  };
  wander?: { startNodeRef?: string | null; seed?: number | null } | null;
  limit?: number | null;
  requestVersion: number;
}

export class EmergenceServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "EmergenceServiceError";
  }
}

interface EmergenceLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

/** 图谱规模上限：投影是任务视图不是全图（PRD 7.7）。 */
const MAX_ENTITY_NODES = 80;
const MAX_FACT_NODES = 80;
const MAX_DOCUMENT_NODES = 80;
const MAX_BLOCK_REFERENCE_EDGES = 60;
const MAX_WIKI_PAGE_NODES = 60;
const MAX_WIKI_PAGE_LINKS = 80;

type AppliedResult = Awaited<ReturnType<ContextRoomService["roomAppliedEntities"]>>;

export class EmergenceService {
  constructor(private readonly deps: {
    db: GatewayDatabase;
    knowledge: KnowledgeService;
    contextRooms: ContextRoomService;
    log: EmergenceLogger;
  }) {}

  async project(roomId: string, request: EmergenceRequestInput): Promise<EmergenceProjectionResult> {
    if (request.mode !== "wander") {
      throw new EmergenceServiceError("focus_mode_removed", 400);
    }
    const room = this.resolveRoom(roomId);
    const focusDocument = request.focus.documentId ? this.loadDocument(request.focus.documentId) : null;
    const generatedAt = new Date().toISOString();

    const graph = await this.buildGraph(room.id, room.title);
    const startRef = request.wander?.startNodeRef && graph.nodes.has(request.wander.startNodeRef)
      ? request.wander.startNodeRef
      : focusDocument
        ? this.documentNodeRef(focusDocument.id)
        : this.roomNodeRef(room.id);
    const startNode = graph.nodes.get(startRef);
    if (!startNode) throw new EmergenceServiceError("wander_start_not_in_graph", 400);
    return buildWanderProjection({
      startNode,
      graph,
      seed: request.wander?.seed ?? (Date.now() >>> 0),
      cardsLimit: request.limit ?? WANDER_DEFAULT_CARDS,
      requestVersion: request.requestVersion,
      generatedAt,
    });
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
    throw new EmergenceServiceError("room_not_found", 404);
  }

  private loadDocument(documentId: string): { id: string; title: string; overviewText: string | null } | null {
    const row = this.deps.db
      .select({ id: documents.id, title: documents.title, overviewText: documents.overviewText, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, documentId))
      .get();
    if (!row || row.deletedAt) return null;
    return { id: row.id, title: row.title, overviewText: row.overviewText };
  }

  private loadApplied(roomId: string): AppliedResult {
    try {
      return this.deps.contextRooms.roomAppliedEntities(roomId);
    } catch {
      return { roomId, entities: [], facts: [], updatedAt: new Date().toISOString() };
    }
  }

  private roomNodeRef(roomId: string): string {
    return `room:${roomId}`;
  }

  private documentNodeRef(documentId: string): string {
    return `doc:${documentId}`;
  }

  /**
   * 统一对象层（PRD 8.2）：把四类数据源投影为一张可游走的图。
   * 只读查询 + 身份前缀（room:/doc:/entity:/fact:/wiki:），不写回任何基础图谱。
   * 公开供 route-mindmap-service 取三图谱素材（按 sourceGraph 过滤 wiki）。
   */
  async buildGraph(roomId: string, roomTitle: string): Promise<ProjectionGraph> {
    const nodes = new Map<string, ProjectionGraphNode>();
    const edges: ProjectionGraphEdge[] = [];
    const roomRef = this.roomNodeRef(roomId);
    const roomNode: ProjectionGraphNode = {
      id: roomRef,
      nodeType: "room",
      label: roomTitle,
      sourceGraph: "roomGraph",
      roomRef: { id: roomId, title: roomTitle },
      updatedAt: null,
      groupKey: "room:root",
    };
    nodes.set(roomRef, roomNode);
    const link = (from: string, to: string, relationType: string, edgeLevel: ProjectionGraphEdge["edgeLevel"], confidence: number | null, weight = 1) => {
      if (from === to) return;
      edges.push({ from, to, relationType, edgeLevel, confidence, weight });
    };

    // ① 实体与事实图谱：Room →提及→ 实体 →事实→ 事实
    const applied = this.loadApplied(roomId);
    for (const entity of [...applied.entities].sort((a, b) => b.salience - a.salience).slice(0, MAX_ENTITY_NODES)) {
      const ref = `entity:${entity.entityId}`;
      nodes.set(ref, {
        id: ref,
        nodeType: "entity",
        label: entity.name,
        sourceGraph: "entityFacts",
        roomRef: { id: roomId, title: roomTitle },
        updatedAt: entity.lastMentionAt,
        groupKey: `entity:${entity.name}`,
      });
      link(roomRef, ref, "提及", "original", entity.salience);
    }
    const knownEntities = new Set(applied.entities.map((entity) => entity.entityId));
    for (const fact of applied.facts.slice(0, MAX_FACT_NODES)) {
      const ref = `fact:${fact.factId}`;
      nodes.set(ref, {
        id: ref,
        nodeType: "fact",
        label: fact.content.slice(0, 60),
        sourceGraph: "entityFacts",
        roomRef: { id: roomId, title: roomTitle },
        updatedAt: fact.lastMentionAt,
        groupKey: `fact:${fact.content.slice(0, 24)}`,
      });
      const owner = fact.entityIds.find((id) => knownEntities.has(id));
      if (owner) link(`entity:${owner}`, ref, "事实", "original", Math.min(1, fact.sourceCount / 3));
      else link(roomRef, ref, "事实", "original", Math.min(1, fact.sourceCount / 3));
    }

    // ② 内容建联：Room →收录→ 文档；文档 ↔引用↔ 文档（块引用投影）
    const docRows = this.deps.db
      .select({
        id: documents.id,
        title: documents.title,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documents.id))
      .where(and(eq(roomDocumentLinks.roomId, roomId), isNull(documents.deletedAt)))
      .orderBy(desc(documents.updatedAt))
      .limit(MAX_DOCUMENT_NODES)
      .all();
    for (const doc of docRows) {
      const ref = this.documentNodeRef(doc.id);
      nodes.set(ref, {
        id: ref,
        nodeType: "document",
        label: doc.title,
        sourceGraph: "linkGraph",
        roomRef: { id: roomId, title: roomTitle },
        updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : null,
        groupKey: "document",
      });
      link(roomRef, ref, "收录", "original", null);
    }
    const docIds = docRows.map((doc) => doc.id);
    if (docIds.length > 0) {
      const referenceRows = this.deps.db
        .select({
          sourceDocumentId: documentBlockReferences.sourceDocumentId,
          targetDocumentId: documentBlockReferences.targetDocumentId,
        })
        .from(documentBlockReferences)
        .where(or(
          inArray(documentBlockReferences.sourceDocumentId, docIds),
          inArray(documentBlockReferences.targetDocumentId, docIds),
        ))
        .limit(MAX_BLOCK_REFERENCE_EDGES)
        .all();
      const seenPairs = new Set<string>();
      for (const row of referenceRows) {
        const pairKey = [row.sourceDocumentId, row.targetDocumentId].sort().join("\n");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        if (!nodes.has(this.documentNodeRef(row.sourceDocumentId)) || !nodes.has(this.documentNodeRef(row.targetDocumentId))) continue;
        link(this.documentNodeRef(row.sourceDocumentId), this.documentNodeRef(row.targetDocumentId), "引用", "original", null);
      }
    }

    // ③ LLM Wiki：Room →收录于Wiki→ 知识页 ↔内链↔ 知识页
    try {
      const wiki = await this.deps.knowledge.wikiGraph(roomId);
      const pageIds = new Set(wiki.nodes.map((node) => node.id));
      for (const page of wiki.nodes.slice(0, MAX_WIKI_PAGE_NODES)) {
        const ref = `wiki:${page.id}`;
        nodes.set(ref, {
          id: ref,
          nodeType: "wikiPage",
          label: page.title,
          sourceGraph: "wiki",
          roomRef: { id: roomId, title: roomTitle },
          updatedAt: null,
          groupKey: `wiki:${page.path.split("/")[0] || "root"}`,
        });
        link(roomRef, ref, "收录于Wiki", "composed", null, 0.7);
      }
      for (const edge of wiki.edges.slice(0, MAX_WIKI_PAGE_LINKS)) {
        if (!pageIds.has(edge.source) || !pageIds.has(edge.target)) continue;
        link(`wiki:${edge.source}`, `wiki:${edge.target}`, "内链", "original", null, 0.9);
      }
    } catch {
      // wiki 是增强视图：不可达不阻塞涌现
    }

    // ④ Room 关系图谱：Room ↔关系↔ 关联 Room（跨 Room 桥接边加权）
    try {
      const roomGraph = this.deps.knowledge.roomGraph("active");
      const nodeTitle = new Map(roomGraph.nodes.map((node) => [node.id, node.title]));
      for (const edge of roomGraph.edges) {
        const other = edge.sourceRoomId === roomId ? edge.targetRoomId : edge.targetRoomId === roomId ? edge.sourceRoomId : null;
        if (!other || !nodeTitle.has(other)) continue;
        const otherRef = this.roomNodeRef(other);
        if (!nodes.has(otherRef)) {
          nodes.set(otherRef, {
            id: otherRef,
            nodeType: "room",
            label: nodeTitle.get(other)!,
            sourceGraph: "roomGraph",
            roomRef: { id: other, title: nodeTitle.get(other)! },
            updatedAt: edge.updatedAt,
            groupKey: "room:neighbor",
          });
        }
        const weight = edge.strength === "strong" ? 1.6 : edge.strength === "medium" ? 1.3 : 1;
        link(roomRef, otherRef, edge.label ?? edge.type, "original", edge.score, weight);
      }
    } catch {
      // 关系索引降级时游走继续（PRD 15：显示已完成部分）
    }

    return { nodes, edges };
  }
}
