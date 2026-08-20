import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, isNull } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorDocuments,
  connectorMarkdownOutbox,
} from "../src/infrastructure/database/schema.js";
import { ConnectorSyncService } from "../src/modules/connectors/service.js";
import {
  googleDocsHtmlToMarkdown,
  notionPageToDocument,
} from "../src/modules/connectors/document-sync.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => vi.unstubAllGlobals());

describe("managed document connector sync", () => {
  it("provisions Notion reconciliation and incremental jobs, then reconciles removals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-notion-managed-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "true",
      NXCORE_CLI_CONNECTOR_SYNC_INTERVAL_MS: "600000",
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let searchMode: "page" | "empty" = "page";
    let revision = 1;
    const service = new ConnectorSyncService(database.db, config, logger, async (_connector, args) => {
      if (args[1] === "apps") {
        return [{ service: "notion", connectionName: "workspace", displayName: "Product", status: "active" }];
      }
      const action = args[args.indexOf("--action") + 1];
      if (action === "search") {
        return { data: {
          object: "list",
          results: searchMode === "empty" ? [] : [notionPage(revision)],
          has_more: false,
          next_cursor: null,
        } };
      }
      if (action === "retrieve_page_markdown") {
        return { data: { markdown: `## 方案\r\n\r\n正文 v${String(revision)}  ` } };
      }
      throw new Error(`Unexpected connector action: ${String(action)}`);
    });

    try {
      await service.initialize();
      await until(() => service.listJobs().find((job) => job.name.startsWith("Notion 增量同步"))?.status === "active");
      const reconcile = service.listJobs().find((job) => job.name.startsWith("Notion 全量校准"))!;
      const incremental = service.listJobs().find((job) => job.name.startsWith("Notion 增量同步"))!;
      expect(reconcile).toMatchObject({ intervalMs: 12 * 60 * 60 * 1_000, status: "active" });
      expect(incremental).toMatchObject({
        intervalMs: 10 * 60 * 1_000,
        status: "active",
        checkpoint: { lastEditedTime: "2026-08-20T01:00:00.000Z" },
      });
      expect(database.db.select().from(connectorDocuments).get()).toMatchObject({
        service: "notion",
        title: "产品方案 v1",
        bodyText: "## 方案\n\n正文 v1",
      });

      revision = 2;
      await service.triggerJob(incremental.id);
      expect(database.db.select().from(connectorDocuments).get()).toMatchObject({ title: "产品方案 v2" });

      searchMode = "empty";
      await service.triggerJob(reconcile.id);
      expect(database.db.select().from(connectorDocuments).where(isNull(connectorDocuments.deletedAt)).all()).toHaveLength(1);
      await service.triggerJob(reconcile.id);
      expect(database.db.select().from(connectorDocuments).where(isNull(connectorDocuments.deletedAt)).all()).toEqual([]);
      expect(database.db.select().from(connectorMarkdownOutbox).all().map((item) => item.operation))
        .toEqual(["upsert", "upsert", "delete"]);
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a Drive change token and converts exported Google Docs HTML to stable Markdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-google-docs-managed-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "true",
      NXCORE_CLI_CONNECTOR_SYNC_INTERVAL_MS: "600000",
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let revision = 1;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<html><body><h2>正文 v${String(revision)}</h2><table><tr><td>A</td><td>B</td></tr></table><script>bad()</script></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    )));
    const service = new ConnectorSyncService(database.db, config, logger, async (_connector, args) => {
      if (args[1] === "apps") {
        return [{ service: "googledrive", connectionName: "drive", displayName: "me@example.com", status: "active" }];
      }
      const action = args[args.indexOf("--action") + 1];
      if (action === "changes.getStartPageToken") return { data: { startPageToken: "100", kind: "drive#startPageToken" } };
      if (action === "files.list") return { data: { files: [googleDocument(revision)], nextPageToken: null } };
      if (action === "files.export") return { data: {
        fileId: "doc-1",
        name: "doc-1.html",
        mimeType: "text/html",
        sizeBytes: 128,
        file: {
          fileId: "transit.html",
          downloadUrl: "http://127.0.0.1:3000/api/files/transit.html",
          sizeBytes: 128,
          name: "doc-1.html",
          mimeType: "text/html",
        },
      } };
      if (action === "changes.list") return { data: {
        changes: [{ id: "change-1", changeType: "file", removed: false, fileId: "doc-1", file: googleDocument(revision) }],
        nextPageToken: null,
        newStartPageToken: "101",
      } };
      throw new Error(`Unexpected connector action: ${String(action)}`);
    });

    try {
      await service.initialize();
      await until(() => service.listJobs().find((job) => job.name.startsWith("Google Docs 增量同步"))?.status === "active");
      const reconcile = service.listJobs().find((job) => job.name.startsWith("Google Docs 全量校准"))!;
      const incremental = service.listJobs().find((job) => job.name.startsWith("Google Docs 增量同步"))!;
      expect(reconcile.intervalMs).toBe(24 * 60 * 60 * 1_000);
      expect(incremental).toMatchObject({ intervalMs: 5 * 60 * 1_000, checkpoint: { pageToken: "100" } });
      expect(database.db.select().from(connectorDocuments).get()?.bodyText).toContain("<table>");
      expect(database.db.select().from(connectorDocuments).get()?.bodyText).not.toContain("bad()")

      revision = 2;
      await service.triggerJob(incremental.id);
      expect(service.getJob(incremental.id)?.checkpoint).toMatchObject({ pageToken: "101" });
      expect(database.db.select().from(connectorDocuments).where(eq(connectorDocuments.sourceRecordId, "doc-1")).get())
        .toMatchObject({ title: "Roadmap v2", bodyText: expect.stringContaining("正文 v2") });
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes titles, line endings, scripts, and complex tables in the document compatibility layer", () => {
    expect(notionPageToDocument(notionPage(1), "A\r\n\r\nB  ")).toMatchObject({
      title: "产品方案 v1",
      bodyText: "A\n\nB",
      documentType: "notion-page",
    });
    const markdown = googleDocsHtmlToMarkdown(Buffer.from(
      "<h1>Title</h1><table><tr><td>A</td></tr></table><script>alert(1)</script>",
    ));
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("<table>");
    expect(markdown).not.toContain("alert(1)");
  });
});

function notionPage(revision: number) {
  return {
    object: "page",
    id: "page-1",
    last_edited_time: `2026-08-20T0${String(revision)}:00:00.000Z`,
    archived: false,
    in_trash: false,
    url: "https://www.notion.so/page-1",
    parent: { type: "workspace", workspace: true },
    properties: {
      Name: { type: "title", title: [{ plain_text: `产品方案 v${String(revision)}` }] },
      Status: { type: "status", status: { name: "In progress" } },
    },
    last_edited_by: { name: "Alice" },
  };
}

function googleDocument(revision: number) {
  return {
    id: "doc-1",
    name: `Roadmap v${String(revision)}`,
    mimeType: "application/vnd.google-apps.document",
    webViewLink: "https://docs.google.com/document/d/doc-1/edit",
    modifiedTime: `2026-08-20T0${String(revision)}:00:00.000Z`,
    owners: [{ displayName: "Alice", emailAddress: "alice@example.com" }],
    parents: ["root"],
    shared: true,
    starred: false,
    trashed: false,
    driveId: null,
  };
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for connector sync");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
