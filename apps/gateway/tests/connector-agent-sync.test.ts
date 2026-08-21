import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntime, RuntimeEvent, RuntimeRun, StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { desc, eq, isNull } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorSyncJobStates,
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  connectorMarkdownOutbox,
  connectorQuarantinedRecords,
  connectorSyncJobs,
  connectorSyncRuns,
} from "../src/infrastructure/database/schema.js";
import { ConnectorSyncService } from "../src/modules/connectors/service.js";
import { createConnectorDataPiTools } from "../src/modules/connectors/pi-tools.js";
import { createConnectorSyncAgentTools } from "../src/modules/connectors/agent-tools.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function completedEvents(): AsyncIterable<RuntimeEvent> {
  return (async function* () {
    yield { type: "run.completed", payload: {} } as RuntimeEvent;
  })();
}

function syncRuntime(
  execute: (input: StartRuntimeRunInput) => void,
): AgentRuntime {
  return {
    id: "test-sync-agent",
    getCapabilities: async () => ({ streaming: true, reasoning: false, tools: true, steering: false, resume: false }),
    start: async (input): Promise<RuntimeRun> => {
      execute(input);
      return { runId: input.runId, runtimeSessionRef: `/tmp/${input.runId}.jsonl`, events: completedEvents() };
    },
    resume: async () => { throw new Error("not supported"); },
    sendInput: async () => undefined,
    cancel: async () => undefined,
    deleteSession: async () => undefined,
    dispose: async () => undefined,
  };
}

function emailJob() {
  return {
    id: "mail-agent",
    ownerId: "local-user",
    service: "gmail",
    allowedActions: ["fetch_emails", "get_message"],
    dataset: "emails",
    resourceType: "email",
    connectionName: "primary-mailbox",
    input: { query: "newer_than:1d", detail: "full" },
    goal: "同步最近更新的完整邮件",
    promptVersion: 2,
    schemaVersion: 3,
  };
}

