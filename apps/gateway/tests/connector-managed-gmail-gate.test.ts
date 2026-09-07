import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  connectorSyncJobStates,
  connectorSyncJobs,
  connectorSyncRuns,
} from "../src/infrastructure/database/schema.js";
import { ConnectorSyncService } from "@nxcore/connectors-module/service.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const account = [{ service: "gmail", connectionName: "primary-mailbox", status: "active", displayName: "Primary" }];

function managedGmailJobId(connectionName: string, mode: "bootstrap" | "incremental"): string {
  const suffix = createHash("sha256").update(connectionName).digest("hex").slice(0, 12);
  return `managed-gmail-${suffix}-${mode}`;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "nxcore-managed-gmail-gate-"));
  const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", directory], {
    NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:1",
    NXCORE_CLI_CONNECTOR_SYNC_ENABLED: "true",
  });
  const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
  const runner = vi.fn(async () => ({ data: {} }));
  const service = new ConnectorSyncService(
    database.db,
    config,
    logger,
    runner,
    async () => account,
  );
  return { directory, database, runner, service };
}

function seedManagedGmailJobs(database: Awaited<ReturnType<typeof setup>>["database"], now: Date): void {
  const jobs = (["bootstrap", "incremental"] as const).map((mode) => ({
    id: managedGmailJobId("primary-mailbox", mode),
    ownerId: "local-user",
    name: `Gmail ${mode} · Primary`,
    service: "gmail",
    action: mode === "bootstrap" ? "fetch_emails" : "list_history",
    allowedActions: ["get_profile", "fetch_emails", "list_history"],
    dataset: "emails",
    resourceType: "email",
    connectionName: "primary-mailbox",
    input: { everroomSyncMode: mode, detail: "full", maxResults: 50 },
    goal: "test managed job",
    promptVersion: 1,
    schemaVersion: 1,
    intervalMs: 60_000,
    scheduleType: "interval",
    status: "active",
    enabled: true,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  }));
  for (const job of jobs) {
    database.db.insert(connectorSyncJobs).values(job as never).run();
    database.db.insert(connectorSyncJobStates).values({
      jobId: job.id,
      nextRunAt: now,
      updatedAt: now,
    }).run();
  }
}

describe("ConnectorSyncService managed-gmail 让位 gate", () => {
  it("pauses existing managed gmail jobs and skips them while the gate is on", async () => {
    const { directory, database, runner, service } = await setup();
    const now = new Date();
    seedManagedGmailJobs(database, now);
    service.setManagedGmailGate(() => true);
    try {
      await (service as any).refreshAccountsAndProvisionJobs(now);
      const rows = database.db.select().from(connectorSyncJobs).all()
        .filter((job) => job.id.startsWith("managed-gmail-"));
      // 既有任务全部让位：暂停、禁用、清空 nextRunAt；且不补建缺失任务。
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("paused");
        expect(row.enabled).toBe(false);
        expect(row.nextRunAt).toBeNull();
      }
      // gate 期间 tick 与手动触发都不跑 managed gmail 任务。
      await (service as any).tick();
      const bootstrap = database.db.select().from(connectorSyncJobs).all()
        .find((job) => job.id === managedGmailJobId("primary-mailbox", "bootstrap"))!;
      await (service as any).runJob(bootstrap);
      expect(database.db.select().from(connectorSyncRuns).all()).toEqual([]);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves managed gmail provisioning untouched when the gate is off", async () => {
    const { directory, database, service } = await setup();
    try {
      // managed gmail job 引用 gmail-email-sync-v1 prompt profile（FK），先播种再供给。
      (service as any).seedPromptProfiles(new Date());
      await (service as any).refreshAccountsAndProvisionJobs(new Date());
      const bootstrapId = managedGmailJobId("primary-mailbox", "bootstrap");
      const bootstrap = database.db.select().from(connectorSyncJobs).all()
        .find((job) => job.id === bootstrapId);
      expect(bootstrap).toMatchObject({ status: "active", enabled: true, service: "gmail" });
      const incrementalId = managedGmailJobId("primary-mailbox", "incremental");
      const incremental = database.db.select().from(connectorSyncJobs).all()
        .find((job) => job.id === incrementalId);
      // 增量任务在 bootstrap 产出 historyId 检查点前保持 paused（既有语义不变）。
      expect(incremental).toMatchObject({ status: "paused", enabled: false });
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps user jobs unaffected by the gate", async () => {
    const { directory, database, runner, service } = await setup();
    const now = new Date();
    seedManagedGmailJobs(database, now);
    database.db.insert(connectorSyncJobs).values({
      id: "user-custom-mail",
      ownerId: "local-user",
      name: "自定义邮件任务",
      service: "gmail",
      action: "fetch_emails",
      allowedActions: ["fetch_emails"],
      dataset: "emails",
      resourceType: "email",
      connectionName: "primary-mailbox",
      input: { query: "newer_than:1d", detail: "full" },
      goal: "user job",
      promptVersion: 1,
      schemaVersion: 1,
      intervalMs: 60_000,
      scheduleType: "interval",
      status: "active",
      enabled: true,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    } as never).run();
    database.db.insert(connectorSyncJobStates).values({
      jobId: "user-custom-mail",
      nextRunAt: now,
      updatedAt: now,
    }).run();
    service.setManagedGmailGate(() => true);
    try {
      await (service as any).refreshAccountsAndProvisionJobs(now);
      // gate 只针对 managed-gmail- 前缀：用户自建任务照常执行。
      await (service as any).tick();
      expect(runner).toHaveBeenCalled();
      const userJob = database.db.select().from(connectorSyncJobs).all()
        .find((job) => job.id === "user-custom-mail")!;
      expect(userJob.status).toBe("active");
    } finally {
      await service.dispose();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
