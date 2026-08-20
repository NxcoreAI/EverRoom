import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRuntime, RuntimeEvent, RuntimeRun, StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { desc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
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
  it("writes email records idempotently and commits the checkpoint only after sync_finish", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connector-agent-"));
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([emailJob()]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let service: ConnectorSyncService;
    let invocation = 0;
    const runtime = syncRuntime((input) => {
      invocation += 1;
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
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([emailJob()]),
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
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify(jobs),
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
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