describe("ConnectorSyncService Agent ingestion", () => {
  it("derives a seven-day Gmail query and deterministically consumes every page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-gmail-snapshot-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "false",
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    const connectorInputs: Record<string, unknown>[] = [];
    const service = new ConnectorSyncService(database.db, config, logger, async (_connector, args) => {
      const input = JSON.parse(args[args.indexOf("--data") + 1]!) as Record<string, unknown>;
      connectorInputs.push(input);
      const page = input.pageToken ? 2 : 1;
      return {
        data: {
          messages: [gmailMessage(`message-${String(page)}`, `Subject ${String(page)}`)],
          nextPageToken: page === 1 ? "page-2" : null,
          resultSizeEstimate: 2,
        },
      };
    });
    try {
      await service.initialize();
      const job = service.createJob({
        name: "获取一周内的邮件", service: "gmail", dataset: "emails", resourceType: "email",
        connectionName: "default", allowedActions: ["fetch_emails", "get_message"],
        input: { maxResults: 50, detail: "full" }, goal: "同步指定范围内的完整邮件",
        scheduleType: "manual", intervalMs: 900_000, timezone: "Asia/Shanghai", status: "active",
      });
      expect(job.input).toMatchObject({ query: "newer_than:7d" });

      await service.triggerJob(job.id);

      expect(connectorInputs).toEqual([
        { query: "newer_than:7d", detail: "full", maxResults: 50 },
        { query: "newer_than:7d", detail: "full", maxResults: 50, pageToken: "page-2" },
      ]);
      expect(database.db.select().from(connectorEmails).all()).toHaveLength(2);
      expect(database.db.select().from(connectorMarkdownOutbox).all())
        .toEqual([
          expect.objectContaining({ operation: "upsert", ingestSourceId: expect.any(String) }),
          expect.objectContaining({ operation: "upsert", ingestSourceId: expect.any(String) }),
        ]);
      expect(database.db.select().from(connectorSyncRuns).get()).toMatchObject({
        status: "success", discovered: 2, inserted: 2, agentModel: null,
      });
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("backfills a derived Gmail query for an existing legacy task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-gmail-backfill-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "false",
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    const service = new ConnectorSyncService(database.db, config, logger);

    try {
      await service.initialize();
      const job = service.createJob({
        name: "旧版邮件同步", service: "gmail", dataset: "emails", resourceType: "email",
        connectionName: "default", allowedActions: ["fetch_emails"], input: { maxResults: 50, detail: "full" },
        goal: "同步指定范围内的完整邮件", scheduleType: "manual", intervalMs: 900_000,
        timezone: "Asia/Shanghai", status: "paused",
      });
      database.db.update(connectorSyncJobs).set({
        name: "获取一周内的邮件",
        input: { maxResults: 50, detail: "full" },
      }).where(eq(connectorSyncJobs.id, job.id)).run();

      await service.initialize();

      expect(service.getJob(job.id)).toMatchObject({
        input: { maxResults: 50, detail: "full", query: "newer_than:7d" },
        configVersion: 2,
      });
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("provisions Gmail bootstrap and incremental jobs and hands off the history checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-gmail-managed-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "true",
      NXCORE_CLI_CONNECTOR_SYNC_INTERVAL_MS: "600000",
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    const service = new ConnectorSyncService(database.db, config, logger, async (_connector, args) => {
      if (args[1] === "apps") {
        return [{ service: "gmail", connectionName: "default", displayName: "mail@example.com", status: "active" }];
      }
      const action = args[args.indexOf("--action") + 1];
      if (action === "get_profile") return { data: { emailAddress: "mail@example.com", historyId: "100" } };
      if (action === "fetch_emails") {
        return { data: { messages: [gmailMessage("message-1", "Initial")], nextPageToken: null } };
      }
      if (action === "list_history") {
        return {
          data: {
            history: [{
              messagesAdded: [{ message: { id: "message-2" } }],
              messagesDeleted: [{ message: { id: "message-1" } }],
            }],
            historyId: "101",
            nextPageToken: null,
          },
        };
      }
      if (action === "fetch_message_by_message_id") return { data: gmailMessage("message-2", "Incremental") };
      throw new Error(`Unexpected connector action: ${String(action)}`);
    });

    try {
      await service.initialize();
      await until(() => service.listJobs().find((job) => job.name.startsWith("Gmail 全量初始化"))?.status === "paused");
      const jobs = service.listJobs();
      const bootstrap = jobs.find((job) => job.name.startsWith("Gmail 全量初始化"))!;
      const incremental = jobs.find((job) => job.name.startsWith("Gmail 增量同步"))!;
      expect(bootstrap).toMatchObject({ status: "paused", checkpoint: { historyId: "100" } });
      expect(incremental).toMatchObject({ status: "active", checkpoint: { historyId: "100" } });

      await service.triggerJob(incremental.id);

      expect(service.getJob(incremental.id)?.checkpoint).toMatchObject({ historyId: "101" });
      expect(database.db.select().from(connectorEmails).where(isNull(connectorEmails.deletedAt)).all())
        .toEqual([expect.objectContaining({ messageId: "message-2", subject: "Incremental" })]);
      expect(database.db.select().from(connectorMarkdownOutbox).all().map((event) => event.operation).sort())
        .toEqual(["delete", "upsert", "upsert"]);
      expect(database.db.select().from(connectorSyncJobStates).where(eq(connectorSyncJobStates.jobId, incremental.id)).get()?.consecutiveFailures)
        .toBe(0);
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes email records idempotently and commits the checkpoint only after sync_finish", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connector-agent-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CLI_CONNECTOR_SYNC_JOBS: JSON.stringify([emailJob()]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let service: ConnectorSyncService;
    let invocation = 0;
    const runtime = syncRuntime((input) => {
      invocation += 1;
      expect(input.prompt).toContain("gmail-sync Skill");
      expect(input.prompt).toContain("唯一允许访问的服务：gmail");
      const result = service.writeAgentBatch(input.runId, "email", [{
        sourceRecordId: "gmail-message-1",
        messageId: "message-1",
        threadId: "thread-1",
        senderName: "张三",
        senderAddress: "zhangsan@example.com",
        recipients: [{ address: "me@example.com" }],
        subject: "预算审批",
        sentAt: "2026-08-19T09:30:00+08:00",
        bodyText: "请审批第三季度预算。",
        labels: ["INBOX"],
        hasAttachments: false,
        sourceUpdatedAt: "2026-08-19T09:30:00+08:00",
        extensionPayload: { historyId: "100" },
        agentExplanation: `non-persisted note ${String(invocation)}`,
      }]);
      expect(result.rejected).toEqual([]);
      service.finishAgentRun(input.runId, {
        discovered: result.inserted + result.updated + result.unchanged,
        checkpoint: { historyId: "100" },
      });
    });
    service = new ConnectorSyncService(database.db, config, logger);
    service.attachAgentRuntime(runtime);

    try {
      await service.initialize();
      await service.triggerJob("mail-agent");
      await service.triggerJob("mail-agent");

      const emails = database.db.select().from(connectorEmails).all();
      expect(emails).toHaveLength(1);
      expect(database.db.select().from(connectorMarkdownOutbox).all()).toEqual([
        expect.objectContaining({
          ownerId: "local-user",
          resourceType: "email",
          ingestSourceId: emails[0]!.id,
          operation: "upsert",
        }),
      ]);
      expect(emails[0]).toMatchObject({
        subject: "预算审批",
        schemaVersion: 3,
        promptVersion: 2,
        connectionName: "primary-mailbox",
      });
      const runs = database.db.select().from(connectorSyncRuns)
        .orderBy(desc(connectorSyncRuns.startedAt)).all();
      expect(runs).toHaveLength(2);
      expect(runs.map((run) => run.status)).toEqual(["success", "success"]);
      expect(runs.map((run) => [run.inserted, run.updated])).toEqual([[0, 0], [1, 0]]);
      expect(database.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.id, "mail-agent")).get()?.checkpoint)
        .toEqual({ historyId: "100" });
      expect(service.queryRecords({ ownerId: "local-user", dataset: "emails", query: "预算" }))
        .toEqual([expect.objectContaining({ resourceType: "email", title: "预算审批" })]);
      expect(service.queryRecords({ ownerId: "local-user", dataset: "repositories" })).toEqual([]);
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds local query tools to the configured owner", async () => {
    const queryRecords = vi.fn(() => []);
    const getRecord = vi.fn(() => null);
    const status = vi.fn(() => ({ enabled: true }));
    const service = { queryRecords, getRecord, status } as unknown as ConnectorSyncService;
    const tools = createConnectorDataPiTools(service, "bound-owner");

    await tools.find((tool) => tool.name === "connector_data_search")!.execute(
      {} as StartRuntimeRunInput,
      { ownerId: "other-owner", dataset: "emails" },
    );
    await tools.find((tool) => tool.name === "connector_record_get")!.execute(
      {} as StartRuntimeRunInput,
      { ownerId: "other-owner", recordId: "email-1" },
    );
    await tools.find((tool) => tool.name === "connector_sync_status")!.execute(
      {} as StartRuntimeRunInput,
      { ownerId: "other-owner" },
    );

    expect(queryRecords).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "bound-owner" }));
    expect(getRecord).toHaveBeenCalledWith("bound-owner", "email-1");
    expect(status).toHaveBeenCalledWith("bound-owner");
    expect(tools.every((tool) => !("ownerId" in (tool.parameters.properties as Record<string, unknown>)))).toBe(true);
  });

  it("exposes domain fields to the Agent and supplies a quarantine reason fallback", async () => {
    const tools = createConnectorSyncAgentTools({
      executable: "oo",
      baseUrl: "http://127.0.0.1:3000",
      configDirectory: "/tmp/oo-config",
      dataDirectory: "/tmp/oo-data",
    }, {} as ConnectorSyncService);
    const writeTool = tools.find((tool) => tool.name === "sync_write_batch")!;
    const quarantineTool = tools.find((tool) => tool.name === "sync_quarantine")!;
    const writeProperties = writeTool.parameters.properties as Record<string, unknown>;
    const records = writeProperties.records as { items: { properties: Record<string, unknown> } };
    const quarantineProperties = quarantineTool.parameters.properties as Record<string, unknown>;
    const quarantineRecords = quarantineProperties.records as { items: { required: string[] } };

    expect(records.items.properties).toHaveProperty("labels");
    expect(records.items.properties).toHaveProperty("hasAttachments");
    expect(records.items.properties).toHaveProperty("attendees");
    expect(quarantineRecords.items.required).toEqual(["payload"]);
  });

  it("blocks unapproved connector actions and refuses an unbalanced completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connector-guard-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CLI_CONNECTOR_SYNC_JOBS: JSON.stringify([emailJob()]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let service: ConnectorSyncService;
    const runtime = syncRuntime((input) => {
      expect(() => service.authorizeAgentConnectorCall(input, "connector_run", {
        service: "gmail",
        name: "send_email",
        input: {},
      })).toThrow("not approved");
      expect(() => service.authorizeAgentConnectorCall(input, "connector_run", {
        service: "gmail",
        name: "fetch_emails",
        input: {},
        connectionName: "other-mailbox",
      })).toThrow("cannot change connectionName");
      const result = service.writeAgentBatch(input.runId, "email", [{ sourceRecordId: "broken" }]);
      expect(result.rejected).toHaveLength(1);
      expect(() => service.finishAgentRun(input.runId, { discovered: 1, checkpoint: { historyId: "unsafe" } }))
        .toThrow("must equal");
      expect(service.quarantineAgentRecords(input.runId, [{ sourceRecordId: "broken", payload: { id: "broken" } }]))
        .toEqual({ quarantined: 1 });
    });
    service = new ConnectorSyncService(database.db, config, logger);
    service.attachAgentRuntime(runtime);

    try {
      await service.initialize();
      await service.triggerJob("mail-agent");
      const run = database.db.select().from(connectorSyncRuns).get();
      expect(run?.status).toBe("failed");
      expect(database.db.select().from(connectorEmails).all()).toEqual([]);
      expect(database.db.select().from(connectorSyncJobs).get()?.checkpoint).toBeNull();
      expect(database.db.select().from(connectorQuarantinedRecords).get()?.reason)
        .toBe("Agent could not map record to the target schema");
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes document and calendar Agent output into their dedicated tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connector-domains-"));
    const jobs = [{
      id: "docs-agent", ownerId: "local-user", service: "notion", allowedActions: ["search_pages"],
      dataset: "documents", resourceType: "document", input: {}, goal: "同步文档",
    }, {
      id: "calendar-agent", ownerId: "local-user", service: "google_calendar", allowedActions: ["list_events"],
      dataset: "calendar_events", resourceType: "calendar", input: {}, goal: "同步日程",
    }];
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CLI_CONNECTOR_SYNC_JOBS: JSON.stringify(jobs),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let service: ConnectorSyncService;
    const runtime = syncRuntime((input) => {
      if (input.pageLabel.startsWith("document")) {
        const result = service.writeAgentBatch(input.runId, "document", [{
          sourceRecordId: "notion-page-1", documentId: "page-1", title: "产品方案",
          ownerName: "李四", documentType: "page", bodyText: "方案正文", sourceUrl: "https://notion.so/page-1",
          sourceUpdatedAt: "2026-08-19T08:00:00Z", extensionPayload: {},
        }]);
        service.finishAgentRun(input.runId, { discovered: result.inserted });
      } else {
        const result = service.writeAgentBatch(input.runId, "calendar", [{
          sourceRecordId: "event-source-1", eventId: "event-1", title: "评审会", description: "评审连接器方案",
          organizer: { address: "owner@example.com" }, attendees: [{ address: "me@example.com", status: "accepted" }],
          startAt: "2026-08-20T09:00:00+08:00", endAt: "2026-08-20T10:00:00+08:00",
          allDay: false, status: "confirmed", location: "线上", sourceUpdatedAt: "2026-08-19T08:00:00Z",
          extensionPayload: {},
        }]);
        service.finishAgentRun(input.runId, { discovered: result.inserted });
      }
    });
    service = new ConnectorSyncService(database.db, config, logger);
    service.attachAgentRuntime(runtime);

    try {
      await service.initialize();
      await service.triggerJob("docs-agent");
      await service.triggerJob("calendar-agent");
      expect(database.db.select().from(connectorDocuments).all()).toEqual([
        expect.objectContaining({ title: "产品方案", documentId: "page-1" }),
      ]);
      expect(database.db.select().from(connectorCalendarEvents).all()).toEqual([
        expect.objectContaining({ title: "评审会", eventId: "event-1" }),
      ]);
      const outbox = database.db.select().from(connectorMarkdownOutbox).all();
      expect(outbox).toHaveLength(2);
      expect(outbox).toEqual(expect.arrayContaining([
        expect.objectContaining({ resourceType: "document", operation: "upsert" }),
        expect.objectContaining({ resourceType: "calendar", operation: "upsert" }),
      ]));
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function gmailMessage(messageId: string, subject: string) {
  return {
    messageId,
    threadId: `thread-${messageId}`,
    labelIds: ["INBOX"],
    subject,
    sender: "Sender <sender@example.com>",
    to: "Receiver <receiver@example.com>",
    messageTimestamp: "2026-08-20T00:00:00.000Z",
    messageText: `${subject} body`,
    attachmentList: [],
  };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for connector sync");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
