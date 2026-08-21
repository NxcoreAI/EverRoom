import { randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type ApplyRealityAsrInput,
  type CreateRealityEventInput,
  type FinishRealityCaptureInput,
  type ImportRealityEventInput,
  type MarkRealityEventInput,
  type RealityEvent,
  type RealityInsights,
  type RealityTranscriptSegment,
  type UpdateRealityTranscriptInput,
} from "@nxcore/reality-contract";
import { and, desc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { realityEvents } from "../../infrastructure/database/schema.js";
import { RealityError } from "./errors.js";
import { RealityEventBroker } from "./event-broker.js";

export type RealityKnowledgeIngestHandler = (input: { sourceId: string }) => Promise<unknown>;

const EMPTY_INSIGHTS: RealityInsights = {
  currentTopic: null,
  summary: null,
  keyPoints: [],
  decisions: [],
  actionItems: [],
  people: [],
  projects: [],
  unresolvedQuestions: [],
  representativeTags: [],
};

function toEvent(row: typeof realityEvents.$inferSelect): RealityEvent {
  return {
    id: row.id,
    title: row.title,
    // 兼容旧库遗留的 pending_confirmation（状态已废弃，语义等同完成）。
    status: row.status === ("pending_confirmation" as typeof row.status)
      ? ("completed" as const)
      : row.status,
    processingState: row.processingState,
    captureDevice: row.captureDevice,
    processingDevice: row.processingDevice,
    audioSource: row.audioSource,
    audioFileName: row.audioFileName,
    audioMimeType: row.audioMimeType,
    durationMs: row.durationMs,
    currentTopic: row.currentTopic,
    transcript: row.transcript,
    transcriptSegments: row.transcriptSegments,
    transcriptEditedAt: row.transcriptEditedAt?.toISOString() ?? null,
    insights: row.insights,
    markers: row.markers,
    important: row.important,
    asrJobId: row.asrJobId,
    asrSource: row.asrSource,
    error: row.error,
    version: row.version,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sentences(value: string): string[] {
  return value
    .split(/(?<=[。！？!?])|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function deriveInsights(transcript: string, contextPrompt: string | null): RealityInsights {
  const lines = sentences(transcript);
  const unique = (items: string[]) => [...new Set(items)].slice(0, 8);
  const topic = contextPrompt?.trim().split(/[，,。\n]/)[0]?.slice(0, 50)
    || lines[0]?.replace(/[。！？!?]$/, "").slice(0, 50)
    || null;
  return {
    currentTopic: topic,
    summary: lines.slice(0, 2).join("").slice(0, 180) || null,
    keyPoints: unique(lines.filter((line) => line.length >= 8).slice(0, 5)),
    decisions: unique(lines.filter((line) => /决定|确定|确认|结论|同意/.test(line))),
    actionItems: unique(lines.filter((line) => /下一步|需要|负责|跟进|待办|TODO/i.test(line))),
    people: [],
    projects: contextPrompt ? unique(contextPrompt.split(/[，,、\n]/).map((item) => item.trim()).filter(Boolean)) : [],
    unresolvedQuestions: unique(lines.filter((line) => /[?？]$|吗[。]?$/u.test(line))),
    representativeTags: [],
  };
}

export class RealityService {
  readonly broker = new RealityEventBroker();
  private readySink: ((event: RealityEvent) => Promise<void>) | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly recordingsDirectory: string,
    private readonly logger?: Logger,
  ) {}

  setReadySink(sink: ((event: RealityEvent) => Promise<void>) | null): void {
    this.readySink = sink;
  }

  setKnowledgeIngestHandler(handler: RealityKnowledgeIngestHandler | null): void {
    this.readySink = handler ? async (event) => { await handler({ sourceId: event.id }); } : null;
  }

  async ingestToKnowledge(id: string): Promise<unknown> {
    const event = this.requireRow(id);
    if (event.status !== "completed") {
      throw new RealityError("reality_event_not_completed", "Reality event is not completed", 409);
    }
    if (!this.readySink) {
      throw new RealityError("knowledge_ingest_unavailable", "Knowledge ingest is not enabled", 503);
    }
    await this.readySink(toEvent(event));
    return { ok: true };
  }

  listEvents(filters: { status?: string; search?: string }): RealityEvent[] {
    const search = filters.search?.trim().toLocaleLowerCase();
    return this.db.select().from(realityEvents).orderBy(desc(realityEvents.startedAt)).all()
      .map(toEvent)
      .filter((event) => !filters.status || event.status === filters.status)
      .filter((event) => !search || [event.title, event.transcript, event.currentTopic ?? ""]
        .some((value) => value.toLocaleLowerCase().includes(search)));
  }

  getEvent(id: string): RealityEvent | null {
    const row = this.row(id);
    return row ? toEvent(row) : null;
  }

  recoverInterruptedCaptures(): number {
    const interrupted = this.db.select().from(realityEvents).where(and(
      eq(realityEvents.status, "ongoing"),
      eq(realityEvents.processingState, "capturing"),
    )).all();
    for (const row of interrupted) {
      this.closeInterruptedCapture(row, "上一次采集未正常结束");
    }
    return interrupted.length;
  }

  createEvent(input: CreateRealityEventInput): RealityEvent {
    const existing = this.getEvent(input.id);
    if (existing) return existing;
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
    if (Number.isNaN(startedAt.getTime())) {
      throw new RealityError("invalid_started_at", "Invalid reality event start time", 400);
    }
    const activeCaptures = this.db.select().from(realityEvents).where(and(
      eq(realityEvents.status, "ongoing"),
      eq(realityEvents.processingState, "capturing"),
    )).all();
    for (const row of activeCaptures) {
      this.closeInterruptedCapture(row, "采集已被新的录音替代");
    }
    const now = new Date();
    const contextPrompt = input.contextPrompt?.trim() || null;
    this.db.insert(realityEvents).values({
      id: input.id,
      title: input.title?.trim() || contextPrompt?.slice(0, 80) || "未命名感知",
      status: "ongoing",
      processingState: "capturing",
      captureDevice: input.captureDevice,
      processingDevice: "NxCore Gateway",
      audioSource: input.audioSource,
      audioFileName: null,
      audioMimeType: input.audioMimeType ?? null,
      durationMs: 0,
      currentTopic: contextPrompt?.split(/[，,。\n]/)[0]?.slice(0, 50) ?? null,
      transcript: "",
      transcriptSegments: [],
      transcriptEditedAt: null,
      insights: { ...EMPTY_INSIGHTS, currentTopic: contextPrompt },
      markers: [],
      important: false,
      resultVersion: 0,
      version: 1,
      startedAt,
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.publish(input.id, "reality event created");
  }

  finishCapture(id: string, input: FinishRealityCaptureInput): RealityEvent {
    const row = this.requireRow(id);
    return this.update(row, {
      processingState: "saving",
      durationMs: Math.max(0, input.durationMs),
      audioFileName: input.audioFileName,
      endedAt: input.endedAt ? new Date(input.endedAt) : new Date(),
    }, "reality capture finished");
  }

  importEvent(input: ImportRealityEventInput): RealityEvent {
    const startedAt = new Date(input.startedAt);
    const endedAt = new Date(input.endedAt);
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
      throw new RealityError("invalid_import_time", "Invalid imported reality event time", 400);
    }
    const current = this.row(input.id);
    if (current && input.resultVersion <= current.resultVersion) return toEvent(current);

    const fallbackInsights = deriveInsights(input.transcript, null);
    const insights = input.insights ?? fallbackInsights;
    const effectiveInsights = current?.transcriptEditedAt ? current.insights : insights;
    const transcriptSegments: RealityTranscriptSegment[] = input.transcriptSegments.map((segment, index) => ({
      id: `${input.id}:${segment.beginTime}:${index}`,
      ...segment,
      version: input.resultVersion,
      isFinal: true,
      manuallyEdited: false,
    }));
    const imported = {
      title: input.title.trim() || insights.currentTopic || "iPhone 录音",
      status: "completed" as const,
      processingState: "ready" as const,
      captureDevice: input.captureDevice,
      processingDevice: "SaaS",
      audioSource: input.audioSource,
      durationMs: Math.max(0, input.durationMs),
      currentTopic: effectiveInsights.currentTopic,
      transcript: current?.transcriptEditedAt ? current.transcript : input.transcript,
      transcriptSegments: current?.transcriptEditedAt ? current.transcriptSegments : transcriptSegments,
      insights: effectiveInsights,
      asrSource: "saas" as const,
      resultVersion: input.resultVersion,
      error: null,
      startedAt,
      endedAt,
      updatedAt: new Date(),
    };

    let event: RealityEvent;
    if (current) {
      event = this.update(current, imported, "synced reality event imported");
    } else {
      const now = new Date();
      this.db.insert(realityEvents).values({
        id: input.id,
        ...imported,
        audioFileName: null,
        audioMimeType: null,
        transcriptEditedAt: null,
        markers: [],
        important: false,
        asrJobId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }).run();
      event = this.publish(input.id, "synced reality event imported");
    }
    this.notifyReady(event);
    return event;
  }

  applyAsr(id: string, input: ApplyRealityAsrInput): RealityEvent {
    const row = this.requireRow(id);
    const resultVersion = input.resultVersion ?? row.resultVersion + 1;
    if (resultVersion <= row.resultVersion) return toEvent(row);
    if (input.status === "failed" || input.status === "cancelled") {
      return this.update(row, {
        status: "failed",
        processingState: "failed",
        asrJobId: input.jobId,
        asrSource: input.source,
        resultVersion,
        error: input.error || "转写处理失败",
      }, "reality ASR failed");
    }
    if (input.status !== "completed" || !input.result) {
      return this.update(row, {
        status: "ongoing",
        processingState: "transcribing",
        asrJobId: input.jobId,
        asrSource: input.source,
        resultVersion,
        error: null,
      }, "reality ASR updated");
    }
    const transcript = row.transcriptEditedAt ? row.transcript : input.result.transcript;
    const transcriptSegments: RealityTranscriptSegment[] = input.result.segments.map((segment, index) => ({
      id: `${id}:${segment.beginTime}:${index}`,
      ...segment,
      version: resultVersion,
      isFinal: true,
      manuallyEdited: false,
    }));
    const insights = input.source === "saas" && input.result.insights
      ? input.result.insights
      : deriveInsights(transcript, row.currentTopic);
    const event = this.update(row, {
      status: "completed",
      processingState: "ready",
      transcript,
      transcriptSegments,
      insights,
      currentTopic: insights.currentTopic,
      asrJobId: input.jobId,
      asrSource: input.source,
      resultVersion,
      error: null,
    }, "reality ASR completed");
    this.notifyReady(event);
    return event;
  }

  applyAsrByJob(jobId: string, input: ApplyRealityAsrInput): RealityEvent {
    const row = this.db.select().from(realityEvents)
      .where(eq(realityEvents.asrJobId, jobId)).get();
    if (!row) throw new RealityError("reality_event_not_found", "Reality event was not found", 404);
    return this.applyAsr(row.id, input);
  }

  updateTranscript(id: string, input: UpdateRealityTranscriptInput): RealityEvent {
    const row = this.requireRow(id);
    if (row.version !== input.expectedVersion) {
      throw new RealityError("version_conflict", "Reality event changed; reload before saving", 409);
    }
    const transcript = input.transcript.trim();
    const insights = deriveInsights(transcript, row.currentTopic);
    const event = this.update(row, {
      transcript,
      transcriptEditedAt: new Date(),
      insights,
      currentTopic: insights.currentTopic,
    }, "reality transcript edited");
    this.notifyReady(event);
    return event;
  }

  addMarker(id: string, input: MarkRealityEventInput): RealityEvent {
    const row = this.requireRow(id);
    const marker = {
      id: randomUUID(),
      atMs: Math.max(0, Math.min(input.atMs, row.durationMs || input.atMs)),
      label: input.label?.trim() || "重要",
      createdAt: new Date().toISOString(),
    };
    return this.update(row, {
      important: true,
      markers: [...row.markers, marker],
    }, "reality event marked important");
  }

  setImportant(id: string, important: boolean): RealityEvent {
    const row = this.requireRow(id);
    if (important) {
      if (row.important) return toEvent(row);
      return this.addMarker(id, { atMs: row.durationMs });
    }
    if (!row.important) return toEvent(row);
    return this.update(row, {
      important: false,
      markers: [],
    }, "reality event unmarked important");
  }

  confirm(id: string): RealityEvent {
    const row = this.requireRow(id);
    return row.status === "completed"
      ? toEvent(row)
      : this.update(row, { status: "completed" }, "reality event confirmed");
  }

  async discard(id: string): Promise<void> {
    const row = this.requireRow(id);
    const recordingPath = row.audioFileName ? await this.audioPath(id).catch(() => null) : null;
    this.db.delete(realityEvents).where(eq(realityEvents.id, row.id)).run();
    if (recordingPath) await rm(recordingPath, { force: true });
    this.logger?.info({ realityEventId: id }, "reality event discarded");
  }

  fail(id: string, error: string): RealityEvent {
    return this.update(this.requireRow(id), {
      status: "failed",
      processingState: "failed",
      error: error.trim().slice(0, 2_000) || "现实感知处理失败",
      endedAt: new Date(),
    }, "reality event failed");
  }

  async audioPath(id: string): Promise<string> {
    const row = this.requireRow(id);
    if (!row.audioFileName) throw new RealityError("audio_not_found", "Reality event has no audio", 404);
    const root = await realpath(this.recordingsDirectory);
    const candidate = isAbsolute(row.audioFileName)
      ? row.audioFileName
      : resolve(root, row.audioFileName);
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved || relative(root, resolved).startsWith("..")) {
      throw new RealityError("audio_not_found", "Reality event audio was not found", 404);
    }
    return resolved;
  }

  private row(id: string): typeof realityEvents.$inferSelect | null {
    return this.db.select().from(realityEvents).where(eq(realityEvents.id, id)).get() ?? null;
  }

  private closeInterruptedCapture(row: typeof realityEvents.$inferSelect, reason: string): void {
    if (!row.audioFileName) {
      this.db.delete(realityEvents).where(eq(realityEvents.id, row.id)).run();
      this.logger?.info({ realityEventId: row.id }, "empty interrupted reality capture discarded");
      return;
    }
    this.update(row, {
      status: "failed",
      processingState: "failed",
      error: reason,
      endedAt: new Date(),
    }, "interrupted reality capture recovered");
  }

  private requireRow(id: string): typeof realityEvents.$inferSelect {
    const row = this.row(id);
    if (!row) throw new RealityError("reality_event_not_found", "Reality event was not found", 404);
    return row;
  }

  private update(
    row: typeof realityEvents.$inferSelect,
    patch: Partial<typeof realityEvents.$inferInsert>,
    message: string,
  ): RealityEvent {
    this.db.update(realityEvents).set({
      ...patch,
      version: row.version + 1,
      updatedAt: new Date(),
    }).where(eq(realityEvents.id, row.id)).run();
    return this.publish(row.id, message);
  }

  private publish(id: string, message: string): RealityEvent {
    const event = toEvent(this.requireRow(id));
    this.logger?.info({ realityEventId: id, version: event.version, status: event.status }, message);
    this.broker.publish(event);
    return event;
  }

  private notifyReady(event: RealityEvent): void {
    if (!this.readySink || event.processingState !== "ready") return;
    void this.readySink(event).catch((error: unknown) => {
      this.logger?.warn({
        realityEventId: event.id,
        version: event.version,
        err: error instanceof Error ? error.message : String(error),
      }, "ready reality event downstream ingest failed");
    });
  }
}
