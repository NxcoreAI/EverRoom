import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentSchedulerService } from "./service.js";

const JsonRpcBody = Type.Object({
  jsonrpc: Type.Optional(Type.Literal("2.0")),
  id: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
  method: Type.String(),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const tools = [
  {
    name: "agent_schedule_list",
    description: "列出 EverRoom 中所有 Agent 定时任务及其运行状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agent_schedule_run",
    description: "立即执行一个 Agent 定时任务。内置任务和用户创建的任务都支持。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "任务 ID" } }, required: ["id"], additionalProperties: false },
  },
];

function result(id: string | number | undefined, value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: string | number | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Stateless Streamable-HTTP-compatible MCP endpoint for Agents and local tools. */
export function agentSchedulerMcpRoutes(service: AgentSchedulerService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/mcp/agent-schedules", { schema: { tags: ["agent-scheduler", "mcp"], body: JsonRpcBody } }, async (request) => {
      const { id, method, params } = request.body;
      try {
        if (method === "initialize") {
          return result(id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "everroom-agent-schedules", version: "1.0.0" } });
        }
        if (method === "notifications/initialized") return {};
        if (method === "tools/list") return result(id, { tools });
        if (method !== "tools/call") return error(id, -32601, `Unsupported MCP method: ${method}`);
        const name = typeof params?.name === "string" ? params.name : "";
        const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
        if (name === "agent_schedule_list") {
          const data = service.list();
          return result(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: { schedules: data } });
        }
        if (name === "agent_schedule_run") {
          if (typeof args.id !== "string" || !args.id.trim()) return error(id, -32602, "id is required");
          const run = await service.runNow(args.id);
          return result(id, { content: [{ type: "text", text: `已触发定时任务 ${args.id}，runId=${run.runId}` }], structuredContent: run });
        }
        return error(id, -32602, `Unknown MCP tool: ${name}`);
      } catch (cause) {
        return error(id, -32000, cause instanceof Error ? cause.message : String(cause));
      }
    });
  };
}
