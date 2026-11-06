import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";

import { formatPlanClaimPackage, type PlanItem } from "@nxcore/agent-contract";

import { PlanError, type PlanService } from "./service.js";

const JsonRpcBody = Type.Object({
  jsonrpc: Type.Optional(Type.Literal("2.0")),
  id: Type.Optional(Type.Union([Type.String(), Type.Integer()])),
  method: Type.String(),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const workspaceProperty = {
  workspaceId: { type: "string", description: "项目空间 id（桌面端「空间 → 概览」可查；缺省 default）" },
};

const tools = [
  {
    name: "plan_list",
    description: "列出某个项目空间的计划任务（可只看待开始/未指派）。",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        status: { type: "string", enum: ["todo", "doing", "done", "dropped"] },
        owner: { type: "string", enum: ["any", "unassigned", "me", "agent"] },
        q: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "plan_get",
    description: "读一条任务的认领包（背景、验收标准、材料引用、历史与依赖）。认领前必须先读。",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_create",
    description: "在某个项目空间的计划里新建一条任务。",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        title: { type: "string" },
        detail: { type: "string" },
        acceptance: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        dueAt: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_claim",
    description: "认领一条任务（拿 10 分钟租约并进入「进行中」），返回认领包。认领身份记为该外部 Agent。",
    inputSchema: {
      type: "object",
      properties: {
        ...workspaceProperty,
        itemId: { type: "string" },
        sessionId: { type: "string", description: "调用方的会话/任务标识（用于租约归属，缺省 mcp:<agentId>）" },
        agentId: { type: "string", description: "调用方 Agent 标识（缺省 mcp-agent）" },
        note: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_update",
    description: "更新任务状态与结论（标记 done 时必须写 resultSummary）。",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "done", "dropped"] },
        resultSummary: { type: "string" },
        note: { type: "string" },
        sessionId: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_release",
    description: "做不下去时把任务放回「待开始」并写清原因。",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        reason: { type: "string" },
        sessionId: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["itemId", "reason"],
      additionalProperties: false,
    },
  },
];

function result(id: string | number | undefined, value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: string | number | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function text(value: string, structured: Record<string, unknown>) {
  return { content: [{ type: "text", text: value }], structuredContent: structured };
}

function itemLine(item: PlanItem): string {
  return `- [${item.status}] ${item.title}（${item.id}，${item.priority}）`;
}

/**
 * 计划的外部 MCP 端点（P3）：让桌面之外的本机 Agent（Claude Code / Codex 等）
 * 也能读计划、认领、回报，与内置 `plan_*` 工具共用同一套服务与租约。
 *
 * 与 `agent-scheduler/mcp-routes.ts` 同构：无状态 JSON-RPC，鉴权由网关统一中间件负责。
 */
export function planMcpRoutes(service: PlanService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.post("/v1/mcp/plan", { schema: { tags: ["plan", "mcp"], body: JsonRpcBody } }, async (request) => {
      const { id, method, params } = request.body;
      const args = (params?.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {}) as Record<string, unknown>;
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId.trim()
        ? args.workspaceId.trim()
        : "default";
      const sessionId = typeof args.sessionId === "string" && args.sessionId.trim()
        ? args.sessionId.trim()
        : `mcp:${typeof args.agentId === "string" ? args.agentId : "agent"}`;
      const agentId = typeof args.agentId === "string" && args.agentId.trim()
        ? args.agentId.trim()
        : "mcp-agent";

      try {
        if (method === "initialize") {
          return result(id, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "everroom-plan", version: "1.0.0" },
          });
        }
        if (method === "notifications/initialized") return {};
        if (method === "tools/list") return result(id, { tools });
        if (method !== "tools/call") return error(id, -32601, `Unsupported MCP method: ${method}`);

        const name = typeof params?.name === "string" ? params.name : "";
        const itemId = typeof args.itemId === "string" ? args.itemId.trim() : "";

        if (name === "plan_list") {
          const items = service.list({
            workspaceId,
            ...(typeof args.status === "string" ? { status: args.status as PlanItem["status"] } : {}),
            ...(typeof args.owner === "string" && args.owner !== "any"
              ? { owner: (args.owner === "mine" ? "me" : args.owner) as "unassigned" | "me" | "agent" }
              : {}),
            ...(typeof args.q === "string" ? { q: args.q } : {}),
            limit: 100,
          });
          const body = items.length ? items.map(itemLine).join("\n") : "（这个空间还没有任务）";
          return result(id, text(body, { items }));
        }

        if (name === "plan_get") {
          if (!itemId) return error(id, -32602, "itemId is required");
          const pkg = service.claimPackage(itemId);
          return result(id, text(formatPlanClaimPackage(pkg), { package: pkg }));
        }

        if (name === "plan_create") {
          const title = typeof args.title === "string" ? args.title : "";
          if (!title.trim()) return error(id, -32602, "title is required");
          const item = service.create({
            workspaceId,
            title,
            detail: typeof args.detail === "string" ? args.detail : null,
            acceptance: typeof args.acceptance === "string" ? args.acceptance : null,
            priority: typeof args.priority === "string" ? args.priority as PlanItem["priority"] : "normal",
            dueAt: typeof args.dueAt === "string" ? args.dueAt : null,
            createdBy: "agent",
            createdByAgentId: agentId,
          }, { kind: "agent", id: agentId, sessionId });
          return result(id, text(`已建任务「${item.title}」（${item.id}）。`, { item }));
        }

        if (name === "plan_claim") {
          if (!itemId) return error(id, -32602, "itemId is required");
          const pkg = service.claim(itemId, {
            workspaceId,
            sessionId,
            agentId,
            note: typeof args.note === "string" ? args.note : null,
          });
          return result(id, text(
            `已认领（租约 ${pkg.contract.leaseTtlSec}s）。\n\n${formatPlanClaimPackage(pkg)}`,
            { package: pkg },
          ));
        }

        if (name === "plan_update") {
          if (!itemId) return error(id, -32602, "itemId is required");
          const actor = { kind: "agent" as const, id: agentId, sessionId };
          let item = service.get(itemId);
          const status = typeof args.status === "string" ? args.status as PlanItem["status"] : null;
          if (status && status !== item.status) {
            item = service.move(itemId, {
              version: item.version,
              status,
              resultSummary: typeof args.resultSummary === "string" ? args.resultSummary : null,
              reason: typeof args.note === "string" ? args.note : null,
            }, actor);
          }
          const patch: Parameters<PlanService["update"]>[1] = { version: item.version };
          let dirty = false;
          if (typeof args.resultSummary === "string") {
            patch.resultSummary = args.resultSummary;
            dirty = true;
          }
          if (typeof args.note === "string" && args.note.trim()) {
            patch.note = args.note.trim();
            dirty = true;
          }
          if (dirty) item = service.update(itemId, patch, actor);
          return result(id, text(`已更新「${item.title}」：${item.status}。`, { item }));
        }

        if (name === "plan_release") {
          const reason = typeof args.reason === "string" ? args.reason.trim() : "";
          if (!itemId) return error(id, -32602, "itemId is required");
          if (!reason) return error(id, -32602, "reason is required");
          const item = service.release(itemId, { reason, sessionId, agentId });
          return result(id, text(`已放回「${item.title}」。`, { item }));
        }

        return error(id, -32602, `Unknown MCP tool: ${name}`);
      } catch (cause) {
        if (cause instanceof PlanError) return error(id, -32000, `${cause.code}: ${cause.message}`);
        return error(id, -32000, cause instanceof Error ? cause.message : String(cause));
      }
    });
  };
}
