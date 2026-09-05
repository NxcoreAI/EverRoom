import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { ConnectorSyncService } from "./service.js";

export function createConnectorDataPiTools(service: ConnectorSyncService, defaultOwnerId = "local-user"): PiAgentRuntimeTool[] {
  return [
    {
      name: "connector_data_search",
      label: "Search local connector data",
      description: "Search data already synchronized from connected services. This tool never calls a provider or the connector CLI.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", minLength: 1, maxLength: 128 },
          dataset: { type: "string", minLength: 1, maxLength: 128 },
          query: { type: "string", maxLength: 500 },
          limit: { type: "number", minimum: 1, maximum: 20 },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (_input, params) => {
        const records = service.queryRecords({
          ownerId: defaultOwnerId,
          ...(typeof params.service === "string" ? { service: params.service } : {}),
          ...(typeof params.dataset === "string" ? { dataset: params.dataset } : {}),
          ...(typeof params.query === "string" ? { query: params.query } : {}),
          ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        });
        return {
          content: JSON.stringify({
            source: "everroom-local-connector-store",
            count: records.length,
            records,
          }),
          details: { count: records.length, source: "local" },
        };
      },
    },
    {
      name: "connector_record_get",
      label: "Read one local connector record",
      description: "Read one complete synchronized domain record by its local record ID. This tool never calls a provider or the connector CLI.",
      parameters: {
        type: "object",
        properties: {
          recordId: { type: "string", minLength: 1, maxLength: 128 },
        },
        required: ["recordId"],
        additionalProperties: false,
      },
      execute: async (_input, params) => {
        const record = service.getRecord(defaultOwnerId, String(params.recordId));
        return {
          content: JSON.stringify(record ? { source: "everroom-local-connector-store", record } : { status: "not_found" }),
          details: { found: Boolean(record), source: "local" },
        };
      },
    },
    {
      name: "connector_sync_status",
      label: "Show connector sync status",
      description: "Show local connector sync freshness and job state without invoking the connector CLI.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        const status = service.status(defaultOwnerId);
        return {
          content: JSON.stringify(status),
          details: status,
        };
      },
    },
  ];
}
