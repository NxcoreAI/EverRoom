import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { ExternalDocumentProvider } from "@nxcore/agent-contract";
import type { DocumentImportService } from "./service.js";
import { ImportServiceError } from "./service.js";

/**
 * Agent 侧导入工具（B-7，方案 §13）：搜索与预览经 OpenConnector 只读链路；
 * 能力不可用/连接缺失时返回结构化指引而不是裸错误。正式提交（加入 Room）
 * 仍由用户在导入面板完成——Agent 只负责找到文档并给用户预览。
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
          instruction: "导入通道等待 OpenConnector 迁入后开放；向用户说明当前暂不支持外部文档导入。",
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
        "读取一篇飞书/Notion 文档生成导入预览（正文摘录、评论、告警、快照已保存）。用户确认后从导入面板加入 Room。",
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
  ];
}
