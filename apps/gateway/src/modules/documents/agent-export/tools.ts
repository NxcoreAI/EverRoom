import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type {
  AgentDocumentExportRunView,
  AgentDocumentExportTarget,
} from "@nxcore/agent-contract";
import type { AgentDocumentExportService, CreateExportInput } from "./service.js";
import { ExportServiceError } from "./service.js";

/**
 * `document_export`：Agent 智能区导出入口。与文档"三个点"菜单共用
 * AgentDocumentExportService（同一确认逻辑、CLI 适配器与审计记录）；工具
 * 结果只包含结构化状态与 challenge，不包含任何 token。
 */
export function createDocumentExportPiTools(
  service: AgentDocumentExportService,
): PiAgentRuntimeTool[] {
  return [{
    name: "document_export",
    label: "文档导出",
    description:
      "把指定 Room 文档的固定版本一次性导出到飞书或 Notion（create 新建或 update 更新用户明确指定的远端文档）。"
      + "任务固定版本渲染，导出期间的后续编辑不影响本次 payload；不做双向同步，也不自动重试不确定的写入。",
    parameters: {
      type: "object",
      properties: {
        roomId: { type: "string", description: "文档所属 Room ID" },
        documentId: { type: "string", description: "要导出的 Room 文档 ID" },
        version: { type: "integer", description: "固定导出的版本号；缺省为当前版本" },
        provider: { type: "string", enum: ["feishu", "notion"], description: "目标平台" },
        mode: { type: "string", enum: ["create", "update", "export_file"], description: "create 新建文档；update 更新用户明确指定的已有文档；export_file 导出为飞书云空间 .md 文件（仅 feishu）" },
        target: {
          type: "object",
          description: "目标信息。update 必须提供 remoteUrl 或 remoteDocumentId（来自用户，不得猜测）；writeScope 缺省 append（安全追加），replace_document 需用户明确选择。",
          properties: {
            remoteUrl: { type: "string" },
            remoteDocumentId: { type: "string" },
            parentUrl: { type: "string" },
            parentId: { type: "string" },
            writeScope: { type: "string", enum: ["append", "replace_document"] },
          },
          additionalProperties: false,
        },
      },
      required: ["roomId", "documentId", "provider", "mode"],
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    promptGuidelines: [
      "update 模式的目标文档必须由用户提供（URL 或明确选择）；禁止根据历史导出记录自动选择目标。",
      "update 默认追加（append）到目标文档末尾；只有用户明确要求替换整篇时才传 target.writeScope=replace_document。",
      "结果为 awaiting_confirmation 时，把目标标题、URL、写入范围和告警转述给用户确认；用户同意后再次调用本工具不会自动执行——由用户在界面确认（或使用返回的 runId 调用确认入口）。",
      "结果为 awaiting_auth 时，向用户说明授权步骤卡片已出现，等待用户完成授权后重新发起导出请求。",
      "结果为 environment_not_ready 时不要重试，直接告知用户导出环境未就绪，需要通过产品更新修复。",
      "导出成功后只报告远端 URL 与版本，不承诺后续自动同步。",
    ],
    executionMode: "sequential",
    execute: async (_input, params) => {
      const provider = String(params.provider);
      const mode = String(params.mode);
      if (provider !== "feishu" && provider !== "notion") {
        throw new Error("provider 只支持 feishu 或 notion");
      }
      if (!["create", "update", "export_file"].includes(mode)) {
        throw new Error("mode 只支持 create、update 或 export_file");
      }
      if (mode === "export_file" && provider !== "feishu") {
        throw new Error("export_file 目前仅支持飞书（lark-cli markdown 域）");
      }
      const missing: string[] = [];
      if (mode === "update" && !params.target) missing.push("target");
      if (missing.length > 0) {
        // 参数缺失不硬报错：返回 needs_input，渲染层自动弹出导出面板补齐（§6.4）。
        const summary = {
          status: "needs_input",
          missing,
          roomId: String(params.roomId),
          documentId: String(params.documentId),
          provider,
          mode: mode as CreateExportInput["mode"],
        };
        return { content: JSON.stringify(summary), details: summary };
      }
      const input: CreateExportInput = {
        roomId: String(params.roomId),
        documentId: String(params.documentId),
        version: typeof params.version === "number" ? params.version : undefined,
        provider,
        mode: mode as CreateExportInput["mode"],
        target: (params.target ?? null) as AgentDocumentExportTarget | null,
      };
      const view: AgentDocumentExportRunView = await service.runExport(input);
      return {
        content: JSON.stringify(summarizeExport(view)),
        details: view,
      };
    },
    classifyFailure: (error: unknown) => {
      if (error instanceof ExportServiceError) {
        const terminal = ["VERSION_NOT_FOUND", "NOT_FOUND", "ROOM_MISMATCH", "EXPORT_PAYLOAD_EMPTY", "EXPORT_PAYLOAD_TOO_LARGE", "EXPORT_TARGET_REQUIRED", "EXPORT_MODE_UNSUPPORTED"];
        if (terminal.includes(error.code)) {
          return {
            category: "invalid_input",
            recoverable: false,
            instruction: `修正参数后重试：${error.message}`,
            retryKey: `document_export:${error.code}`,
          };
        }
        return {
          category: "export_precheck_failed",
          recoverable: true,
          instruction: `导出前置检查未通过（${error.message}）。按错误提示补齐目标、授权或环境后，由用户再次发起导出。`,
          retryKey: `document_export:${error.code}`,
          maxAttempts: 1,
        };
      }
      return {
        category: "export_write_failed",
        recoverable: false,
        instruction: "导出执行失败。写入结果不确定时已标记 needs_review；请把错误如实报告给用户，不要自动重试。",
        retryKey: "document_export:write",
      };
    },
  }];
}

function summarizeExport(view: AgentDocumentExportRunView): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    runId: view.id,
    status: view.status,
    provider: view.provider,
    mode: view.mode,
    documentId: view.documentId,
    version: view.version,
  };
  if (view.challenge) summary.challenge = view.challenge;
  if (view.confirmation) summary.confirmation = view.confirmation;
  if (view.remoteUrl) summary.remoteUrl = view.remoteUrl;
  if (view.warnings.length > 0) summary.warnings = view.warnings;
  if (view.errorCode) {
    summary.error = { code: view.errorCode, message: view.errorMessage };
  }
  return summary;
}
