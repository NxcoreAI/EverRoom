import type {
  PiAgentRuntimeTool,
  PiAgentRuntimeToolResult,
} from "@nxcore/agent-runtime-pi";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import {
  documentToolErrorPayload,
  type DocumentMcpHost,
  type DocumentMcpToolResult,
} from "./mcp-host.js";

const EXTERNAL_SERVICE_REQUEST = /(?:Gmail|GitHub|Notion|Google\s*Drive|Slack|Dropbox|Outlook|日历|邮件|邮箱|云盘|第三方服务|OAuth)/iu;
const EXPLICIT_EVERROOM_DOCUMENT_TARGET = /(?:(?:EverRoom|NxCore|Context\s*Room|ContextRoom|某个\s*Room|指定\s*Room|Room|房间).{0,24}(?:文档|文件|页面)|(?:文档|文件|页面).{0,24}(?:EverRoom|NxCore|Context\s*Room|ContextRoom|Room|房间)|(?:保存|写入|存入|落盘|创建).{0,24}(?:EverRoom|NxCore|Context\s*Room|ContextRoom|Room|房间))/iu;
const DOCUMENT_ROUTE_MISMATCH = "Context Room tool route mismatch";
class DocumentRouteMismatchError extends Error {
  constructor() {
    super(`${DOCUMENT_ROUTE_MISMATCH}: the user explicitly requested an external connected service. Use connector_search and the connector workflow; do not list or write Context Rooms.`);
    this.name = "DocumentRouteMismatchError";
  }
}

function toPiResult(result: DocumentMcpToolResult): PiAgentRuntimeToolResult {
  return {
    content: result.content.map((item) => item.text).join("\n"),
    details: result.structuredContent,
  };
}

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
        return toPiResult(await host.callTool(
          definition.name,
          params,
          {
            agentSessionId: input.sessionId,
            runId: input.runId,
            roomId: input.roomId,
            availableRooms: input.availableRooms ?? [],
            ...(input.activeDocument ? { activeDocument: input.activeDocument } : {}),
          },
        ));
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
        instruction: "Use the external service named in the original user request. Do not call any context_room_* tool unless the user explicitly names EverRoom, Context Room, or a Room as the destination.",
        retryKey: "external-service-to-context-room",
        maxAttempts: 1,
      };
    },
  }));
}
