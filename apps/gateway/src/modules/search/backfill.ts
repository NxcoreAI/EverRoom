import { asc, gt, isNull, and, notInArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentMessages, documents, fileEntries } from "../../infrastructure/database/schema.js";
import { enqueueSearchIndex } from "./jobs.js";

const BATCH_SIZE = 500;

/**
 * 存量回填：启动后异步跑一次，把既有三类内容（文件、会话消息、文稿）
 * 排进索引队列（normal 优先级，让位给新内容的 high job）。
 * enqueueSearchIndex(ifAbsent) 以确定性 job id 去重，重复启动不会刷新已在等待的行。
 * Phase 2i：Room 命中类型已删，回填不再扫描房间。
 */
export class SearchBackfill {
  private ran = false;

  constructor(private readonly db: GatewayDatabase) {}

  schedule(): void {
    if (this.ran) return;
    this.ran = true;
    setTimeout(() => {
      void this.run().catch((error) => {
        console.warn("[search] backfill failed:", error instanceof Error ? error.message : error);
      });
    }, 5_000).unref();
  }

  async run(): Promise<void> {
    await this.scanFiles();
    await this.scanMessages();
    await this.scanDocuments();
  }

  private async scanFiles(): Promise<void> {
    let cursor = "";
    for (;;) {
      const rows = this.db.select({ id: fileEntries.id }).from(fileEntries)
        .where(and(
          gt(fileEntries.id, cursor),
          isNull(fileEntries.deletedAt),
          notInArray(fileEntries.state, ["deleted", "missing"]),
        ))
        .orderBy(asc(fileEntries.id)).limit(BATCH_SIZE).all();
      const last = rows.at(-1);
      if (!last) return;
      for (const row of rows) enqueueSearchIndex(this.db, { itemType: "file", refId: row.id, ifAbsent: true });
      cursor = last.id;
      await yieldToEventLoop();
    }
  }

  private async scanMessages(): Promise<void> {
    let cursor = "";
    for (;;) {
      const rows = this.db.select({ id: agentMessages.id }).from(agentMessages)
        .where(gt(agentMessages.id, cursor))
        .orderBy(asc(agentMessages.id)).limit(BATCH_SIZE).all();
      const last = rows.at(-1);
      if (!last) return;
      for (const row of rows) enqueueSearchIndex(this.db, { itemType: "message", refId: row.id, ifAbsent: true });
      cursor = last.id;
      await yieldToEventLoop();
    }
  }

  private async scanDocuments(): Promise<void> {
    let cursor = "";
    for (;;) {
      const rows = this.db.select({ id: documents.id }).from(documents)
        .where(and(gt(documents.id, cursor), isNull(documents.deletedAt)))
        .orderBy(asc(documents.id)).limit(BATCH_SIZE).all();
      const last = rows.at(-1);
      if (!last) return;
      for (const row of rows) enqueueSearchIndex(this.db, { itemType: "document", refId: row.id, ifAbsent: true });
      cursor = last.id;
      await yieldToEventLoop();
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
