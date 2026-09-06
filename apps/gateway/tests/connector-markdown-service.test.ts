import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorEmails,
  connectorMarkdownArtifacts,
  connectorMarkdownOutbox,
  connectorRecords,
  connectorTodos,
} from "../src/infrastructure/database/schema.js";
import { ConnectorMarkdownService } from "@nxcore/connectors-module/markdown-service.js";
import type { IngestService } from "../src/modules/ingest/service.js";

const logger = { info: vi.fn(), warn: vi.fn() };
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.clearAllMocks();
});

async function fixture(ingest?: IngestService) {
  const directory = await mkdtemp(join(tmpdir(), "nxcore-connector-markdown-"));
  directories.push(directory);
  const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {});
  const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
  const ingestMock = ingest ?? ({
    ingest: vi.fn(async () => ({ eventId: "ing-1", parsedId: "parsed-1" })),
    cleanupSource: vi.fn(async () => undefined),
  } as unknown as IngestService);
  const service = new ConnectorMarkdownService(database.db, directory, ingestMock, logger);
  return { directory, database, ingest: ingestMock, service };
}

function insertEmail(test: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-20T01:00:00.000Z");
  test.database.db.insert(connectorEmails).values({
    id: "email-row-1",
    ownerId: "local-user",
    service: "gmail",
    connectionName: "private@example.com",
    sourceRecordId: "gmail-message-1",
    sourceUpdatedAt: now,
    syncedAt: now,
    schemaVersion: 1,
    promptVersion: 1,
    contentHash: "source-hash-1",
    extensionPayload: { attachmentList: [{ filename: "计划.pdf", mimeType: "application/pdf" }] },
    messageId: "message-1",
    threadId: "thread-1",
    senderName: "产品经理",
    senderAddress: "pm@example.com",
    recipients: [{ name: "研发", address: "dev@example.com" }],
    subject: "版本计划",
    sentAt: now,
    bodyText: "请确认版本计划。",
    labels: ["INBOX"],
    hasAttachments: true,
    ...overrides,
  }).run();
}

