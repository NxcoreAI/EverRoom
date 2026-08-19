import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("connector sync configuration", () => {
  it("parses the local Agent mode and static sync job registry", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_CONNECTOR_AGENT_MODE: "local",
      NXCORE_CONNECTOR_SYNC_ENABLED: "true",
      NXCORE_CONNECTOR_SYNC_INTERVAL_MS: "10000",
      NXCORE_CONNECTOR_SYNC_OWNER_ID: "desktop-user",
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "calendar-daily",
        ownerId: "desktop-user",
        service: "google_calendar",
        action: "list_events",
        allowedActions: ["get_event"],
        dataset: "calendar_events",
        resourceType: "calendar",
        goal: "同步未来一天日程",
        input: { days: 1 },
      }]),
    });

    expect(config.connectorAgentMode).toBe("local");
    expect(config.connectorSyncEnabled).toBe(true);
    expect(config.connectorSyncIntervalMs).toBe(10_000);
    expect(config.connectorSyncOwnerId).toBe("desktop-user");
    expect(config.connectorSyncJobs).toEqual([expect.objectContaining({
      id: "calendar-daily",
      service: "google_calendar",
      resourceType: "calendar",
      allowedActions: ["list_events", "get_event"],
      goal: "同步未来一天日程",
      input: { days: 1 },
    })]);
  });

  it("rejects malformed or unsafe sync jobs", () => {
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_CONNECTOR_SYNC_JOBS: "not-json",
    })).toThrow("must be valid JSON");

    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "unsafe",
        ownerId: "local-user",
        service: "gmail",
        action: "fetch_emails",
        dataset: "email",
        intervalMs: 100,
      }]),
    })).toThrow("must be at least 5000");

    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_CONNECTOR_SYNC_JOBS: JSON.stringify([{
        id: "unsafe-mail",
        ownerId: "local-user",
        service: "gmail",
        allowedActions: ["send_email"],
        dataset: "emails",
        resourceType: "email",
      }]),
    })).toThrow("is not read-only");
  });
});
