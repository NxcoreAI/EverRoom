/**
 * 知识涌现服务（PRD v3.0 §7/§8）：接收 FocusContext 请求，从三套图谱 +
 * LLM Wiki 召回候选，输出唯一 ProjectionResult（卡片与脉络共用）。
 *
 * 编排顺序（照 overview-service 的 buildBase 模式）：取数在本文件完成，
 * 评分/采样/塑形在 emergence-projection.ts 纯函数，Prompt/解析在 llm.ts。
 *
 * 降级纪律（PRD 7.4/15）：LLM 不可用时聚焦仍可用（关键词+图谱路径），
 * 关联理由退化为确定性路径说明并置 degraded；漫步完全不依赖 LLM。
 */

import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  documentBlockReferences,
  documents,
  entities as entitiesTable,
  roomDocumentLinks,
  rooms,
} from "../../infrastructure/database/schema.js";
import type { ContextRoomService } from "../context-rooms/service.js";
import type { MemoryService } from "../memory/service.js";
import { cosineSimilarity, decodeCentroid, EmbeddingClient } from "./embedding.js";
import type { KnowledgeLlm } from "./llm.js";
import type { KnowledgeService } from "./service.js";
import {
  buildFocusProjection,
  buildWanderProjection,
  FOCUS_DEFAULT_CARDS,
  WANDER_DEFAULT_CARDS,
  type EmergenceCandidate,
  type EmergenceNode,
  type EmergenceProjectionResult,
  type EmergenceTaskUnderstanding,
  type ProjectionGraph,
  type ProjectionGraphEdge,
  type ProjectionGraphNode,
} from "./emergence-projection.js";