function enqueue(
  test: Awaited<ReturnType<typeof fixture>>,
  operation: "upsert" | "delete",
  sourceContentHash: string,
) {
  const now = new Date();
  test.database.db.insert(connectorMarkdownOutbox).values({
    id: `event-${operation}-${sourceContentHash}`,
    ownerId: "local-user",
    resourceType: "email",
    ingestSourceId: "email-row-1",
    operation,
    sourceContentHash,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
}

describe("ConnectorMarkdownService", () => {
  it("backfills one stable Markdown file, updates it in place, and removes it on deletion", async () => {
    const test = await fixture();
    insertEmail(test);

    try {
      await test.service.initialize();
      await test.service.dispose();

      const first = test.database.db.select().from(connectorMarkdownArtifacts).get()!;
      expect(first).toMatchObject({
        resourceType: "email",
        ingestSourceId: "email-row-1",
        sourceContentHash: "source-hash-1",
        rendererVersion: "email-v3",
        version: 1,
        status: "ready",
        ingestStatus: "succeeded",
        ingestEventId: "ing-1",
      });
      expect(first.activePath).not.toContain("private@example.com");
      const firstMarkdown = await readFile(join(test.directory, first.activePath), "utf8");
      expect(firstMarkdown).toContain("# 版本计划");
      expect(firstMarkdown).toContain("请确认版本计划。");
      expect(firstMarkdown).toContain('content_format: "markdown"');
      expect(firstMarkdown).toContain('body_conversion_source: "plain"');
      expect(firstMarkdown).toContain('"filename":"计划.pdf"');
      const firstManifestPath = join(test.directory, first.activePath.replace(/\.md$/, ".manifest.json"));
      expect(JSON.parse(await readFile(firstManifestPath, "utf8"))).toMatchObject({
        ermdVersion: 1,
        connector: "gmail",
        resourceType: "email",
        sourceRecordId: "gmail-message-1",
        sourceContentHash: "source-hash-1",
      });

      test.database.db.update(connectorEmails).set({
        bodyText: "计划已确认，可以发布。",
        contentHash: "source-hash-2",
        syncedAt: new Date("2026-08-20T02:00:00.000Z"),
      }).where(eq(connectorEmails.id, "email-row-1")).run();
      enqueue(test, "upsert", "source-hash-2");
      await test.service.processPending();

      const updated = test.database.db.select().from(connectorMarkdownArtifacts).get()!;
      expect(updated.activePath).toBe(first.activePath);
      expect(updated.version).toBe(2);
      expect(await readFile(join(test.directory, updated.activePath), "utf8"))
        .toContain("计划已确认，可以发布。");

      test.database.db.update(connectorEmails).set({ deletedAt: new Date() })
        .where(eq(connectorEmails.id, "email-row-1")).run();
      enqueue(test, "delete", "source-hash-2");
      await test.service.processPending();

      expect(test.database.db.select().from(connectorMarkdownArtifacts).get())
        .toMatchObject({ status: "deleted", ingestStatus: "skipped" });
      expect(test.ingest.cleanupSource).toHaveBeenCalledWith("mail", "email-row-1");
      await expect(access(join(test.directory, updated.activePath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(firstManifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await test.service.dispose();
      test.database.sqlite.close();
    }
  });

  it("materializes noisy email HTML as clean structured Markdown", async () => {
    const test = await fixture();
    insertEmail(test, {
      bodyText: "",
      hasAttachments: false,
      extensionPayload: {
        bodyHtml: `
          <style>.hidden { display: none }</style>
          <p>请查看 <strong>发布计划</strong>。</p>
          <ul><li>灰度发布</li><li>全量发布</li></ul>
          <div class="gmail_signature">内部签名</div>
          <div class="gmail_quote">历史邮件正文</div>
        `,
      },
    });

    try {
      await test.service.initialize();
      await test.service.dispose();

      const artifact = test.database.db.select().from(connectorMarkdownArtifacts).get()!;
      const markdown = await readFile(join(test.directory, artifact.activePath), "utf8");
      expect(markdown).toContain('body_conversion_source: "html"');
      expect(markdown).toContain("请查看 **发布计划**。");
      expect(markdown).toContain("- 灰度发布\n- 全量发布");
      expect(markdown).not.toMatch(/display: none|内部签名|历史邮件正文/);
    } finally {
      await test.service.dispose();
      test.database.sqlite.close();
    }
  });

  it("keeps a generated artifact ready when downstream ingest fails", async () => {
    const ingest = {
      ingest: vi.fn(async () => { throw new Error("knowledge unavailable"); }),
    } as unknown as IngestService;
    const test = await fixture(ingest);
    insertEmail(test);

    try {
      await test.service.initialize();
      await test.service.dispose();

      const artifact = test.database.db.select().from(connectorMarkdownArtifacts).get()!;
      expect(artifact).toMatchObject({
        status: "ready",
        ingestStatus: "failed",
        lastError: "knowledge unavailable",
      });
      await expect(access(join(test.directory, artifact.activePath))).resolves.toBeUndefined();
      expect(test.database.db.select().from(connectorMarkdownOutbox).get())
        .toMatchObject({ status: "pending", attempts: 1, lastError: "knowledge unavailable" });
    } finally {
      await test.service.dispose();
      test.database.sqlite.close();
    }
  });

  it("materializes a generic connector payload as stable structured Markdown", async () => {
    const test = await fixture();
    const now = new Date("2026-08-20T03:00:00.000Z");
    test.database.db.insert(connectorRecords).values({
      id: "generic-row-1",
      ownerId: "local-user",
      service: "custom/provider",
      dataset: "tickets",
      sourceRecordId: "ticket-42",
      payload: { title: "修复登录异常", priority: "high", nested: { owner: "张三" } },
      sourceUpdatedAt: now,
      contentHash: "generic-source-hash",
      syncedAt: now,
      expiresAt: null,
      deletedAt: null,
    }).run();

    try {
      await test.service.initialize();
      await test.service.dispose();

      const artifact = test.database.db.select().from(connectorMarkdownArtifacts).get()!;
      expect(artifact).toMatchObject({
        resourceType: "generic",
        ingestSourceId: "generic-row-1",
        status: "ready",
        ingestStatus: "succeeded",
      });
      expect(artifact.activePath).not.toContain("custom/provider");
      const markdown = await readFile(join(test.directory, artifact.activePath), "utf8");
      expect(markdown).toContain("# 修复登录异常");
      expect(markdown).toContain('"priority": "high"');
      expect(markdown).toContain('"owner": "张三"');
      expect(test.ingest.ingest).toHaveBeenCalledWith({
        source: { ref: { sourceKind: "connector-record", sourceId: "generic-row-1" } },
        originChannel: "connector",
      });
    } finally {
      await test.service.dispose();
      test.database.sqlite.close();
    }
  });

  it("materializes a connector todo as structured Markdown and ingests via the connector-todo ref", async () => {
    const test = await fixture();
    const now = new Date("2026-08-20T03:00:00.000Z");
    test.database.db.insert(connectorTodos).values({
      id: "todo-row-1",
      ownerId: "local-user",
      service: "google_tasks",
      connectionName: "default",
      sourceRecordId: "task-source-1",
      sourceUpdatedAt: now,
      syncedAt: now,
      schemaVersion: 1,
      promptVersion: 1,
      contentHash: "todo-source-hash",
      extensionPayload: null,
      todoId: "task-1",
      title: "补充天线参数",
      notes: "见评审会结论",
      status: "needsAction",
      dueAt: new Date("2026-09-01T01:00:00.000Z"),
      completedAt: null,
      priority: "high",
      listId: "list-1",
      listName: "卫星项目",
    }).run();

    try {
      await test.service.initialize();
      await test.service.dispose();

      const artifact = test.database.db.select().from(connectorMarkdownArtifacts).get()!;
      expect(artifact).toMatchObject({
        resourceType: "todo",
        ingestSourceId: "todo-row-1",
        rendererVersion: "todo-v1",
        status: "ready",
        ingestStatus: "succeeded",
      });
      const markdown = await readFile(join(test.directory, artifact.activePath), "utf8");
      expect(markdown).toContain("# 补充天线参数");
      expect(markdown).toContain("## 待办信息");
      expect(markdown).toContain("- 状态：needsAction");
      expect(markdown).toContain("- 优先级：high");
      expect(markdown).toContain("- 清单：卫星项目");
      expect(markdown).toContain("## 备注");
      expect(markdown).toContain("见评审会结论");
      expect(markdown).toContain('source_kind: "todo"');
      expect(test.ingest.ingest).toHaveBeenCalledWith({
        source: { ref: { sourceKind: "connector-todo", sourceId: "todo-row-1" } },
        originChannel: "connector",
      });
      expect(test.service.getByIngestSource("todo", "todo-row-1")?.id).toBe(artifact.id);
    } finally {
      await test.service.dispose();
      test.database.sqlite.close();
    }
  });

  it("reports source-based Markdown generation and ingest progress", async () => {
    const test = await fixture();
    insertEmail(test);

    try {
      await test.service.initialize();
      await test.service.dispose();

      insertEmail(test, {
        id: "email-row-2",
        sourceRecordId: "gmail-message-2",
        messageId: "message-2",
        threadId: "thread-2",
        subject: "待处理邮件",
        contentHash: "source-hash-2",
      });
      const now = new Date();
      test.database.db.insert(connectorMarkdownOutbox).values({
        id: "event-processing-source-2",
        ownerId: "local-user",
        resourceType: "email",
        ingestSourceId: "email-row-2",
        operation: "upsert",
        sourceContentHash: "source-hash-2",
        status: "processing",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      }).run();

      expect(test.service.stats("local-user")).toMatchObject({
        total: 2,
        ready: 1,
        queued: 0,
        processing: 1,
        pending: 1,
        failed: 0,
        ingestSucceeded: 1,
        ingestPending: 0,
        ingestFailed: 0,
      });

      test.database.db.update(connectorMarkdownOutbox).set({ status: "pending" })
        .where(eq(connectorMarkdownOutbox.id, "event-processing-source-2")).run();
      expect(test.service.stats("local-user")).toMatchObject({ queued: 1, processing: 0, pending: 1 });
    } finally {
      await test.service.dispose();
      test.database.sqlite.close();
    }
  });
});
