import { and, desc, eq, isNull } from "drizzle-orm";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  contextRooms,
  documents,
  entities,
  roomContextCorrections,
  roomDocumentLinks,
  roomEntityFacts,
  roomEntityMentions,
  roomLocalActions,
  roomSourceMemberships,
} from "../../infrastructure/database/schema.js";
import { tiptapToMarkdown } from "../knowledge/tiptap-markdown.js";

/** Room 材料投影的单文档与总量 Markdown 预算：约束下游输入体积（子 Agent 工具与 content-analyst 投喂共用）。 */
export const PER_DOCUMENT_MARKDOWN_LIMIT = 12_000;
export const TOTAL_MARKDOWN_LIMIT = 80_000;
export const MAX_DOCUMENTS = 30;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Room 材料共享投影（方案 §4.2 B2：分析任务合并）。
 *
 * context-room 子 Agent 的 room_context_get 工具与主 Agent room_analysis 的
 * 网关侧组装（投喂 content-analyst）共用同一实现与同一套预算常量，
 * 避免两处取数口径漂移。覆盖数据面：房间头（title/kind/brief/timeline）、
 * 文档 Markdown（单篇 12K / 总量 80K / 最多 30 篇，超长截断）、
 * 结构化事实（联 room_source_memberships 取 sourceTitle）、实体证据、
 * 已应用纠正、本地待办/日程。
 *
 * @throws room_context_room_id_required / context_room_not_found
 */
export function buildRoomContextDigest(db: GatewayDatabase, roomId: string) {
  const normalizedRoomId = String(roomId ?? "").trim();
  if (!normalizedRoomId) throw new Error("room_context_room_id_required");
  const room = db.select().from(contextRooms).where(and(
    eq(contextRooms.id, normalizedRoomId),
    isNull(contextRooms.deletedAt),
  )).get();
  if (!room || room.lifecycle !== "active") throw new Error("context_room_not_found");
  const rows = db.select({ document: documents })
    .from(roomDocumentLinks)
    .innerJoin(documents, eq(roomDocumentLinks.documentId, documents.id))
    .where(and(eq(roomDocumentLinks.roomId, normalizedRoomId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.updatedAt))
    .all()
    .filter(({ document }) => document.status === "active")
    .slice(0, MAX_DOCUMENTS);
  let totalCharacters = 0;
  let truncatedDocuments = 0;
  const collected = rows.flatMap(({ document }) => {
    const markdown = tiptapToMarkdown(document.contentJson as TiptapJsonContent);
    const budget = Math.min(
      PER_DOCUMENT_MARKDOWN_LIMIT,
      Math.max(TOTAL_MARKDOWN_LIMIT - totalCharacters, 0),
    );
    if (budget <= 0) {
      truncatedDocuments += 1;
      return [{
        documentId: document.id,
        title: document.title,
        version: document.version,
        updatedAt: document.updatedAt.toISOString(),
        markdown: "",
        truncated: true,
      }];
    }
    const clipped = markdown.length > budget;
    if (clipped) truncatedDocuments += 1;
    totalCharacters += Math.min(markdown.length, budget);
    return [{
      documentId: document.id,
      title: document.title,
      version: document.version,
      updatedAt: document.updatedAt.toISOString(),
      markdown: clipped ? `${markdown.slice(0, budget)}\n…（已截断）` : markdown,
      truncated: clipped,
    }];
  });
  return {
    roomId: normalizedRoomId,
    room: {
      title: room.title,
      kind: room.kind,
      brief: isRecord(room.data.brief) ? room.data.brief : {},
      timeline: Array.isArray(room.data.timeline) ? room.data.timeline.slice(0, 100) : [],
    },
    facts: db.select({
      factId: roomEntityFacts.factId,
      content: roomEntityFacts.content,
      type: roomEntityFacts.type,
      sourceKind: roomEntityFacts.sourceKind,
      sourceId: roomEntityFacts.sourceId,
      sourceTitle: roomSourceMemberships.sourceTitle,
      updatedAt: roomEntityFacts.updatedAt,
    }).from(roomEntityFacts).leftJoin(roomSourceMemberships, and(
      eq(roomSourceMemberships.roomId, roomEntityFacts.roomId),
      eq(roomSourceMemberships.sourceKind, roomEntityFacts.sourceKind),
      eq(roomSourceMemberships.sourceId, roomEntityFacts.sourceId),
    )).where(eq(roomEntityFacts.roomId, normalizedRoomId)).all().slice(0, 200).map((fact) => ({
      ...fact,
      updatedAt: fact.updatedAt.toISOString(),
    })),
    entities: db.select({
      id: entities.id,
      name: entities.name,
      kind: entities.kind,
      summary: entities.summary,
      evidence: roomEntityMentions.evidence,
      sourceKind: roomEntityMentions.sourceKind,
      sourceId: roomEntityMentions.sourceId,
    }).from(roomEntityMentions).innerJoin(entities, eq(entities.id, roomEntityMentions.entityId))
      .where(eq(roomEntityMentions.roomId, normalizedRoomId)).all().slice(0, 200),
    appliedCorrections: db.select().from(roomContextCorrections).where(and(
      eq(roomContextCorrections.roomId, normalizedRoomId),
      eq(roomContextCorrections.status, "applied"),
    )).all().map((correction) => ({
      operation: correction.operation,
      section: correction.section,
      originalText: correction.originalText,
      replacementText: correction.replacementText,
      rationale: correction.rationale,
    })),
    // 本地待办/日程（agent/用户创建，未删）：供落地步骤查重与避免重复建议。
    localActions: db.select({
      id: roomLocalActions.id,
      kind: roomLocalActions.kind,
      title: roomLocalActions.title,
      dueAt: roomLocalActions.dueAt,
      startedAt: roomLocalActions.startedAt,
      completedAt: roomLocalActions.completedAt,
    }).from(roomLocalActions).where(and(
      eq(roomLocalActions.roomId, normalizedRoomId),
      isNull(roomLocalActions.deletedAt),
    )).all().map((action) => ({
      ...action,
      dueAt: action.dueAt?.toISOString() ?? null,
      startedAt: action.startedAt?.toISOString() ?? null,
      completedAt: action.completedAt?.toISOString() ?? null,
    })).slice(0, 100),
    documentCount: rows.length,
    ...(rows.length > collected.length ? { omittedDocuments: rows.length - collected.length } : {}),
    ...(truncatedDocuments > 0 ? { truncatedDocuments } : {}),
    documents: collected,
  };
}

export type RoomContextDigest = ReturnType<typeof buildRoomContextDigest>;

function timelineEntryText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry === null || entry === undefined) return "";
  return JSON.stringify(entry);
}

