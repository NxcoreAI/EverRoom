import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";
import { AsrError } from "./errors.js";
import type { AsrJob, AsrProvider, SubmitAsrInput } from "./types.js";

interface AsrJobPayload {
  provider: string;
  filePath: string;
  fileName: string;
  languageHints: string[];
  diarizationEnabled: boolean;
  contextPrompt: string;
  remoteTaskId?: string;
}

function payloadOf(value: unknown): AsrJobPayload {
  return value as AsrJobPayload;
}

function toAsrJob(row: typeof jobs.$inferSelect): AsrJob {
  const payload = payloadOf(row.payload);
  const error = row.error as { message?: unknown } | null;
  return {
    id: row.id,
    provider: payload.provider,
    status: row.status,
    fileName: payload.fileName,
    languageHints: payload.languageHints,
    diarizationEnabled: payload.diarizationEnabled,
    contextPrompt: payload.contextPrompt ?? "",
    result: row.result,
    error: typeof error?.message === "string" ? error.message : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AsrService {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly inputDir: string,
    private provider: AsrProvider | null,
    private readonly logger?: Logger,
  ) {}

  replaceProvider(provider: AsrProvider | null): void {
    this.provider = provider;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.inFlight);
  }

  async createJob(input: Omit<SubmitAsrInput, "filePath"> & { filePath: string }): Promise<AsrJob> {
    if (!this.provider) {
      throw new AsrError("asr_not_configured", "ASR provider is not configured", 503);
    }
    const filePath = await this.resolveInputPath(input.filePath);
    const id = randomUUID();
    const now = new Date();
    const payload: AsrJobPayload = {
      provider: this.provider.id,
      filePath,
      fileName: basename(filePath),
      languageHints: input.languageHints ?? [],
      diarizationEnabled: input.diarizationEnabled,
      contextPrompt: input.contextPrompt?.trim() ?? "",
    };
    this.db.insert(jobs).values({
      id,
      type: "asr.transcription",
      status: "pending",
      payload,
      createdAt: now,
      updatedAt: now,
    }).run();

    this.logger?.info({
      asrJobId: id,
      provider: payload.provider,
      fileName: payload.fileName,
    }, "ASR job created");

    this.track(this.submit(id));
    return this.getStoredJob(id)!;
  }

  async getJob(id: string): Promise<AsrJob | null> {
    const row = this.getStoredRow(id);
    if (!row) return null;
    const payload = payloadOf(row.payload);
    if (row.status === "running" && payload.remoteTaskId && this.provider) {
      await this.refresh(id, payload.remoteTaskId);
    }
    return this.getStoredJob(id);
  }

  private async submit(id: string): Promise<void> {
    const row = this.getStoredRow(id);
    if (!row || !this.provider) return;
    const payload = payloadOf(row.payload);
    try {
      const submitted = await this.provider.submit({
        filePath: payload.filePath,
        languageHints: payload.languageHints,
        diarizationEnabled: payload.diarizationEnabled,
        contextPrompt: payload.contextPrompt,
      });
      this.db.update(jobs).set({
        status: "running",
        payload: { ...payload, remoteTaskId: submitted.taskId },
        updatedAt: new Date(),
      }).where(eq(jobs.id, id)).run();
      this.logger?.info({
        asrJobId: id,
        remoteTaskId: submitted.taskId,
      }, "ASR job submitted");
    } catch (error) {
      this.markFailed(id, error);
    }
  }

  private async refresh(id: string, remoteTaskId: string): Promise<void> {
    if (!this.provider) return;
    try {
      const snapshot = await this.provider.getTask(remoteTaskId);
      if (snapshot.status === "running") return;
      this.db.update(jobs).set({
        status: snapshot.status,
        result: snapshot.result ?? null,
        error: snapshot.error ? { message: snapshot.error } : null,
        updatedAt: new Date(),
      }).where(eq(jobs.id, id)).run();
      this.logger?.info({
        asrJobId: id,
        remoteTaskId,
        status: snapshot.status,
        ...(snapshot.error ? { error: snapshot.error } : {}),
      }, "ASR job reached terminal state");
    } catch (error) {
      this.markFailed(id, error);
    }
  }

  private markFailed(id: string, error: unknown): void {
    const message = error instanceof Error ? error.message : "ASR submission failed";
    this.db.update(jobs).set({
      status: "failed",
      error: { message },
      updatedAt: new Date(),
    }).where(eq(jobs.id, id)).run();
    this.logger?.error({ err: error, asrJobId: id }, "ASR job failed");
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private getStoredRow(id: string): typeof jobs.$inferSelect | null {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
  }

  private getStoredJob(id: string): AsrJob | null {
    const row = this.getStoredRow(id);
    return row && row.type === "asr.transcription" ? toAsrJob(row) : null;
  }

  private async resolveInputPath(requestedPath: string): Promise<string> {
    await mkdir(this.inputDir, { recursive: true });
    const inputRoot = await realpath(this.inputDir);
    const candidate = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(inputRoot, requestedPath);
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch (cause) {
      throw new AsrError("asr_file_not_found", "Recording file was not found", 404, { cause });
    }
    const fromRoot = relative(inputRoot, resolved);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new AsrError(
        "asr_file_outside_input_directory",
        "Recording file must be inside the gateway recordings directory",
        400,
      );
    }
    const fileStat = await stat(resolved);
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw new AsrError("asr_invalid_file", "Recording must be a non-empty file", 400);
    }
    return resolved;
  }
}
