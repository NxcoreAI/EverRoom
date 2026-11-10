import { and, eq, inArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";

/**
 * 统一索引进度管线（PRD 0.2.0 §2.5）。与 writing-style 同表不同 type，
 * 由 SearchService 内置 worker 独立消费；high 型先于 normal（新内容优先于回填）。
 */
export const SEARCH_INDEX_JOB_TYPE = "search.index";
export const SEARCH_INDEX_HIGH_JOB_TYPE = "search.index.high";
export const SEARCH_WORKER_JOB_TYPES = [SEARCH_INDEX_JOB_TYPE, SEARCH_INDEX_HIGH_JOB_TYPE] as const;

export type SearchItemType = "file" | "message" | "document" | "export";

export interface SearchIndexJobPayload {
  itemType: SearchItemType;
  refId: string;
  attempts: number;
}

export function searchIndexJobId(itemType: SearchItemType, refId: string): string {
  return `search-index:${itemType}:${refId}`;
}

/**
 * 幂等入队：确定性 job id，重入队先淘汰旧行（含已完成，保持 jobs 表不膨胀）。
 * ifAbsent=true（回填用）时不挤掉已在等待的行，避免刷新排队位置。
 */
export function enqueueSearchIndex(
  db: GatewayDatabase,
  input: { itemType: SearchItemType; refId: string; priority?: "normal" | "high"; ifAbsent?: boolean },
): void {
  const id = searchIndexJobId(input.itemType, input.refId);
  const type = input.priority === "high" ? SEARCH_INDEX_HIGH_JOB_TYPE : SEARCH_INDEX_JOB_TYPE;
  if (input.ifAbsent) {
    const existing = db.select({ id: jobs.id, status: jobs.status }).from(jobs)
      .where(and(eq(jobs.id, id), inArray(jobs.type, [...SEARCH_WORKER_JOB_TYPES]))).get();
    if (existing && (existing.status === "pending" || existing.status === "running")) return;
  }
  const now = new Date();
  db.delete(jobs).where(and(eq(jobs.id, id), inArray(jobs.type, [...SEARCH_WORKER_JOB_TYPES]))).run();
  db.insert(jobs).values({
    id,
    type,
    status: "pending",
    payload: { itemType: input.itemType, refId: input.refId, attempts: 0 } satisfies SearchIndexJobPayload,
    createdAt: now,
    updatedAt: now,
  }).run();
}