/**
 * 把 Room 材料投影组装为投喂 content-analyst 的纯文本 content
 * （方案 §4.2：房间头 / 文档标题与 Markdown（标注截断）/ 事实清单逐条，
 * 并附带实体、已应用纠正与本地待办，保持与子 Agent 自取材料时可见的数据面一致）。
 * 各段内容均来自用户材料，属不可信数据，仅作拼接不执行。
 */
export function formatRoomContextDigest(digest: RoomContextDigest): string {
  const sections: string[] = [];
  const briefLines = Object.entries(digest.room.brief)
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([key, value]) => `- ${key}：${String(value).trim()}`);
  sections.push([
    `【Room】${digest.room.title}`,
    `类型：${digest.room.kind ?? "未分类"}`,
    ...(briefLines.length > 0 ? ["简报：", ...briefLines] : []),
    ...(digest.room.timeline.length > 0
      ? ["时间线：", ...digest.room.timeline.map((entry) => `- ${timelineEntryText(entry)}`)]
      : []),
  ].join("\n"));

  sections.push(digest.documents.length > 0
    ? [
        `【文档】共 ${digest.documents.length} 篇${digest.truncatedDocuments ? `（其中 ${digest.truncatedDocuments} 篇因预算截断）` : ""}`,
        ...digest.documents.map((document) => [
          `### ${document.title}（版本 v${document.version}，更新于 ${document.updatedAt}${document.truncated ? "，已截断" : ""}）`,
          document.markdown.trim() ? document.markdown : "（正文因材料预算限制未收录）",
        ].join("\n")),
      ].join("\n\n")
    : "【文档】无");

  sections.push([
    "【结构化事实】",
    ...digest.facts.map((fact) => (
      `- ${fact.content}（来源：${fact.sourceTitle ?? `${fact.sourceKind}:${fact.sourceId}`}）`
    )),
  ].join("\n"));

  if (digest.entities.length > 0) {
    sections.push([
      "【实体】",
      ...digest.entities.map((entity) => (
        `- ${entity.name}（${entity.kind}${entity.summary ? `：${entity.summary}` : ""}）`
      )),
    ].join("\n"));
  }
  if (digest.appliedCorrections.length > 0) {
    sections.push([
      "【已应用纠正】",
      ...digest.appliedCorrections.map((correction) => (
        `- ${correction.operation}/${correction.section}：「${correction.originalText ?? ""}」→「${correction.replacementText ?? ""}」（理由：${correction.rationale}）`
      )),
    ].join("\n"));
  }
  if (digest.localActions.length > 0) {
    sections.push([
      "【本地待办/日程】",
      ...digest.localActions.map((action) => (
        `- [${action.kind}] ${action.title}`
        + `${action.dueAt ? `（截止：${action.dueAt}）` : ""}`
        + `${action.startedAt ? `（开始：${action.startedAt}）` : ""}`
        + `${action.completedAt ? "（已完成）" : ""}`
      )),
    ].join("\n"));
  }
  return sections.join("\n\n");
}
