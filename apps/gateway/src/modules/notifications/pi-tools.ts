import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { NotificationMcpHost } from "./mcp-host.js";

export function createNotificationPiTools(host:NotificationMcpHost):PiAgentRuntimeTool[]{
  return host.listTools().map(definition=>({
    name:definition.name,label:definition.title,description:definition.description,parameters:definition.inputSchema,
    promptSnippet:definition.title,promptGuidelines:[definition.description],executionMode:"sequential",
    execute:async(input,params)=>{const result=await host.callTool(definition.name,params,{agentSessionId:input.sessionId,runId:input.runId,roomId:input.roomId,availableRooms:input.availableRooms??[],...(input.activeDocument?{activeDocument:input.activeDocument}:{})});return{content:result.content.map(item=>item.text).join("\n"),details:result.structuredContent};},
  }));
}