export interface EmergenceRequestInput {
  mode: "focus" | "wander";
  focus: {
    documentId?: string | null;
    selectionText?: string | null;
    blockId?: string | null;
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
/** 跨 Room 实体语义召回的相似度门槛与条数。 */
const CROSS_ROOM_ENTITY_MIN_SIMILARITY = 0.55;
const CROSS_ROOM_ENTITY_LIMIT = 8;
const ROOM_DOC_RECENT_LIMIT = 10;

type AppliedResult = Awaited<ReturnType<ContextRoomService["roomAppliedEntities"]>>;

export class EmergenceService {
  constructor(private readonly deps: {
    db: GatewayDatabase;
    knowledge: KnowledgeService;
    contextRooms: ContextRoomService;
    memory: MemoryService;
    log: EmergenceLogger;
    embedding: { client: EmbeddingClient; model: string } | null;
  }) {}

  async project(roomId: string, request: EmergenceRequestInput): Promise<EmergenceProjectionResult> {
    const room = this.resolveRoom(roomId);
    const focusDocument = request.focus.documentId ? this.loadDocument(request.focus.documentId) : null;
    const generatedAt = new Date().toISOString();

    if (request.mode === "wander") {
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

    const graph = await this.buildGraph(room.id, room.title);
    const applied = this.loadApplied(room.id);
    const focusText = this.focusText(room, focusDocument, request.focus.selectionText ?? null);
    const llm = this.deps.knowledge.currentLlm();
    let degraded = false;
    let degradedReason: string | null = null;
    let understanding: EmergenceTaskUnderstanding | null = null;
    if (llm) {
      try {
        understanding = await llm.understandTask({
          roomTitle: room.title,
          focusTitle: focusDocument?.title ?? null,
          focusText,
        });
      } catch (error) {
        degraded = true;
        degradedReason = "llm_error";
        this.deps.log.warn(
          { event: "knowledge.emergence.task_understanding_failed", roomId: room.id, error: error instanceof Error ? error.message : String(error) },
          "emergence task understanding degraded to keyword recall",
        );
      }
    } else {
      degraded = true;
      degradedReason = "llm_not_configured";
    }

    const candidates = await this.buildCandidates({
      roomId: room.id,
      roomTitle: room.title,
      focusDocument,
      focusText,
      understanding,
      graph,
      applied,
    });
    const focusNode: EmergenceNode = focusDocument
      ? this.nodeOf(graph, this.documentNodeRef(focusDocument.id), focusDocument.title)
      : this.nodeOf(graph, this.roomNodeRef(room.id), room.title);

    const base = buildFocusProjection({
      focusNode,
      focusText,
      understanding,
      candidates,
      explanations: null,
      limit: request.limit ?? FOCUS_DEFAULT_CARDS,
      requestVersion: request.requestVersion,
      degraded,
      degradedReason,
      generatedAt,
      graph,
    });

    // LLM 理由补写：选择是确定性的，同输入重建结果一致，仅 reason 覆盖
    if (llm && base.cards.length > 0) {
      try {
        const explanations = await this.explain(llm, base.cards.map((card) => ({
          nodeRef: card.nodeRef ?? "",
          kind: card.kind,
          title: card.title,
          summary: card.summary,
        })), understanding, focusText);
        if (explanations.size > 0) {
          return buildFocusProjection({
            focusNode,
            focusText,
            understanding,
            candidates,
            explanations,
            limit: request.limit ?? FOCUS_DEFAULT_CARDS,
            requestVersion: request.requestVersion,
            degraded,
            degradedReason,
            generatedAt,
            graph,
          });
        }
      } catch (error) {
        this.deps.log.warn(
          { event: "knowledge.emergence.explanations_failed", roomId: room.id, error: error instanceof Error ? error.message : String(error) },
          "emergence card explanations fell back to deterministic reasons",
        );
      }
    }
    return base;
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

  private nodeOf(graph: ProjectionGraph, ref: string, fallbackLabel: string): EmergenceNode {
    const node = graph.nodes.get(ref);
    if (node) return node;
    return {
      id: ref,
      nodeType: ref.startsWith("doc:") ? "document" : "room",
      label: fallbackLabel,
      sourceGraph: "linkGraph",
      roomRef: null,
      updatedAt: null,
    };
  }

  /**
   * 统一对象层（PRD 8.2）：把四类数据源投影为一张可游走的图。
   * 只读查询 + 身份前缀（room:/doc:/entity:/fact:/wiki:），不写回任何基础图谱。
   */
  private async buildGraph(roomId: string, roomTitle: string): Promise<ProjectionGraph> {
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

  private focusText(
    room: { title: string; summary: string | null },
    focusDocument: { title: string; overviewText: string | null } | null,
    selectionText: string | null,
  ): string {
    if (selectionText && selectionText.trim()) return selectionText.trim().slice(0, 2_000);
    if (focusDocument?.overviewText?.trim()) return focusDocument.overviewText.trim().slice(0, 2_000);
    if (focusDocument) return focusDocument.title;
    return [room.title, room.summary ?? ""].filter(Boolean).join("\n");
  }

  // ───────────────────────── 候选组装 ─────────────────────────

  private async buildCandidates(input: {
    roomId: string;
    roomTitle: string;
    focusDocument: { id: string; title: string; overviewText: string | null } | null;
    focusText: string;
    understanding: EmergenceTaskUnderstanding | null;
    graph: ProjectionGraph;
    applied: AppliedResult;
  }): Promise<EmergenceCandidate[]> {
    const { roomId, roomTitle, focusDocument, understanding, graph, applied } = input;
    const candidates: EmergenceCandidate[] = [];
    const focusRef = focusDocument ? this.documentNodeRef(focusDocument.id) : this.roomNodeRef(roomId);
    // 焦点文档与实体的直连：实体 sources 里命中该文档时路径缩短为一跳
    const docLinkedEntities = new Set<string>();
    if (focusDocument) {
      for (const entity of applied.entities) {
        if (entity.sources.some((source) => source.sourceKind === "everroom-doc" && source.sourceId === focusDocument.id)) {
          docLinkedEntities.add(entity.entityId);
        }
      }
    }

    for (const entity of applied.entities) {
      const ref = `entity:${entity.entityId}`;
      if (!graph.nodes.has(ref)) continue;
      candidates.push({
        nodeRef: ref,
        kind: entity.kind === "人物" || entity.kind === "项目" ? "actor" : "case",
        title: entity.name,
        summary: entity.summary ?? entity.evidence ?? `本 Room 内 ${entity.mentionCount} 个来源提及`,
        sourceType: "entity",
        occurredAt: entity.lastMentionAt,
        roomRef: { id: roomId, title: roomTitle },
        quote: entity.evidence,
        groupKey: `entity:${entity.name}`,
        path: docLinkedEntities.has(entity.entityId)
          ? { nodeRefs: [focusRef, ref], hops: ["提及"] }
          : { nodeRefs: [focusRef, this.roomNodeRef(roomId), ref], hops: ["属于", "提及"] },
        edgeLevel: "original",
        evidence: Math.min(1, entity.mentionCount / 4),
      });
    }

    for (const fact of applied.facts) {
      const ref = `fact:${fact.factId}`;
      if (!graph.nodes.has(ref)) continue;
      candidates.push({
        nodeRef: ref,
        kind: "evidence",
        title: fact.content.slice(0, 80),
        summary: fact.content,
        sourceType: "fact",
        occurredAt: fact.lastMentionAt,
        roomRef: { id: roomId, title: roomTitle },
        quote: fact.sources[0]?.evidence ?? null,
        groupKey: `fact:${fact.content.slice(0, 24)}`,
        path: { nodeRefs: [focusRef, this.roomNodeRef(roomId), ref], hops: ["属于", "事实"] },
        edgeLevel: "original",
        evidence: Math.min(1, fact.sourceCount / 3),
      });
    }

    for (const node of graph.nodes.values()) {
      if (node.nodeType === "wikiPage") {
        candidates.push({
          nodeRef: node.id,
          kind: "viewpoint",
          title: node.label,
          summary: "Wiki 知识页结论",
          sourceType: "wiki",
          occurredAt: null,
          roomRef: { id: roomId, title: roomTitle },
          quote: null,
          groupKey: node.groupKey,
          path: { nodeRefs: [focusRef, this.roomNodeRef(roomId), node.id], hops: ["属于", "收录于Wiki"] },
          edgeLevel: "composed",
          evidence: 0.5,
        });
      }
    }

    // 邻近 Room：跨 Room 桥接候选（walk 图里已含节点）
    for (const node of graph.nodes.values()) {
      if (node.nodeType !== "room" || node.id === this.roomNodeRef(roomId)) continue;
      const edge = graph.edges.find((item) =>
        (item.from === this.roomNodeRef(roomId) && item.to === node.id)
        || (item.to === this.roomNodeRef(roomId) && item.from === node.id));
      candidates.push({
        nodeRef: node.id,
        kind: "case",
        title: node.label,
        summary: edge ? `图谱关系：${edge.relationType}` : "关联 Room",
        sourceType: "room",
        occurredAt: node.updatedAt,
        roomRef: node.roomRef,
        quote: null,
        groupKey: "room:neighbor",
        path: { nodeRefs: [focusRef, this.roomNodeRef(roomId), node.id], hops: ["属于", edge?.relationType ?? "相关"] },
        edgeLevel: "original",
        evidence: edge?.confidence ?? 0.5,
      });
    }

    // 记忆召回：任务主题词优先（searchRoomMemories 是分词 AND 匹配）
    const memoryQuery = understanding && (understanding.themes.length > 0 || understanding.objects.length > 0)
      ? [...understanding.themes, ...understanding.objects].join(" ")
      : input.focusText.slice(0, 200);
    try {
      const memories = await this.deps.memory.searchRoomMemories(roomId, memoryQuery, 12);
      for (const memory of memories) {
        const ref = `memory:${memory.memoryId}`;
        graph.nodes.set(ref, {
          id: ref,
          nodeType: "memory",
          label: memory.content.slice(0, 60),
          sourceGraph: "linkGraph",
          roomRef: { id: roomId, title: roomTitle },
          updatedAt: memory.updatedAt,
          groupKey: `memory:${memory.type}`,
        });
        graph.edges.push({ from: this.roomNodeRef(roomId), to: ref, relationType: "记忆", edgeLevel: "composed", confidence: null, weight: 0.8 });
        candidates.push({
          nodeRef: ref,
          kind: "viewpoint",
          title: memory.content.slice(0, 80),
          summary: memory.content.slice(0, 200),
          sourceType: "memory",
          occurredAt: memory.updatedAt,
          roomRef: { id: roomId, title: roomTitle },
          quote: memory.content.slice(0, 200),
          groupKey: `memory:${memory.type}`,
          path: { nodeRefs: [focusRef, this.roomNodeRef(roomId), ref], hops: ["属于", "记忆"] },
          edgeLevel: "composed",
          evidence: 0.4,
        });
      }
    } catch {
      // 记忆服务不可达不阻塞涌现
    }

    // 跨 Room 实体语义召回（PRD 8.3 语义关系：点线，仅作召回线索）
    if (this.deps.embedding) {
      try {
        const vector = await this.deps.embedding.client.embed(input.focusText);
        const rows = this.deps.db
          .select({ id: entitiesTable.id, name: entitiesTable.name, summary: entitiesTable.summary, roomId: entitiesTable.roomId, centroid: entitiesTable.centroid, centroidModel: entitiesTable.centroidModel })
          .from(entitiesTable)
          .where(and(isNotNull(entitiesTable.centroid), ne(entitiesTable.status, "suppressed")))
          .all();
        const inRoom = new Set(applied.entities.map((entity) => entity.entityId));
        const scored = rows
          .filter((row) => row.centroidModel === this.deps.embedding!.model && !inRoom.has(row.id))
          .map((row) => ({ row, similarity: cosineSimilarity(vector, decodeCentroid(row.centroid!)) }))
          .filter((item) => item.similarity >= CROSS_ROOM_ENTITY_MIN_SIMILARITY)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, CROSS_ROOM_ENTITY_LIMIT);
        for (const { row, similarity } of scored) {
          const ref = `entity:${row.id}`;
          if (graph.nodes.has(ref)) continue;
          const roomRef = row.roomId ? { id: row.roomId, title: roomTitle } : null;
          graph.nodes.set(ref, {
            id: ref,
            nodeType: "entity",
            label: row.name,
            sourceGraph: "entityFacts",
            roomRef,
            updatedAt: null,
            groupKey: `entity:${row.name}`,
          });
          graph.edges.push({ from: this.roomNodeRef(roomId), to: ref, relationType: "语义相似", edgeLevel: "semantic", confidence: similarity, weight: 0.5 });
          candidates.push({
            nodeRef: ref,
            kind: "actor",
            title: row.name,
            summary: row.summary ?? "语义相关的跨 Room 实体",
            sourceType: "entity",
            occurredAt: null,
            roomRef,
            quote: null,
            groupKey: `entity:${row.name}`,
            path: { nodeRefs: [focusRef, this.roomNodeRef(roomId), ref], hops: ["属于", "语义相似"] },
            edgeLevel: "semantic",
            evidence: similarity,
          });
        }
      } catch {
        // embedding 不可用：语义召回缺席，其余路径不受影响
      }
    }

    // 焦点文档的块引用对端（伴随态）：引用/被引文档是直接建联证据
    if (focusDocument) {
      const focusDocRef = this.documentNodeRef(focusDocument.id);
      if (!graph.nodes.has(focusDocRef)) {
        graph.nodes.set(focusDocRef, {
          id: focusDocRef,
          nodeType: "document",
          label: focusDocument.title,
          sourceGraph: "linkGraph",
          roomRef: { id: roomId, title: roomTitle },
          updatedAt: null,
          groupKey: "document",
        });
        graph.edges.push({ from: this.roomNodeRef(roomId), to: focusDocRef, relationType: "收录", edgeLevel: "composed", confidence: null, weight: 1 });
      }
    }

    return candidates;
  }

  private async explain(
    llm: KnowledgeLlm,
    cards: Array<{ nodeRef: string; kind: string; title: string; summary: string }>,
    understanding: EmergenceTaskUnderstanding | null,
    focusText: string,
  ): Promise<Map<string, string>> {
    const explanations = await llm.explainCards({
      intent: understanding?.intent || focusText.slice(0, 80),
      candidates: cards,
    });
    const byRef = new Map<string, string>();
    for (const item of explanations) {
      if (item.reason) byRef.set(item.nodeRef, item.reason);
    }
    return byRef;
  }
}
