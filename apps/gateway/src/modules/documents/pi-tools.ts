import type {
  PiAgentRuntimeTool,
  PiAgentRuntimeToolResult,
} from "@nxcore/agent-runtime-pi";
import {
  documentToolErrorPayload,
  type DocumentMcpHost,
  type DocumentMcpToolResult,
} from "./mcp-host.js";

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
  }));
}
