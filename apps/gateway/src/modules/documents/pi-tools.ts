import type {
  PiAgentRuntimeTool,
  PiAgentRuntimeToolResult,
} from "@nxcore/agent-runtime-pi";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { requestsDocumentModification } from "../agent/document-intent.js";
import {
  documentToolErrorPayload,
  type DocumentMcpHost,
  type DocumentMcpToolResult,
} from "./mcp-host.js";

const EXTERNAL_SERVICE_REQUEST = /(?:Gmail|GitHub|Notion|Google\s*Drive|Slack|Dropbox|Outlook|日历|邮件|邮箱|云盘|第三方服务|OAuth)/iu;
const EXPLICIT_EVERROOM_DOCUMENT_TARGET = /(?:(?:EverRoom|NxCore|Context\s*Room|ContextRoom|某个\s*Room|指定\s*Room|Room|房间).{0,24}(?:文档|文件|页面)|(?:文档|文件|页面).{0,24}(?:EverRoom|NxCore|Context\s*Room|ContextRoom|Room|房间)|(?:保存|写入|存入|落盘|创建).{0,24}(?:EverRoom|NxCore|Context\s*Room|ContextRoom|Room|房间))/iu;
const DOCUMENT_ROUTE_MISMATCH = "Document tool route mismatch";
class DocumentRouteMismatchError extends Error {
  constructor() {
    super(`${DOCUMENT_ROUTE_MISMATCH}: the user explicitly requested an external connected service. Use connector_search and the connector workflow; do not create or edit EverRoom documents.`);
    this.name = "DocumentRouteMismatchError";
  }
}

function toPiResult(result: DocumentMcpToolResult): PiAgentRuntimeToolResult {
  return {
    content: result.content.map((item) => item.text).join("\n"),
    details: result.structuredContent,
  };
}

/**
 * 文档工具面（P0-4）：不再为每个 run 粘滞「已绑定 Room」。
 *
 * 归属只来自本次调用的 `params.roomId` 或 run 级 `input.roomId`；
 * 都没有即工作区级文稿（roomId 为 null），不再强求从 available_rooms 里选房。
 */
export function createDocumentPiTools(host: DocumentMcpHost): PiAgentRuntimeTool[] {
  return host.listTools().map((definition) => ({
    name: definition.name,
    label: definition.title,
    description: definition.description,
    parameters: definition.inputSchema,
    promptSnippet: definition.title,
    promptGuidelines: [definition.description],
    executionMode: "sequential",
    execute: async (input, params) => {
      const originalPrompt = input.originalPrompt ?? input.prompt;
      if (EXTERNAL_SERVICE_REQUEST.test(originalPrompt) && !EXPLICIT_EVERROOM_DOCUMENT_TARGET.test(originalPrompt)) {
        throw new DocumentRouteMismatchError();
      }
      try {
        const requestedRoomId = typeof params.roomId === "string" ? params.roomId.trim() : "";
        const roomId = input.roomId ?? (requestedRoomId || null);
        const result = await host.callTool(
          definition.name,
          params,
          {
            agentSessionId: input.sessionId,
            runId: input.runId,
            roomId,
            workspaceId: input.workspaceId ?? null,
            availableRooms: input.availableRooms ?? [],
            ...(input.activeDocument ? { activeDocument: input.activeDocument } : {}),
            ...(input.activeFile ? { activeFile: input.activeFile } : {}),
          },
        );
        // document_list 的 selectionRequired 是桌面端“选择要编辑的文档”卡片的唯一
        // 触发源；运行本身没有改/写文档诉求时（模型顺路列文档很常见）一律压掉，
        // 否则离开文档页后旧工具结果会把空卡片顶回智能区。
        if (definition.name === "document_list" && result.structuredContent.selectionRequired === true) {
          const promptText = String(input.originalPrompt ?? input.prompt ?? "");
          if (!requestsDocumentModification(promptText)) {
            const payload = { ...result.structuredContent, selectionRequired: false };
            return {
              content: JSON.stringify(payload),
              details: payload,
            };
          }
        }
        return toPiResult(result);
      } catch (error) {
        throw new Error(JSON.stringify(documentToolErrorPayload(error)), { cause: error });
      }
    },
    classifyFailure: (error: unknown, _input: StartRuntimeRunInput, _params: Record<string, unknown>) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof DocumentRouteMismatchError) && !message.includes(DOCUMENT_ROUTE_MISMATCH)) return null;
      return {
        category: "route_mismatch",
        recoverable: true,
        recommendedTool: "connector_search",
        instruction: "Use the external service named in the original user request. Do not call document or office tools unless the user explicitly asks to create or edit an EverRoom document.",
        retryKey: "external-service-to-context-room",
        maxAttempts: 1,
      };
    },
  }));
}
