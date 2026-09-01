import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";

/**
 * Writing style 增量管线的 job 类型（docs/writing-style-profile-plan.zh-CN.md §10）。
 * 与 documents 的 outbox job 同表不同 type，由 WritingStyleWorker 独立消费。
 */
export const WRITING_STYLE_EXTRACT_JOB_TYPE = "writing-style.extract";
export const WRITING_STYLE_REFRESH_JOB_TYPE = "writing-style.refresh";

export interface WritingStyleExtractJobPayload {
  documentId: string;
  roomId: string;
  version: number;
  attempts: number;
}

/** 每文档单键：新版本入队前先淘汰未处理的旧版本 job（调用方在事务内执行）。 */
export function enqueueWritingStyleExtract(
  tx: GatewayDatabase,
  input: Omit<WritingStyleExtractJobPayload, "attempts">,
  now: Date,
): void {
  const id = `writing-style-extract:${input.documentId}`;
  tx.delete(jobs).where(and(eq(jobs.id, id), eq(jobs.type, WRITING_STYLE_EXTRACT_JOB_TYPE))).run();
  tx.insert(jobs).values({
    id,
    type: WRITING_STYLE_EXTRACT_JOB_TYPE,
    status: "pending",
    payload: { ...input, attempts: 0 } satisfies WritingStyleExtractJobPayload,
    createdAt: now,
    updatedAt: now,
  }).run();
}

/** refresh 以单例 ID 去重：已在队/进行中则不重复入队。 */
export function enqueueWritingStyleRefresh(tx: GatewayDatabase, now: Date): void {
  const id = "writing-style:refresh";
  const existing = tx.select({ id: jobs.id, status: jobs.status }).from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.type, WRITING_STYLE_REFRESH_JOB_TYPE))).get();
  if (existing && existing.status !== "completed" && existing.status !== "failed" && existing.status !== "cancelled") {
    return;
  }
  tx.delete(jobs).where(and(eq(jobs.id, id), eq(jobs.type, WRITING_STYLE_REFRESH_JOB_TYPE))).run();
  tx.insert(jobs).values({
    id,
    type: WRITING_STYLE_REFRESH_JOB_TYPE,
    status: "pending",
    payload: { attempts: 0 },
    createdAt: now,
    updatedAt: now,
  }).run();
}

export function newRefreshJobId(): string {
  return `writing-style:refresh:${randomUUID()}`;
}
