import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { ExternalDocumentProvider } from "@nxcore/agent-contract";
import type { DocumentImportService } from "./service.js";
import { ImportServiceError } from "./service.js";

/**
 * Agent 侧导入工具（B-7，方案 §13）：搜索与预览经 OpenConnector 只读链路，
 * 提交（加入 Room）复用导入面板同款 commitToRoom；能力不可用/连接缺失时
 * 返回结构化指引而不是裸错误。
 */
export function createDocumentImportPiTools(imports: DocumentImportService): PiAgentRuntimeTool[] {
  const providerOf = (value: unknown): ExternalDocumentProvider => {
    if (value === "feishu" || value === "notion") return value;
    throw new Error("provider 只支持 feishu 或 notion");
  };
  const classify = (error: unknown): object => {
    if (error instanceof ImportServiceError) {
      if (error.code === "OPEN_CONNECTOR_UNAVAILABLE") {
        return {
          category: "import_environment_unavailable",
          recoverable: false,
          instruction: "OpenConnector 服务不可用（未启动或连接失败）；引导用户重启应用或检查连接器状态，不要臆测文档内容。",
          retryKey: "document_import:environment",
        };
      }
      if (error.code === "IMPORT_CONNECTION_REQUIRED") {
        return {
          category: "import_connection_required",
          recoverable: true,
          instruction: "引导用户在连接器管理建立该服务的导入连接后重试。",
          retryKey: "document_import:connection",
          maxAttempts: 1,
        };
      }
    }
    return {
      category: "import_read_failed",
      recoverable: false,
      instruction: "如实报告读取失败原因，不要臆测文档内容。",
      retryKey: "document_import:read",
    };
  };
  return [
    {
      name: "document_import_search",
      label: "外部文档搜索",
      description: "按关键词搜索用户有权限的飞书/Notion 文档，返回可导入的候选列表（标题/链接/更新时间）。",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["feishu", "notion"], description: "来源平台" },
          query: { type: "string", description: "搜索关键词（1-60 字符）" },
        },
        required: ["provider", "query"],
        additionalProperties: false,
      } as unknown as Record<string, unknown>,
      executionMode: "sequential",
      execute: async (_input, params) => {
        const result = await imports.search(providerOf(params.provider), String(params.query).slice(0, 60));
        return { content: JSON.stringify(result), details: result };
      },
      classifyFailure: (error: unknown) => classify(error) as never,
    },
    {
      name: "document_import_preview",
      label: "外部文档预览",
      description:
        "读取一篇飞书/Notion 文档生成导入预览（正文摘录、评论、告警、快照已保存）。确认内容后可用 document_import_commit 加入 Room。",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["feishu", "notion"], description: "来源平台" },
          remoteDocumentId: { type: "string", description: "document_import_search 返回的 remoteDocumentId 或用户提供的 URL 中的 id" },
        },
        required: ["provider", "remoteDocumentId"],
        additionalProperties: false,
      } as unknown as Record<string, unknown>,
      executionMode: "sequential",
      execute: async (_input, params) => {
        const preview = await imports.preview(providerOf(params.provider), String(params.remoteDocumentId).trim());
        return { content: JSON.stringify(preview), details: preview };
      },
      classifyFailure: (error: unknown) => classify(error) as never,
    },
    {
      name: "document_import_commit",
      label: "外部文档导入 Room",
      description:
        "把 document_import_preview 产生的预览正式导入指定 Room（成为该 Room 的文档；与导入面板「加入 Room」同一条链路）。仅当用户明确要求把文档加入 Room 时调用。",
      parameters: {
        type: "object",
        properties: {
          runId: { type: "string", description: "document_import_preview 返回的 runId" },
          roomId: { type: "string", description: "目标 Room id" },
        },
        required: ["runId", "roomId"],
        additionalProperties: false,
      } as unknown as Record<string, unknown>,
      executionMode: "sequential",
      execute: async (_input, params) => {
        const result = await imports.commitToRoom({
          runId: String(params.runId).trim(),
          roomId: String(params.roomId).trim(),
        });
        return { content: JSON.stringify(result), details: result };
      },
      classifyFailure: (error: unknown) => classify(error) as never,
    },
  ];
}
