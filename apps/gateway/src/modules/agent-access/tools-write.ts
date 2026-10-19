import { createHash } from "node:crypto";
import { isSupportedUploadFilename } from "../files/service.js";
import type { AgentAccessService } from "./service.js";
import type { AgentAccessState, AgentSubmissionItem, ResolvedAgentConnection } from "./types.js";
import type { AgentAccessTool } from "./tools-read.js";

const FILE_BYTES_LIMIT = 20 * 1024 * 1024;

function state<T>(status: AgentAccessState<T>["status"], data?: T, message?: string): AgentAccessState<T> {
  const result: AgentAccessState<T> = { status };
  if (data !== undefined) result.data = data;
  if (message !== undefined) result.message = message;
  return result;
}

const SUBMISSION_ITEM_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "session_increment" },
        platform: { type: "string", maxLength: 40 },
        threadId: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", maxLength: 300 },
        messages: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            properties: {
              messageId: { type: "string", minLength: 1, maxLength: 200 },
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string", maxLength: 100_000 },
              occurredAt: { type: "string", maxLength: 40 },
            },
            required: ["messageId", "role", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "platform", "threadId", "messages"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "result_text" },
        title: { type: "string", minLength: 1, maxLength: 200 },
        content: { type: "string", minLength: 1, maxLength: 500_000 },
        roomId: { type: "string", maxLength: 128 },
      },
      required: ["kind", "title", "content"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "artifact_file" },
        filename: { type: "string", minLength: 1, maxLength: 200 },
        contentBase64: { type: "string", minLength: 1 },
        roomId: { type: "string", maxLength: 128 },
      },
      required: ["kind", "filename", "contentBase64"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "citation" },
        targetUri: { type: "string", minLength: 1, maxLength: 300 },
        quote: { type: "string", maxLength: 2000 },
        note: { type: "string", maxLength: 2000 },
      },
      required: ["kind", "targetUri"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", const: "candidate" },
        candidateType: { type: "string", enum: ["memory", "wiki", "preference"] },
        content: { type: "string", minLength: 1, maxLength: 20_000 },
        evidence: { type: "string", maxLength: 20_000 },
        roomId: { type: "string", maxLength: 128 },
      },
      required: ["kind", "candidateType", "content"],
      additionalProperties: false,
    },
  ],
};

/** 回写三件套：可控文件登记 + 幂等统一提交 + 提交状态查询（PRD 7.4 / A.3 提交键）。 */
export function createWriteTools(
  connection: ResolvedAgentConnection,
  service: AgentAccessService,
  registerArtifact: (input: {
    filename: string;
    buffer: Buffer;
    roomId: string | null;
    sourceKey: string;
  }) => Promise<{ fileEntryId: string; contentHash: string; filename: string }>,
): AgentAccessTool[] {
  const registerFile: AgentAccessTool = {
    name: "everroom_register_file",
    title: "登记文件（可控入口）",
    description:
      "把文件字节提交到可控文件入口：校验类型白名单与 sha256 完整性后入库（sourceKind=agent-generated），返回 fileEntryId 与可打开位置。本机路径登记走桌面连接页的可控入口。",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", minLength: 1, maxLength: 200 },
        contentBase64: { type: "string", minLength: 1 },
        roomId: { type: "string", maxLength: 128 },
      },
      required: ["filename", "contentBase64"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: ["register_files"],
    execute: async (args) => {
      const filename = String(args.filename ?? "");
      if (!isSupportedUploadFilename(filename)) {
        return state("invalid_input", { filename }, "文件类型不在支持清单内；请转换格式或改交文本");
      }
      const buffer = Buffer.from(String(args.contentBase64 ?? ""), "base64");
      if (buffer.byteLength === 0 || buffer.byteLength > FILE_BYTES_LIMIT) {
        return state("invalid_input", { filename }, "文件为空或超过 20MB 上限");
      }
      const roomId = typeof args.roomId === "string" && args.roomId
        ? args.roomId
        : connection.scopes.writebackRoomId;
      if (roomId && !(connection.scopes.roomIds === "all" || connection.scopes.roomIds.includes(roomId))) {
        return state("no_permission", undefined, "目标 Room 不在本连接授权范围内");
      }
      const imported = await registerArtifact({
        filename,
        buffer,
        roomId,
        sourceKey: `agent-file:${connection.id}:${createHash("sha256").update(buffer).digest("hex")}`,
      });
      return state("ok", {
        fileEntryId: imported.fileEntryId,
        contentHash: imported.contentHash,
        filename: imported.filename,
        byteSize: buffer.byteLength,
        roomId,
        deepLink: `everroom://open/file/${imported.fileEntryId}`,
      });
    },
  };

  const submit: AgentAccessTool = {
    name: "everroom_submit",
    title: "回写提交（幂等）",
    description:
      "提交会话增量、结果文本、产物文件、来源引用或记忆/Wiki/偏好候选。submissionId 由客户端生成并复用：重试同一 submissionId 不会重复入库（返回 duplicate 与原结果）。候选进入待确认队列，不会未经用户确认写入长期记忆。",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
        items: { type: "array", minItems: 1, maxItems: 50, items: SUBMISSION_ITEM_SCHEMA },
      },
      required: ["submissionId", "items"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: ["write_session", "write_candidates"],
    execute: async (args) => {
      const submissionId = String(args.submissionId ?? "");
      const items = Array.isArray(args.items) ? (args.items as AgentSubmissionItem[]) : [];
      try {
        const outcome = await service.submit(connection, submissionId, items);
        return state(outcome.status === "duplicate" ? "duplicate" : "ok", outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("agent_access_submission_")) {
          return state("invalid_input", undefined, message);
        }
        throw error;
      }
    },
  };

  const submitStatus: AgentAccessTool = {
    name: "everroom_submit_status",
    title: "查询提交结果",
    description: "按 submissionId 查询一次回写提交的处理结果与逐项状态。",
    inputSchema: {
      type: "object",
      properties: {
        submissionId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
      },
      required: ["submissionId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    capabilities: "always",
    execute: async (args) => {
      const record = service.getSubmission(connection.id, String(args.submissionId ?? ""));
      if (!record) {
        return state("empty", undefined, "没有这个提交标识的记录；可检查 submissionId 或重新提交");
      }
      return state("ok", record);
    },
  };

  return [registerFile, submit, submitStatus];
}
