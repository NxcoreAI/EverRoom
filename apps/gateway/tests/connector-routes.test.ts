import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { describe, expect, it, vi } from "vitest";
import { cliConnectorRoutes } from "@nxcore/connectors-module/routes.js";
import type { ConnectorSyncService } from "@nxcore/connectors-module/service.js";
import type { IngestService } from "../src/modules/ingest/service.js";

describe("connector data routes", () => {
  it("passes pagination through and isolates bulk ingest failures", async () => {
    const queryRecordPage = vi.fn().mockReturnValue({ items: [], total: 1048, limit: 25, offset: 50 });
    const getRecord = vi.fn((_ownerId: string, recordId: string) => {
      if (recordId === "email-1") return { id: recordId, resourceType: "email" };
      if (recordId === "document-1") return { id: recordId, resourceType: "document" };
      if (recordId === "todo-1") return { id: recordId, resourceType: "todo" };
      if (recordId === "generic-1") return { id: recordId, resourceType: "generic" };
      return null;
    });
    const service = {
      currentOwnerId: () => "local-user",
      queryRecordPage,
      getRecord,
    } as unknown as ConnectorSyncService;
    const ingest = {
      ingest: vi.fn(async (input: { source: { ref?: { sourceKind: string; sourceId: string } } }) => {
        const ref = input.source.ref!;
        if (ref.sourceId === "document-1") throw new Error("document conversion failed");
        return { eventId: "ing-1", deduped: false, routeJobId: "route-1" };
      }),
    } as unknown as IngestService;
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(cliConnectorRoutes(service, ingest));

    try {
      const pageResponse = await app.inject({
        method: "GET",
        url: "/v1/cli-connectors/data?dataset=emails&limit=25&offset=50",
      });
      expect(pageResponse.statusCode).toBe(200);
      expect(pageResponse.json()).toMatchObject({ total: 1048, limit: 25, offset: 50 });
      expect(queryRecordPage).toHaveBeenCalledWith(expect.objectContaining({
        ownerId: "local-user", dataset: "emails", limit: 25, offset: 50,
      }));

      const ingestResponse = await app.inject({
        method: "POST",
        url: "/v1/cli-connectors/data/ingest",
        payload: { recordIds: ["email-1", "document-1", "todo-1", "generic-1", "missing-1"] },
      });
      expect(ingestResponse.statusCode).toBe(200);
      expect(ingestResponse.json()).toMatchObject({ imported: 3, deduped: 0, failed: 2 });
      expect(ingest.ingest).toHaveBeenNthCalledWith(1, {
        source: { ref: { sourceKind: "connector-email", sourceId: "email-1" } },
        originChannel: "connector",
      });
      expect(ingest.ingest).toHaveBeenNthCalledWith(2, {
        source: { ref: { sourceKind: "connector-document", sourceId: "document-1" } },
        originChannel: "connector",
      });
      expect(ingest.ingest).toHaveBeenNthCalledWith(3, {
        source: { ref: { sourceKind: "connector-todo", sourceId: "todo-1" } },
        originChannel: "connector",
      });
      expect(ingest.ingest).toHaveBeenNthCalledWith(4, {
        source: { ref: { sourceKind: "connector-record", sourceId: "generic-1" } },
        originChannel: "connector",
      });
    } finally {
      await app.close();
    }
  });
});
