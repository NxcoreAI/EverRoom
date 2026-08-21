import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, lte, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { RealityTag } from "@nxcore/reality-contract";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  diaryVersionSources,
  documentVersions,
  documents,
  perceptionSettings,
  parsedContents,
  realityEvents,
  uploadedFiles,
  visualNodes,
  visualObservations,
  visualProcessingJobs,
} from "../../infrastructure/database/schema.js";
import type { FilesService } from "../files/service.js";
import { insightEvidenceMarkdown, normalizeInsightTags } from "../reality/insight-tags.js";
import type { VisualInferenceClient, VisualInferenceResult } from "./vlm-client.js";
import {
  screenshotContinuityMs,
  shouldGroupScreenshot,
  shouldRefreshRepresentative,
} from "./visual-segmentation.js";

const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
const LEASE_MS = 90_000;

export interface VisualObservationInput {
  fileId: string;
  kind: "screenshot" | "photo";
  capturedAt: Date;
  perceptualHash?: string;
  width?: number;
  height?: number;
}

export interface VisualReadyEvidence {
  sourceId: string;
  sourceVersion: number;
  title: string;
  markdown: string;
  occurredAt: string;
}

export type PerceptionNodeKind = "audio" | "screenshot" | "photo" | "document" | "file";

export interface PerceptionNodeDto {
  id: string;
  kind: PerceptionNodeKind;
  startAt: string;
  endAt: string;
  title: string;
  summary: string;
  status: string;
  eventType: string | null;
  tags: string[];
  keyPoints: string[];
  insightTags: RealityTag[];
  confidence: number | null;
  model: string | null;
  error: string | null;
  sampleCount: number;
  mediaFileId: string | null;
}

function textFromJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromJson).filter(Boolean).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(textFromJson).filter(Boolean).join(" ");
  return "";
}

function nodeDto(
  node: typeof visualNodes.$inferSelect,
  representativeFileId: string | null,
): PerceptionNodeDto {
  const insightTags = normalizeInsightTags(node.representativeTags);
  return {
    id: node.id,
    kind: node.kind,
    startAt: node.startAt.toISOString(),
    endAt: node.endAt.toISOString(),
    title: node.title ?? (node.kind === "photo" ? "照片" : "屏幕活动"),
    summary: node.summary ?? "等待视觉理解",
    status: node.vlmStatus,
    eventType: node.eventType ?? null,
    tags: insightTags.map((tag) => tag.label),
    keyPoints: node.keyPoints,
    insightTags,
    confidence: node.confidence ?? null,
    model: node.model ?? null,
    error: node.error ?? null,
    sampleCount: node.sampleCount,
    mediaFileId: representativeFileId,
  };
}

