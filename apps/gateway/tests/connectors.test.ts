import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { ConnectorSyncService } from "../src/modules/connectors/service.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("ConnectorSyncService", () => {
  it("seeds configured jobs and idempotently upserts synchronized records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connectors-"));
    const config = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      OO_CONNECTOR_TOKEN: "runtime-secret",
      NXCORE_CONNECTOR_SYNC_ENABLED: "true",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "mail-recent",
        ownerId: "local-user",
        service: "gmail",
        action: "fetch_emails",
        dataset: "email",
        connectionName: "default",
        input: { query: "newer_than:1d", maxResults: 10 },
      }]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    const calls: string[][] = [];
    const service = new ConnectorSyncService(database.db, config, logger, async (_config, args) => {
      calls.push(args);
      return [{ id: "message-1", subject: "Hello", updated_at: "2026-08-19T00:00:00.000Z" }];
    });

    try {
      await service.initialize();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(calls).toHaveLength(1);
      expect(service.status("local-user").recordCount).toBe(1);
      expect(service.queryRecords({ ownerId: "local-user", service: "gmail", dataset: "email" })).toHaveLength(1);

      await service.triggerJob("mail-recent");
      expect(calls).toHaveLength(2);
      expect(service.status("local-user").recordCount).toBe(1);
      expect(service.getJob("mail-recent")?.lastError).toBeNull();
    } finally {
      service.close();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not start a scheduler when connector sync is disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nxcore-connectors-disabled-"));
    const config = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CONNECTOR_SYNC_ENABLED: "false",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "disabled-job",
        ownerId: "local-user",
        service: "github",
        action: "list_repositories",
        dataset: "repositories",
        input: {},
      }]),
    });
    const database = createDatabase(join(directory, "gateway.sqlite"), config.migrationsDir);
    let calls = 0;
    const service = new ConnectorSyncService(database.db, config, logger, async () => {
      calls += 1;
      return [];
    });

    try {
      await service.initialize();
      expect(service.getJob("disabled-job")).not.toBeNull();
      expect(calls).toBe(0);
    } finally {
      service.close();
      database.sqlite.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
