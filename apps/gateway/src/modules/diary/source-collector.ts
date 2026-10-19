import { and, asc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  screenIntervals,
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  documentVersions,
  documents,
  entities,
  entityDocLinks,
  parsedContents,
  realityEvents,
  uploadedFiles,
  visualNodes,
  visualObservations,
} from "../../infrastructure/database/schema.js";
import { insightEvidenceMarkdown, normalizeInsightTags } from "../reality/insight-tags.js";
import { YjsHistoryService } from "../documents/core/yjs-history-service.js";
import type { DiaryKnowledgeEntity, DiaryMemoryProvider, DiarySource } from "./types.js";
import { clampDate, hash, iso } from "./utils.js";

export interface DiarySourceCollectionState { memoryFailed: boolean }

/** 来源清单硬上限：清单元数据全量进日记 Agent 提示词，超限会撑爆模型上下文/输出。 */
const MAX_DIARY_SOURCES = 200;

function sourceRef(kind: string, id: string): string { return `${kind}:${id}`; }

function textFromJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromJson).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  // Rich-text node attributes contain block UUIDs, marks, links, and editor
  // metadata. Only the node text/content is diary evidence.
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) return record.content.map(textFromJson).filter(Boolean).join(" ");
  return "";
}

export class DiarySourceCollector {
  private readonly yjsHistory = new YjsHistoryService();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly memory?: DiaryMemoryProvider,
    private readonly logger?: Logger,
  ) {}

  async collect(start: Date, end: Date, state?: DiarySourceCollectionState): Promise<DiarySource[]> {
    const rows: DiarySource[] = [];
    const add = (source: DiarySource) => rows.push(source);
    let knowledgeEntitiesBySource: Map<string, DiaryKnowledgeEntity[]> | null = null;
    const knowledgeEntitiesFor = (sourceKind: "mail" | "cloud-doc", sourceId: string) => {
      knowledgeEntitiesBySource ??= this.knowledgeEntitiesBySource();
      return knowledgeEntitiesBySource.get(`${sourceKind}:${sourceId}`) ?? [];
    };
    const registeredVisualFileIds = new Set(this.db.select({ fileId: visualObservations.fileId })
      .from(visualObservations).all().map(({ fileId }) => fileId));

    const latestDocumentVersions = new Map<string, typeof documentVersions.$inferSelect>();
    for (const row of this.db.select().from(documentVersions)
      .where(and(gte(documentVersions.createdAt, start), lt(documentVersions.createdAt, end))).all()) {
      const previous = latestDocumentVersions.get(row.documentId);
      if (!previous || row.createdAt > previous.createdAt) latestDocumentVersions.set(row.documentId, row);
    }
    for (const row of latestDocumentVersions.values()) {
      const doc = this.db.select().from(documents).where(eq(documents.id, row.documentId)).get();
      const materialized = this.yjsHistory.materialize(this.db, row.documentId, row.version);
      if (!materialized?.content) continue;
      const content = textFromJson(materialized.content);
      add({
        sourceId: sourceRef("document_version", row.id), kind: "document_version", version: String(row.version),
        occurredAt: iso(row.createdAt), timeBasis: "document_version_created",
        fingerprint: hash([row.id, row.version, row.createdAt, materialized.content]),
        evidenceSummary: `${materialized.title || doc?.title || "文档"}: ${content.slice(0, 240)}`,
        content,
      });
    }

    for (const row of this.db.select().from(uploadedFiles).all().filter((item) => {
      const occurredAt = item.capturedAt ?? item.updatedAt;
      return !registeredVisualFileIds.has(item.id) && occurredAt >= start && occurredAt < end;
    })) {
      const content = row.currentParsedId
        ? this.db.select().from(parsedContents).where(eq(parsedContents.id, row.currentParsedId)).get()?.markdown
        : undefined;
      const occurredAt = row.capturedAt ?? row.updatedAt;
      add({
        sourceId: sourceRef("file", row.id), kind: "file", version: row.contentHash,
        occurredAt: iso(occurredAt), timeBasis: row.capturedAt ? "file_captured" : "file_updated",
        fingerprint: hash([row.contentHash, occurredAt]), evidenceSummary: row.originalName, assetFileId: row.id,
        ...(content === undefined ? {} : { content }),
      });
    }

    for (const row of this.db.select().from(visualNodes)
      .where(and(
        lt(visualNodes.startAt, end), gte(visualNodes.endAt, start),
        eq(visualNodes.vlmStatus, "ready"), isNull(visualNodes.deletedAt),
      )).all()) {
      const observation = this.db.select().from(visualObservations).where(eq(visualObservations.nodeId, row.id))
        .orderBy(asc(visualObservations.capturedAt)).get();
      const occurredAt = clampDate(row.startAt, start, end);
      const endedAt = clampDate(row.endAt, occurredAt, end);
      const insightTags = normalizeInsightTags(row.representativeTags);
      const title = row.title ?? (row.kind === "photo" ? "照片" : "屏幕活动");
      add({
        sourceId: sourceRef("visual_node", row.id), kind: "visual_node", version: String(row.resultVersion),
        occurredAt: iso(occurredAt), endedAt: iso(endedAt), timeBasis: "visual_capture_range",
        fingerprint: hash([row.id, row.resultVersion, row.startAt, row.endAt, row.sampleCount, row.eventType, row.title, row.summary, row.keyPoints, insightTags]),
        evidenceSummary: row.summary ?? title,
        content: insightEvidenceMarkdown({ title, eventType: row.eventType, summary: row.summary, keyPoints: row.keyPoints, tags: insightTags }),
        keyPoints: row.keyPoints,
        insightTags,
        ...(observation ? { assetFileId: observation.fileId } : {}),
      });
    }

    // 屏幕记忆：同应用连续区间（间隔 <15min）聚合为一个应用会话来源，避免日记被逐卡淹没。
    {
      const intervals = this.db.select().from(screenIntervals)
        .where(and(
          lt(screenIntervals.startedAt, end), gte(screenIntervals.endedAt, start),
          isNull(screenIntervals.deletedAt),
        ))
        .orderBy(asc(screenIntervals.startedAt)).all();
      const SESSION_GAP_MS = 15 * 60_000;
      type Session = { bundleId: string; appName: string; first: typeof intervals[number]; last: typeof intervals[number]; count: number; lines: string[]; summaries: string[] };
      const sessions: Session[] = [];
      for (const row of intervals) {
        const last = sessions.at(-1);
        if (last && last.bundleId === row.bundleId && row.startedAt.getTime() - last.last.endedAt.getTime() < SESSION_GAP_MS) {
          last.last = row;
          last.count += 1;
          last.lines.push(...row.textLines.slice(0, 8));
          if (row.summary) last.summaries.push(row.summary);
        } else {
          sessions.push({ bundleId: row.bundleId, appName: row.appName, first: row, last: row, count: 1, lines: [...row.textLines.slice(0, 8)], summaries: row.summary ? [row.summary] : [] });
        }
      }
      for (const session of sessions) {
        const occurredAt = clampDate(session.first.startedAt, start, end);
        const endedAt = clampDate(session.last.endedAt, occurredAt, end);
        const minutes = Math.max(1, Math.round((session.last.endedAt.getTime() - session.first.startedAt.getTime()) / 60_000));
        const title = `${session.appName} · ${String(minutes)} 分钟`;
        const digest = [
          session.summaries.length > 0 ? session.summaries.slice(0, 3).join("；") : "",
          session.lines.length > 0 ? `片段：${session.lines.slice(0, 12).join(" / ").slice(0, 400)}` : "",
        ].filter(Boolean).join("\n");
        add({
          sourceId: sourceRef("screen_session", `${session.first.id}:${session.last.id}`), kind: "screen_interval", version: String(session.count),
          occurredAt: iso(occurredAt), endedAt: iso(endedAt), timeBasis: "screen_capture_range",
          fingerprint: hash([session.first.id, session.last.id, session.count, session.lines.join("|")]),
          evidenceSummary: `${title}（${String(session.count)} 个片段）`,
          content: digest || title,
        });
      }
    }

    for (const row of this.db.select().from(realityEvents)
      .where(eq(realityEvents.processingState, "ready")).all()
      .filter((item) => item.startedAt < end && (item.endedAt ?? item.startedAt) >= start)) {
      const occurredAt = clampDate(row.startedAt, start, end);
      const endedAt = clampDate(row.endedAt ?? row.startedAt, occurredAt, end);
      const insightTags = normalizeInsightTags(row.insights.representativeTags);
      add({
        sourceId: sourceRef("recording", row.id), kind: "recording", version: String(row.resultVersion),
        occurredAt: iso(occurredAt), endedAt: iso(endedAt), timeBasis: "recording_range",
        fingerprint: hash([row.id, row.resultVersion, row.startedAt, row.endedAt, row.transcript, row.insights]),
        evidenceSummary: row.insights.summary ?? row.currentTopic ?? row.title,
        content: insightEvidenceMarkdown({
          title: row.title,
          ...(row.insights.eventType ? { eventType: row.insights.eventType } : {}),
          summary: row.insights.summary,
          keyPoints: row.insights.keyPoints, tags: insightTags, transcript: row.transcript,
        }),
        keyPoints: row.insights.keyPoints,
        insightTags,
      });
    }

    for (const row of this.db.select().from(connectorEmails).all()) {
      const occurredAt = row.sentAt ?? row.sourceUpdatedAt ?? row.syncedAt;
      if (!row.deletedAt && occurredAt >= start && occurredAt < end) {
        const sourceId = sourceRef("connector_email", row.id);
        const knowledgeEntities = knowledgeEntitiesFor("mail", sourceId);
        add({
          sourceId, kind: "connector_email", version: row.contentHash,
          occurredAt: iso(occurredAt), timeBasis: row.sentAt ? "email_sent" : "connector_updated",
          fingerprint: hash([row.contentHash, occurredAt, knowledgeEntities]), evidenceSummary: row.subject,
          content: row.bodyText, knowledgeEntities,
        });
      }
    }
    for (const row of this.db.select().from(connectorDocuments).all()) {
      const occurredAt = row.sourceUpdatedAt ?? row.syncedAt;
      if (!row.deletedAt && occurredAt >= start && occurredAt < end) {
        const sourceId = sourceRef("connector_document", row.id);
        const knowledgeEntities = knowledgeEntitiesFor("cloud-doc", sourceId);
        add({
          sourceId, kind: "connector_document", version: row.contentHash,
          occurredAt: iso(occurredAt), timeBasis: "connector_updated",
          fingerprint: hash([row.contentHash, occurredAt, knowledgeEntities]), evidenceSummary: row.title,
          content: row.bodyText, knowledgeEntities,
        });
      }
    }
    for (const row of this.db.select().from(connectorCalendarEvents).all()) {
      const sourceStart = row.startAt ?? row.sourceUpdatedAt ?? row.syncedAt;
      const sourceEnd = row.endAt ?? sourceStart;
      if (!row.deletedAt && sourceStart < end && sourceEnd >= start) {
        const sourceId = sourceRef("connector_calendar", row.id);
        const knowledgeEntities = knowledgeEntitiesFor("mail", sourceId);
        const occurredAt = clampDate(sourceStart, start, end);
        const endedAt = clampDate(sourceEnd, occurredAt, end);
        add({
          sourceId, kind: "connector_calendar", version: row.contentHash,
          occurredAt: iso(occurredAt), endedAt: iso(endedAt), timeBasis: row.startAt ? "calendar_range" : "connector_updated",
          fingerprint: hash([row.contentHash, sourceStart, sourceEnd, knowledgeEntities]), evidenceSummary: row.title,
          content: row.description, knowledgeEntities,
        });
      }
    }

    // Atomic memory is derived context, not a second copy of today's timeline.
    // Use it as a fallback only when no direct recording/document/file/event
    // source exists for the day; otherwise imported historical facts swamp the
    // real activity and create repetitive diary events.
    if (rows.length === 0 && this.memory?.query) {
      try { rows.push(...await this.memory.query({ start, end })); }
      catch (error) {
        if (state) state.memoryFailed = true;
        this.logger?.warn({ error }, "diary memory source query failed");
      }
    }
    return this.normalize(rows, start, end);
  }

  private knowledgeEntitiesBySource(): Map<string, DiaryKnowledgeEntity[]> {
    const grouped = new Map<string, DiaryKnowledgeEntity[]>();
    const rows = this.db.select({
      sourceKind: entityDocLinks.sourceKind,
      sourceId: entityDocLinks.sourceId,
      entityId: entities.id,
      name: entities.name,
      kind: entities.kind,
      status: entities.status,
      role: entityDocLinks.role,
      salience: entityDocLinks.salience,
      evidence: entityDocLinks.evidence,
    }).from(entityDocLinks)
      .innerJoin(entities, eq(entities.id, entityDocLinks.entityId))
      .where(inArray(entityDocLinks.sourceKind, ["mail", "cloud-doc"]))
      .all();
    for (const row of rows) {
      const key = `${row.sourceKind}:${row.sourceId}`;
      const values = grouped.get(key) ?? [];
      values.push({
        entityId: row.entityId,
        name: row.name,
        kind: row.kind,
        status: row.status,
        role: row.role,
        salience: row.salience,
        ...(row.evidence ? { evidence: row.evidence } : {}),
      });
      grouped.set(key, values);
    }
    for (const values of grouped.values()) {
      values.sort((left, right) => right.salience - left.salience || left.entityId.localeCompare(right.entityId));
    }
    return grouped;
  }

  private normalize(rows: DiarySource[], start: Date, end: Date): DiarySource[] {
    const unique = new Map<string, DiarySource>();
    for (const source of rows) {
      const sourceStart = new Date(source.occurredAt);
      const sourceEnd = new Date(source.endedAt ?? source.occurredAt);
      const spansTime = sourceEnd > sourceStart;
      if (Number.isNaN(sourceStart.getTime()) || Number.isNaN(sourceEnd.getTime())
        || sourceEnd < sourceStart || sourceStart >= end
        || (spansTime ? sourceEnd <= start : sourceStart < start)) continue;
      const occurredAt = clampDate(sourceStart, start, end);
      const endedAt = clampDate(sourceEnd, occurredAt, end);
      unique.set(source.sourceId, {
        ...source,
        occurredAt: iso(occurredAt),
        ...(source.endedAt ? { endedAt: iso(endedAt) } : {}),
      });
    }
    const byTimeline = (a: DiarySource, b: DiarySource) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.sourceId.localeCompare(b.sourceId);
    const ordered = [...unique.values()].sort(byTimeline);
    if (ordered.length <= MAX_DIARY_SOURCES) return ordered;
    // 超上限时优先丢弃 connector_updated 兜底时间的来源（无真实发生时间的记录），
    // 保留集仍按时间线排序；静默全量塞进清单会把日记 Agent 的提示词撑爆。
    const pinned = ordered.filter((source) => source.timeBasis !== "connector_updated");
    const fallbackTimed = ordered.filter((source) => source.timeBasis === "connector_updated");
    const kept = [...pinned, ...fallbackTimed].slice(0, MAX_DIARY_SOURCES).sort(byTimeline);
    this.logger?.warn({
      event: "diary.sources.truncated",
      total: ordered.length,
      kept: kept.length,
      droppedFallbackTimed: ordered.length - kept.length,
    }, "diary sources over manifest cap; fallback-timed sources dropped first");
    return kept;
  }
}
