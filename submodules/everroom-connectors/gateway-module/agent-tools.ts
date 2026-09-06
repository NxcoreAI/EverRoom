import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { OpenConnectorCliConfig } from "./host-types.js";
import { createOpenConnectorPiTools } from "./open-connector-tools.js";
import type { ConnectorSyncService } from "./service.js";

const nullableString = { type: ["string", "null"] };
const nullableDate = { type: ["string", "number", "null"], description: "ISO-8601 date, timestamp, or null." };
const address = {
  type: "object",
  properties: { name: { type: "string" }, address: { type: "string" }, status: { type: "string" } },
  additionalProperties: false,
};

const domainRecordSchema = {
  type: "object",
  description: "One normalized email, document, or calendar record. The service validates required fields for resourceType.",
  properties: {
    sourceRecordId: { type: "string", minLength: 1 },
    sourceUpdatedAt: nullableDate,
    extensionPayload: { type: ["object", "null"], additionalProperties: true },
    messageId: { type: "string", minLength: 1 },
    threadId: nullableString,
    senderName: nullableString,
    senderAddress: nullableString,
    recipients: { type: "array", items: address },
    subject: { type: "string" },
    sentAt: nullableDate,
    bodyText: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    hasAttachments: { type: "boolean" },
    documentId: { type: "string", minLength: 1 },
    title: { type: "string" },
    ownerName: nullableString,
    documentType: nullableString,
    sourceUrl: nullableString,
    description: { type: "string" },
    organizer: { type: ["object", "null"], properties: address.properties, additionalProperties: false },
    attendees: { type: "array", items: address },
    startAt: nullableDate,
    endAt: nullableDate,
    allDay: { type: "boolean" },
    status: nullableString,
    location: nullableString,
  },
  additionalProperties: true,
};

export function createConnectorSyncAgentTools(
  connector: OpenConnectorCliConfig,
  service: ConnectorSyncService,
): PiAgentRuntimeTool[] {
  const connectorTools = createOpenConnectorPiTools(connector).map((tool) => ({
    ...tool,
    execute: (input: StartRuntimeRunInput, params: Record<string, unknown>, signal?: AbortSignal) => tool.execute(
      input,
      service.authorizeAgentConnectorCall(input, tool.name, params),
      signal,
    ),
  }));

  return [
    ...connectorTools,
    {
      name: "sync_write_batch",
      label: "校验并写入同步数据",
      description: "将已经清洗并映射到目标领域 Schema 的记录批量写入本地数据库。服务端执行类型校验、幂等 upsert 和事务控制。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          resourceType: { type: "string", enum: ["email", "document", "calendar"] },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: domainRecordSchema,
          },
        },
        required: ["resourceType", "records"],
        additionalProperties: false,
      },
      promptGuidelines: [
        "Only write records that match the target schema in the system prompt.",
        "Do not invent missing source IDs or business facts.",
        "Inspect rejected records and quarantine them before finishing the sync run.",
      ],
      execute: async (input, params) => {
        const result = service.writeAgentBatch(
          input.runId,
          String(params.resourceType) as "email" | "document" | "calendar",
          params.records as unknown[],
        );
        return { content: JSON.stringify(result), details: result };
      },
    },
    {
      name: "sync_quarantine",
      label: "隔离无法解析的同步记录",
      description: "保存无法可靠映射到领域 Schema 的原始记录与原因，使同步统计可核对且问题可追踪。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          records: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                sourceRecordId: { type: "string" },
                reason: {
                  type: "string",
                  minLength: 1,
                  maxLength: 1000,
                  description: "Why the record could not be mapped. The service supplies a generic reason if omitted.",
                },
                payload: { type: "object", additionalProperties: true },
              },
              required: ["payload"],
              additionalProperties: false,
            },
          },
        },
        required: ["records"],
        additionalProperties: false,
      },
      execute: async (input, params) => {
        const result = service.quarantineAgentRecords(
          input.runId,
          params.records as Array<{ sourceRecordId?: string; reason?: string; payload: Record<string, unknown> }>,
        );
        return { content: JSON.stringify(result), details: result };
      },
    },
    {
      name: "sync_finish",
      label: "完成同步并提交检查点",
      description: "在全部分页和记录处理完成后核对统计并提交新的同步检查点。每次运行只能成功调用一次。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          discovered: { type: "integer", minimum: 0 },
          checkpoint: { type: ["object", "null"], additionalProperties: true },
        },
        required: ["discovered"],
        additionalProperties: false,
      },
      promptGuidelines: [
        "Call exactly once after every provider page and every returned record has been accounted for.",
        "Never call when a write or quarantine operation failed.",
      ],
      execute: async (input, params) => {
        const result = service.finishAgentRun(input.runId, {
          discovered: Number(params.discovered),
          checkpoint: params.checkpoint == null
            ? null
            : params.checkpoint as Record<string, unknown>,
        });
        return { content: JSON.stringify(result), details: result };
      },
    },
  ];
}