export class PerceptionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly instanceId = randomUUID();
  private readonly running = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readySink: ((evidence: VisualReadyEvidence) => Promise<void>) | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly files: FilesService,
    private readonly vlm: VisualInferenceClient | null,
    private readonly logger: FastifyBaseLogger,
    private readonly markDiaryStale?: (at: Date) => void,
  ) {}

  setReadySink(sink: ((evidence: VisualReadyEvidence) => Promise<void>) | null): void {
    this.readySink = sink;
  }

  initialize(): void {
    this.ensureSettings();
    this.recoverExpiredJobs();
    this.timer = setInterval(() => void this.tick(), 2_000);
    this.timer.unref?.();
    void this.tick();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.abortControllers.values()) controller.abort();
    await Promise.allSettled(this.running.values());
  }

  settings() {
    return this.ensureSettings();
  }

  updateSettings(input: {
    captureEnabled?: boolean;
    captureIntervalSeconds?: number;
    onlineVlmEnabled?: boolean;
    configVersion: number;
  }) {
    const current = this.ensureSettings();
    if (current.configVersion !== input.configVersion) throw new Error("perception_settings_conflict");
    if (input.onlineVlmEnabled === true && !this.vlm) throw new Error("vlm_not_configured");
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(perceptionSettings).set({
        ...(input.captureEnabled === undefined ? {} : { captureEnabled: input.captureEnabled }),
        ...(input.captureIntervalSeconds === undefined ? {} : { captureIntervalSeconds: input.captureIntervalSeconds }),
        ...(input.onlineVlmEnabled === undefined ? {} : { onlineVlmEnabled: input.onlineVlmEnabled }),
        configVersion: current.configVersion + 1,
        updatedAt: now,
      }).where(eq(perceptionSettings.ownerId, "local-user")).run();
      if (input.onlineVlmEnabled === true && !current.onlineVlmEnabled) {
        const disabled = tx.select({ id: visualNodes.id }).from(visualNodes).where(and(
          eq(visualNodes.vlmStatus, "disabled"),
          isNull(visualNodes.deletedAt),
        )).all();
        for (const node of disabled) {
          tx.update(visualNodes).set({ vlmStatus: "pending", error: null, updatedAt: now })
            .where(eq(visualNodes.id, node.id)).run();
          tx.insert(visualProcessingJobs).values({
            id: `visual-job-${randomUUID()}`,
            nodeId: node.id,
            status: "pending",
            attempt: 0,
            nextAttemptAt: now,
          }).onConflictDoUpdate({
            target: visualProcessingJobs.nodeId,
            set: {
              status: "pending", attempt: 0, nextAttemptAt: now,
              leaseOwner: null, leaseExpiresAt: null, error: null, updatedAt: now,
            },
          }).run();
        }
      }
    });
    if (input.onlineVlmEnabled === false) {
      for (const controller of this.abortControllers.values()) controller.abort();
    }
    if (input.onlineVlmEnabled === true) void this.tick();
    return this.ensureSettings();
  }

  registerObservation(input: VisualObservationInput): { observationId: string; node: PerceptionNodeDto; grouped: boolean } {
    const file = this.files.get(input.fileId);
    if (!file) throw new Error("file_not_found");
    if (!file.mime.startsWith("image/")) throw new Error("visual_file_must_be_image");
    if (input.kind === "screenshot" && !/^[0-9a-f]{16}$/i.test(input.perceptualHash ?? "")) {
      throw new Error("screenshot_perceptual_hash_required");
    }
    const existingObservation = this.db.select().from(visualObservations)
      .where(eq(visualObservations.fileId, input.fileId)).get();
    if (existingObservation) {
      const existingNode = this.requireVisualNode(existingObservation.nodeId);
      return { observationId: existingObservation.id, node: this.dtoForVisual(existingNode), grouped: existingNode.sampleCount > 1 };
    }

    const settings = this.ensureSettings();
    const continuityMs = screenshotContinuityMs(settings.captureIntervalSeconds);
    const latest = input.kind === "screenshot"
      ? this.db.select().from(visualNodes).where(and(
          eq(visualNodes.kind, "screenshot"),
          isNull(visualNodes.deletedAt),
          gte(visualNodes.endAt, new Date(input.capturedAt.getTime() - continuityMs)),
          lte(visualNodes.endAt, input.capturedAt),
        )).orderBy(desc(visualNodes.endAt)).get()
      : undefined;
    const grouped = Boolean(latest && input.perceptualHash && shouldGroupScreenshot({
      nodeStartAt: latest.startAt,
      nodeEndAt: latest.endAt,
      capturedAt: input.capturedAt,
      previousHash: latest.latestPerceptualHash,
      currentHash: input.perceptualHash,
      continuityMs,
    }));
    const nodeId = grouped ? latest!.id : `visual-${randomUUID()}`;
    const observationId = `observation-${randomUUID()}`;
    const now = new Date();
    const representative = grouped && latest!.representativeObservationId
      ? this.db.select().from(visualObservations)
          .where(eq(visualObservations.id, latest!.representativeObservationId)).get()
      : null;
    const refreshRepresentative = grouped && shouldRefreshRepresentative({
      capturedAt: input.capturedAt,
      representativeCapturedAt: representative?.capturedAt ?? null,
    });
    const shouldProcess = settings.onlineVlmEnabled && this.vlm !== null;
    const existingJob = refreshRepresentative
      ? this.db.select().from(visualProcessingJobs).where(eq(visualProcessingJobs.nodeId, nodeId)).get()
      : null;

    this.db.transaction((tx) => {
      if (grouped) {
        tx.update(visualNodes).set({
          endAt: input.capturedAt,
          sampleCount: latest!.sampleCount + 1,
          latestPerceptualHash: input.perceptualHash,
          ...(refreshRepresentative ? {
            representativeObservationId: observationId,
            vlmStatus: shouldProcess ? "pending" as const : "disabled" as const,
            error: null,
          } : {}),
          updatedAt: now,
        }).where(eq(visualNodes.id, nodeId)).run();
        if (refreshRepresentative && shouldProcess) {
          if (!existingJob) {
            tx.insert(visualProcessingJobs).values({
              id: `visual-job-${randomUUID()}`,
              nodeId,
              status: "pending",
              nextAttemptAt: now,
            }).run();
          } else if (existingJob.status !== "running") {
            tx.update(visualProcessingJobs).set({
              status: "pending", attempt: 0, nextAttemptAt: now,
              leaseOwner: null, leaseExpiresAt: null, error: null, updatedAt: now,
            }).where(eq(visualProcessingJobs.id, existingJob.id)).run();
          }
        }
      } else {
        tx.insert(visualNodes).values({
          id: nodeId,
          kind: input.kind,
          startAt: input.capturedAt,
          endAt: input.capturedAt,
          sampleCount: 1,
          representativeObservationId: observationId,
          latestPerceptualHash: input.perceptualHash ?? null,
          vlmStatus: shouldProcess ? "pending" : "disabled",
        }).run();
        if (shouldProcess) {
          tx.insert(visualProcessingJobs).values({
            id: `visual-job-${randomUUID()}`,
            nodeId,
            status: "pending",
            nextAttemptAt: now,
          }).run();
        }
      }
      tx.insert(visualObservations).values({
        id: observationId,
        nodeId,
        fileId: input.fileId,
        kind: input.kind,
        capturedAt: input.capturedAt,
        perceptualHash: input.perceptualHash ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
      }).run();
      tx.update(uploadedFiles).set({
        assetKind: input.kind,
        originChannel: input.kind === "screenshot" ? "everroom-window-capture" : "photo-import",
        visibility: "private",
        capturedAt: input.capturedAt,
        updatedAt: now,
      }).where(eq(uploadedFiles.id, input.fileId)).run();
    });
    this.markDiaryStale?.(input.capturedAt);
    const node = this.requireVisualNode(nodeId);
    if (!grouped || (refreshRepresentative && shouldProcess)) void this.tick();
    return { observationId, node: this.dtoForVisual(node), grouped };
  }

  list(input: { from?: Date; to?: Date; kind?: string; status?: string }): PerceptionNodeDto[] {
    const visualConditions = [isNull(visualNodes.deletedAt)];
    if (input.from) visualConditions.push(gte(visualNodes.endAt, input.from));
    if (input.to) visualConditions.push(lt(visualNodes.startAt, input.to));
    if (input.kind === "screenshot" || input.kind === "photo") visualConditions.push(eq(visualNodes.kind, input.kind));
    if (input.status) visualConditions.push(eq(visualNodes.vlmStatus, input.status as typeof visualNodes.$inferSelect.vlmStatus));
    const visual = input.kind && input.kind !== "screenshot" && input.kind !== "photo" ? [] : this.db.select().from(visualNodes)
      .where(and(...visualConditions)).orderBy(asc(visualNodes.startAt)).all().map((node) => this.dtoForVisual(node));

    const audioConditions = [];
    if (input.from) audioConditions.push(gte(realityEvents.startedAt, input.from));
    if (input.to) audioConditions.push(lt(realityEvents.startedAt, input.to));
    if (input.status) audioConditions.push(eq(realityEvents.processingState, input.status as typeof realityEvents.$inferSelect.processingState));
    const audio: PerceptionNodeDto[] = input.kind && input.kind !== "audio" ? []
      : this.db.select().from(realityEvents).where(audioConditions.length ? and(...audioConditions) : undefined)
        .orderBy(asc(realityEvents.startedAt)).all().map((event) => ({
          id: event.id,
          kind: "audio",
          startAt: event.startedAt.toISOString(),
          endAt: (event.endedAt ?? event.startedAt).toISOString(),
          title: event.title,
          summary: event.currentTopic ?? event.insights.summary ?? event.transcript.slice(0, 240),
          status: event.processingState,
          eventType: event.insights.eventType ?? null,
          tags: normalizeInsightTags(event.insights.representativeTags).map((tag) => tag.label),
          keyPoints: event.insights.keyPoints ?? [],
          insightTags: normalizeInsightTags(event.insights.representativeTags),
          confidence: null,
          model: null,
          error: event.error,
          sampleCount: 1,
          mediaFileId: null,
        }));
    const documentConditions = [];
    if (input.from) documentConditions.push(gte(documentVersions.createdAt, input.from));
    if (input.to) documentConditions.push(lt(documentVersions.createdAt, input.to));
    const documentsNodes: PerceptionNodeDto[] = (
      (input.kind && input.kind !== "document") || (input.status && input.status !== "ready")
    ) ? [] : (
      this.db.select().from(documentVersions)
        .where(documentConditions.length ? and(...documentConditions) : undefined)
        .orderBy(asc(documentVersions.createdAt)).all().map((version) => {
          const document = this.db.select({ title: documents.title }).from(documents)
            .where(eq(documents.id, version.documentId)).get();
          const content = textFromJson(version.contentJson);
          return {
            id: `document_version:${version.id}`,
            kind: "document",
            startAt: version.createdAt.toISOString(),
            endAt: version.createdAt.toISOString(),
            title: version.title || document?.title || "文档",
            summary: content.slice(0, 240),
            status: "ready",
            eventType: null,
            tags: [],
            keyPoints: [],
            insightTags: [],
            confidence: null,
            model: null,
            error: null,
            sampleCount: 1,
            mediaFileId: null,
          } satisfies PerceptionNodeDto;
        })
      );
    const fileNodes: PerceptionNodeDto[] = (
      (input.kind && input.kind !== "file") || (input.status && !["ready", "processing"].includes(input.status))
    ) ? [] : (
      this.db.select().from(uploadedFiles).all()
        .filter((file) => file.assetKind !== "screenshot" && file.assetKind !== "photo")
        .filter((file) => {
          const occurredAt = file.capturedAt ?? file.updatedAt;
          return (!input.from || occurredAt >= input.from) && (!input.to || occurredAt < input.to);
        })
        .sort((left, right) => (left.capturedAt ?? left.updatedAt).getTime() - (right.capturedAt ?? right.updatedAt).getTime())
        .map((file) => {
          const content = file.currentParsedId
            ? this.db.select({ markdown: parsedContents.markdown }).from(parsedContents)
              .where(eq(parsedContents.id, file.currentParsedId)).get()?.markdown ?? ""
            : "";
          const occurredAt = file.capturedAt ?? file.updatedAt;
          return {
            id: `file:${file.id}`,
            kind: "file",
            startAt: occurredAt.toISOString(),
            endAt: occurredAt.toISOString(),
            title: file.originalName,
            summary: content.slice(0, 240) || file.originalName,
            status: file.currentParsedId ? "ready" : "processing",
            eventType: null,
            tags: [],
            keyPoints: [],
            insightTags: [],
            confidence: null,
            model: null,
            error: null,
            sampleCount: 1,
            mediaFileId: file.id,
          } satisfies PerceptionNodeDto;
        })
        .filter((node) => !input.status || node.status === input.status)
      );
    return [...visual, ...audio, ...documentsNodes, ...fileNodes].sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  detail(id: string) {
    const node = this.db.select().from(visualNodes).where(and(eq(visualNodes.id, id), isNull(visualNodes.deletedAt))).get();
    if (node) {
      return {
        ...this.dtoForVisual(node),
        observations: this.db.select().from(visualObservations)
          .where(eq(visualObservations.nodeId, id)).orderBy(asc(visualObservations.capturedAt)).all()
          .map((row) => ({ ...row, capturedAt: row.capturedAt.toISOString(), createdAt: row.createdAt.toISOString() })),
      };
    }
    const reality = this.db.select().from(realityEvents).where(eq(realityEvents.id, id)).get();
    return reality ? this.list({ kind: "audio" }).find((item) => item.id === id) ?? null : null;
  }

  retry(id: string): void {
    const node = this.requireVisualNode(id);
    if (!this.vlm) throw new Error("vlm_not_configured");
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(visualNodes).set({ vlmStatus: "pending", error: null, updatedAt: now })
        .where(eq(visualNodes.id, node.id)).run();
      tx.insert(visualProcessingJobs).values({
        id: `visual-job-${randomUUID()}`,
        nodeId: node.id,
        status: "pending",
        attempt: 0,
        nextAttemptAt: now,
      }).onConflictDoUpdate({ target: visualProcessingJobs.nodeId, set: {
        status: "pending", attempt: 0, nextAttemptAt: now, leaseOwner: null, leaseExpiresAt: null, error: null,
      } }).run();
    });
    void this.tick();
  }

  async delete(id: string, deleteAssets: boolean): Promise<{ deleted: boolean; deletedAssets: string[]; retainedAssets: string[] }> {
    const node = this.requireVisualNode(id);
    const observations = this.db.select().from(visualObservations).where(eq(visualObservations.nodeId, id)).all();
    this.db.update(visualNodes).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(visualNodes.id, id)).run();
    this.markDiaryStale?.(node.startAt);
    if (!deleteAssets) return { deleted: true, deletedAssets: [], retainedAssets: observations.map((item) => item.fileId) };
    const deletedAssets: string[] = [];
    const retainedAssets: string[] = [];
    for (const observation of observations) {
      const diaryReference = this.db.select({ id: diaryVersionSources.sourceId }).from(diaryVersionSources)
        .where(eq(diaryVersionSources.assetFileId, observation.fileId)).get();
      const otherObservation = this.db.select({ id: visualObservations.id }).from(visualObservations)
        .innerJoin(visualNodes, eq(visualObservations.nodeId, visualNodes.id))
        .where(and(eq(visualObservations.fileId, observation.fileId), isNull(visualNodes.deletedAt))).get();
      if (diaryReference || otherObservation) {
        retainedAssets.push(observation.fileId);
        continue;
      }
      this.db.delete(visualObservations).where(eq(visualObservations.id, observation.id)).run();
      try {
        const result = await this.files.deleteFile(observation.fileId);
        if (result) deletedAssets.push(observation.fileId);
        else retainedAssets.push(observation.fileId);
      } catch {
        retainedAssets.push(observation.fileId);
      }
    }
    this.db.update(visualNodes).set({ representativeObservationId: null, updatedAt: new Date() })
      .where(eq(visualNodes.id, id)).run();
    return { deleted: true, deletedAssets, retainedAssets };
  }

  private ensureSettings() {
    let row = this.db.select().from(perceptionSettings).where(eq(perceptionSettings.ownerId, "local-user")).get();
    if (!row) {
      this.db.insert(perceptionSettings).values({ ownerId: "local-user" }).run();
      row = this.db.select().from(perceptionSettings).where(eq(perceptionSettings.ownerId, "local-user")).get();
    }
    return row!;
  }

  private requireVisualNode(id: string) {
    const node = this.db.select().from(visualNodes).where(and(eq(visualNodes.id, id), isNull(visualNodes.deletedAt))).get();
    if (!node) throw new Error("perception_node_not_found");
    return node;
  }

  private dtoForVisual(node: typeof visualNodes.$inferSelect): PerceptionNodeDto {
    const observation = node.representativeObservationId
      ? this.db.select().from(visualObservations).where(eq(visualObservations.id, node.representativeObservationId)).get()
      : null;
    return nodeDto(node, observation?.fileId ?? null);
  }

  private recoverExpiredJobs(): void {
    const now = new Date();
    this.db.update(visualProcessingJobs).set({ status: "pending", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(visualProcessingJobs.status, "running"), or(isNull(visualProcessingJobs.leaseExpiresAt), lt(visualProcessingJobs.leaseExpiresAt, now)))).run();
  }

  private async tick(): Promise<void> {
    if (!this.vlm || !this.ensureSettings().onlineVlmEnabled) return;
    const available = 2 - this.running.size;
    if (available <= 0) return;
    const now = new Date();
    const due = this.db.select().from(visualProcessingJobs).where(and(
      eq(visualProcessingJobs.status, "pending"), lte(visualProcessingJobs.nextAttemptAt, now),
    )).orderBy(asc(visualProcessingJobs.nextAttemptAt)).limit(available).all();
    for (const job of due) {
      const claimed = this.db.update(visualProcessingJobs).set({
        status: "running", leaseOwner: this.instanceId,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS), updatedAt: now,
      }).where(and(eq(visualProcessingJobs.id, job.id), eq(visualProcessingJobs.status, "pending"))).run();
      if (claimed.changes !== 1) continue;
      const controller = new AbortController();
      this.abortControllers.set(job.id, controller);
      const processing = this.process(job.id, controller.signal).finally(() => {
        this.running.delete(job.id);
        this.abortControllers.delete(job.id);
        void this.tick();
      });
      this.running.set(job.id, processing);
    }
  }

  private async process(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.db.select().from(visualProcessingJobs).where(eq(visualProcessingJobs.id, jobId)).get();
    if (!job || !this.vlm) return;
    let processedObservationId: string | null = null;
    try {
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
      const node = this.requireVisualNode(job.nodeId);
      if (!node.representativeObservationId) throw new Error("visual node has no representative observation");
      const observation = this.db.select().from(visualObservations)
        .where(eq(visualObservations.id, node.representativeObservationId)).get();
      if (!observation) throw new Error("representative observation is missing");
      processedObservationId = observation.id;
      const image = await this.files.contentOf(observation.fileId);
      if (!image) throw new Error("representative image is missing");
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
      this.db.update(visualNodes).set({ vlmStatus: "processing", updatedAt: new Date() })
        .where(eq(visualNodes.id, node.id)).run();
      const result = await this.vlm.infer({ buffer: image.buffer, mime: image.mime }, signal);
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
      if (!this.complete(job, result, observation.id)) return;
      this.markDiaryStale?.(node.startAt);
      this.notifyReady(node.id);
    } catch (error) {
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
      if (processedObservationId && this.requeueSupersededJob(job, processedObservationId)) return;
      this.fail(job, error);
    }
  }

  private pause(job: typeof visualProcessingJobs.$inferSelect): void {
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(visualProcessingJobs).set({
        status: "pending", nextAttemptAt: now, leaseOwner: null, leaseExpiresAt: null,
        error: null, updatedAt: now,
      }).where(eq(visualProcessingJobs.id, job.id)).run();
      tx.update(visualNodes).set({ vlmStatus: "pending", error: null, updatedAt: now })
        .where(eq(visualNodes.id, job.nodeId)).run();
    });
  }

  private complete(
    job: typeof visualProcessingJobs.$inferSelect,
    result: VisualInferenceResult,
    processedObservationId: string,
  ): boolean {
    const now = new Date();
    if (this.requeueSupersededJob(job, processedObservationId)) return false;
    const node = this.requireVisualNode(job.nodeId);
    this.db.transaction((tx) => {
      tx.update(visualNodes).set({
        vlmStatus: "ready", eventType: result.eventType, title: result.title, summary: result.summary,
        keyPoints: result.keyPoints, representativeTags: result.representativeTags,
        confidence: result.confidence, model: this.vlm?.model ?? null,
        resultVersion: node.resultVersion + 1, error: null, updatedAt: now,
      }).where(eq(visualNodes.id, job.nodeId)).run();
      tx.update(visualProcessingJobs).set({
        status: "completed", leaseOwner: null, leaseExpiresAt: null, error: null, updatedAt: now,
      }).where(eq(visualProcessingJobs.id, job.id)).run();
    });
    return true;
  }

  private requeueSupersededJob(
    job: typeof visualProcessingJobs.$inferSelect,
    processedObservationId: string,
  ): boolean {
    const node = this.requireVisualNode(job.nodeId);
    if (node.representativeObservationId === processedObservationId) return false;
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(visualNodes).set({ vlmStatus: "pending", error: null, updatedAt: now })
        .where(eq(visualNodes.id, job.nodeId)).run();
      tx.update(visualProcessingJobs).set({
        status: "pending", attempt: 0, nextAttemptAt: now,
        leaseOwner: null, leaseExpiresAt: null, error: null, updatedAt: now,
      }).where(eq(visualProcessingJobs.id, job.id)).run();
    });
    return true;
  }

  private fail(job: typeof visualProcessingJobs.$inferSelect, error: unknown): void {
    const now = new Date();
    const attempt = job.attempt + 1;
    const delay = RETRY_DELAYS_MS[attempt - 1];
    const message = error instanceof Error ? error.message.slice(0, 1_000) : "Unknown VLM error";
    const retrying = delay !== undefined;
    this.db.transaction((tx) => {
      tx.update(visualProcessingJobs).set({
        status: retrying ? "pending" : "failed", attempt,
        nextAttemptAt: new Date(now.getTime() + (delay ?? 0)),
        leaseOwner: null, leaseExpiresAt: null, error: message, updatedAt: now,
      }).where(eq(visualProcessingJobs.id, job.id)).run();
      tx.update(visualNodes).set({ vlmStatus: retrying ? "pending" : "failed", error: message, updatedAt: now })
        .where(eq(visualNodes.id, job.nodeId)).run();
    });
    this.logger.warn({ jobId: job.id, nodeId: job.nodeId, attempt, retrying, err: message }, "visual inference failed");
  }

  private notifyReady(nodeId: string): void {
    if (!this.readySink) return;
    const node = this.requireVisualNode(nodeId);
    const title = node.title ?? (node.kind === "photo" ? "照片" : "屏幕活动");
    const evidence: VisualReadyEvidence = {
      sourceId: node.id,
      sourceVersion: node.resultVersion,
      title,
      occurredAt: node.startAt.toISOString(),
      markdown: insightEvidenceMarkdown({
        title,
        eventType: node.eventType,
        summary: node.summary,
        keyPoints: node.keyPoints,
        tags: normalizeInsightTags(node.representativeTags),
      }),
    };
    void this.readySink(evidence).catch((error: unknown) => {
      this.logger.warn({
        nodeId,
        version: node.resultVersion,
        err: error instanceof Error ? error.message : String(error),
      }, "ready visual event downstream ingest failed");
    });
  }
}
