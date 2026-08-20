import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, lte, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  diaryVersionSources,
  perceptionSettings,
  realityEvents,
  uploadedFiles,
  visualNodes,
  visualObservations,
  visualProcessingJobs,
} from "../../infrastructure/database/schema.js";
import type { FilesService } from "../files/service.js";
import type { VisualInferenceClient, VisualInferenceResult } from "./vlm-client.js";

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

export interface PerceptionNodeDto {
  id: string;
  kind: "audio" | "screenshot" | "photo";
  startAt: string;
  endAt: string;
  title: string;
  summary: string;
  status: string;
  eventType: string | null;
  tags: string[];
  confidence: number | null;
  model: string | null;
  error: string | null;
  sampleCount: number;
  mediaFileId: string | null;
}

function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 65;
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

function nodeDto(
  node: typeof visualNodes.$inferSelect,
  representativeFileId: string | null,
): PerceptionNodeDto {
  return {
    id: node.id,
    kind: node.kind,
    startAt: node.startAt.toISOString(),
    endAt: node.endAt.toISOString(),
    title: node.title ?? (node.kind === "photo" ? "照片" : "屏幕活动"),
    summary: node.summary ?? "等待视觉理解",
    status: node.vlmStatus,
    eventType: node.eventType ?? null,
    tags: node.representativeTags,
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

  constructor(
    private readonly db: GatewayDatabase,
    private readonly files: FilesService,
    private readonly vlm: VisualInferenceClient | null,
    private readonly logger: FastifyBaseLogger,
    private readonly markDiaryStale?: (at: Date) => void,
  ) {}

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
    const continuityMs = Math.min(
      7_200_000,
      Math.max(settings.captureIntervalSeconds * 2_000, 600_000),
    );
    const latest = input.kind === "screenshot"
      ? this.db.select().from(visualNodes).where(and(
          eq(visualNodes.kind, "screenshot"),
          isNull(visualNodes.deletedAt),
          gte(visualNodes.endAt, new Date(input.capturedAt.getTime() - continuityMs)),
          lte(visualNodes.endAt, input.capturedAt),
        )).orderBy(desc(visualNodes.endAt)).get()
      : undefined;
    const grouped = Boolean(latest?.latestPerceptualHash
      && input.perceptualHash
      && hammingDistance(latest.latestPerceptualHash, input.perceptualHash) <= 6);
    const nodeId = grouped ? latest!.id : `visual-${randomUUID()}`;
    const observationId = `observation-${randomUUID()}`;
    const now = new Date();

    this.db.transaction((tx) => {
      if (grouped) {
        tx.update(visualNodes).set({
          endAt: input.capturedAt,
          sampleCount: latest!.sampleCount + 1,
          latestPerceptualHash: input.perceptualHash,
          updatedAt: now,
        }).where(eq(visualNodes.id, nodeId)).run();
      } else {
        const shouldProcess = settings.onlineVlmEnabled && this.vlm !== null;
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
    if (!grouped) void this.tick();
    return { observationId, node: this.dtoForVisual(node), grouped };
  }

  list(input: { from?: Date; to?: Date; kind?: string; status?: string }): PerceptionNodeDto[] {
    const visualConditions = [isNull(visualNodes.deletedAt)];
    if (input.from) visualConditions.push(gte(visualNodes.endAt, input.from));
    if (input.to) visualConditions.push(lt(visualNodes.startAt, input.to));
    if (input.kind === "screenshot" || input.kind === "photo") visualConditions.push(eq(visualNodes.kind, input.kind));
    if (input.status) visualConditions.push(eq(visualNodes.vlmStatus, input.status as typeof visualNodes.$inferSelect.vlmStatus));
    const visual = input.kind === "audio" ? [] : this.db.select().from(visualNodes)
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
          tags: event.insights.keyPoints ?? [],
          confidence: null,
          model: null,
          error: event.error,
          sampleCount: 1,
          mediaFileId: null,
        }));
    return [...visual, ...audio].sort((a, b) => a.startAt.localeCompare(b.startAt));
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
      });
      this.running.set(job.id, processing);
    }
  }

  private async process(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.db.select().from(visualProcessingJobs).where(eq(visualProcessingJobs.id, jobId)).get();
    if (!job || !this.vlm) return;
    try {
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
      const node = this.requireVisualNode(job.nodeId);
      if (!node.representativeObservationId) throw new Error("visual node has no representative observation");
      const observation = this.db.select().from(visualObservations)
        .where(eq(visualObservations.id, node.representativeObservationId)).get();
      if (!observation) throw new Error("representative observation is missing");
      const image = await this.files.contentOf(observation.fileId);
      if (!image) throw new Error("representative image is missing");
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
      this.db.update(visualNodes).set({ vlmStatus: "processing", updatedAt: new Date() })
        .where(eq(visualNodes.id, node.id)).run();
      const result = await this.vlm.infer({ buffer: image.buffer, mime: image.mime }, signal);
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
      this.complete(job, result);
      this.markDiaryStale?.(node.startAt);
    } catch (error) {
      if (signal.aborted || !this.ensureSettings().onlineVlmEnabled) return this.pause(job);
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

  private complete(job: typeof visualProcessingJobs.$inferSelect, result: VisualInferenceResult): void {
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(visualNodes).set({
        vlmStatus: "ready", eventType: result.eventType, title: result.title, summary: result.summary,
        keyPoints: result.keyPoints, representativeTags: result.representativeTags,
        confidence: result.confidence, model: this.vlm?.model ?? null,
        resultVersion: 1, error: null, updatedAt: now,
      }).where(eq(visualNodes.id, job.nodeId)).run();
      tx.update(visualProcessingJobs).set({
        status: "completed", leaseOwner: null, leaseExpiresAt: null, error: null, updatedAt: now,
      }).where(eq(visualProcessingJobs.id, job.id)).run();
    });
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
}
