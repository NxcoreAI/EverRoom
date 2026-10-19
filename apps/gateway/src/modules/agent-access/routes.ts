import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { buildInstallPlan } from "./install.js";
import type { AgentAccessMcpHost } from "./mcp-host.js";
import type { AgentAccessService } from "./service.js";
import type { AgentAccessState, AgentAccessScopes, ResolvedAgentConnection } from "./types.js";
import { isAgentAccessCapability, isAgentAccessToolTarget } from "./types.js";

/**
 * Agent 连接页 REST（PRD 7.1/7.5）：签发/暂停/更新/吊销连接、自检、示例查询、
 * 安装代写内容与调试数据。全部走网关全局 bearer（仅桌面端调用）；
 * 对外 MCP 端点在 mcp-routes.ts，以连接 token 自鉴权。
 */

const ScopesSchema = Type.Object({
  roomIds: Type.Union([
    Type.Literal("all"),
    Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 500 }),
  ]),
  capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { minItems: 1, maxItems: 20 }),
  writebackRoomId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
}, { additionalProperties: false });

const CreateConnectionBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  tool: Type.String({ minLength: 1, maxLength: 40 }),
  scopes: ScopesSchema,
}, { additionalProperties: false });

const PatchConnectionBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  scopes: Type.Optional(ScopesSchema),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")])),
}, { additionalProperties: false });

const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });

function parseScopes(value: {
  roomIds: string[] | "all";
  capabilities: string[];
  writebackRoomId: string | null;
}): AgentAccessScopes {
  const capabilities = value.capabilities.filter(isAgentAccessCapability);
  if (capabilities.length === 0) throw new Error("agent_access_capabilities_invalid");
  return {
    roomIds: value.roomIds,
    capabilities,
    writebackRoomId: value.writebackRoomId,
  };
}

function resolvedFrom(view: {
  id: string;
  name: string;
  tool: string;
  scopes: AgentAccessScopes;
}): ResolvedAgentConnection {
  return { id: view.id, name: view.name, tool: view.tool, scopes: view.scopes };
}

/** 自检兜底：工具不可见（能力未授予）时返回与工具一致的状态形状。 */
function unavailableState(error: unknown): AgentAccessState {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("agent_access_tool_unavailable")
    ? { status: "no_permission", message: "连接未授予该能力（自检步骤跳过）" }
    : { status: "parse_failed", message };
}

export function agentAccessRoutes(
  service: AgentAccessService,
  host: AgentAccessMcpHost,
  baseUrl: () => string,
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent-access/connections",
      { schema: { tags: ["agent-access"] } },
      async () => ({ connections: service.listConnections() }),
    );

    app.post(
      "/v1/agent-access/connections",
      {
        schema: {
          tags: ["agent-access"],
          body: CreateConnectionBody,
        },
      },
      async (request, reply) => {
        if (!isAgentAccessToolTarget(request.body.tool)) {
          return reply.code(400).send({ error: "invalid_tool", message: "Unsupported target tool" });
        }
        try {
          const created = service.createConnection({
            name: request.body.name,
            tool: request.body.tool,
            scopes: parseScopes(request.body.scopes),
          });
          return reply.code(201).send(created);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "agent_access_capabilities_invalid" || message === "agent_access_name_required") {
            return reply.code(400).send({ error: "invalid_connection", message });
          }
          throw error;
        }
      },
    );

    app.get(
      "/v1/agent-access/connections/:id",
      { schema: { tags: ["agent-access"], params: IdParams } },
      async (request, reply) => {
        const connection = service.getConnection(request.params.id);
        if (!connection) return reply.code(404).send({ error: "not_found" });
        return { connection };
      },
    );

    app.patch(
      "/v1/agent-access/connections/:id",
      { schema: { tags: ["agent-access"], params: IdParams, body: PatchConnectionBody } },
      async (request, reply) => {
        const current = service.getConnection(request.params.id);
        if (!current) return reply.code(404).send({ error: "not_found" });
        try {
          const updated = service.updateConnection(request.params.id, {
            ...(request.body.name !== undefined ? { name: request.body.name } : {}),
            ...(request.body.scopes !== undefined ? { scopes: parseScopes(request.body.scopes) } : {}),
            ...(request.body.status !== undefined ? { status: request.body.status } : {}),
          });
          return { connection: updated };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "agent_access_capabilities_invalid" || message === "agent_access_name_required") {
            return reply.code(400).send({ error: "invalid_connection", message });
          }
          throw error;
        }
      },
    );

    app.delete(
      "/v1/agent-access/connections/:id",
      { schema: { tags: ["agent-access"], params: IdParams } },
      async (request, reply) => {
        const revoked = service.revokeConnection(request.params.id);
        if (!revoked) return reply.code(404).send({ error: "not_found" });
        return { connection: revoked };
      },
    );

    app.post(
      "/v1/agent-access/connections/:id/token",
      { schema: { tags: ["agent-access"], params: IdParams } },
      async (request, reply) => {
        const rotated = service.rotateToken(request.params.id);
        if (!rotated) return reply.code(404).send({ error: "not_found" });
        return rotated;
      },
    );

    app.get(
      "/v1/agent-access/connections/:id/submissions",
      {
        schema: {
          tags: ["agent-access"],
          params: IdParams,
          querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
        },
      },
      async (request, reply) => {
        if (!service.getConnection(request.params.id)) {
          return reply.code(404).send({ error: "not_found" });
        }
        return { submissions: service.listSubmissions(request.params.id, request.query.limit ?? 50) };
      },
    );

    app.get(
      "/v1/agent-access/connections/:id/events",
      {
        schema: {
          tags: ["agent-access"],
          params: IdParams,
          querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
        },
      },
      async (request, reply) => {
        if (!service.getConnection(request.params.id)) {
          return reply.code(404).send({ error: "not_found" });
        }
        return { events: service.listEvents(request.params.id, request.query.limit ?? 50) };
      },
    );

    // PRD 7.1.3：安装后检查搜索、精读和候选回写是否可用。
    app.post(
      "/v1/agent-access/connections/:id/selftest",
      { schema: { tags: ["agent-access"], params: IdParams } },
      async (request, reply) => {
        const view = service.getConnection(request.params.id);
        if (!view) return reply.code(404).send({ error: "not_found" });
        const connection = resolvedFrom(view);
        const list = await host.runTool(connection, "everroom_list_rooms", {}).catch(unavailableState);
        const firstRoom = list.status === "ok"
          ? ((list.data as { rooms?: Array<{ title?: string; roomId: string }> })?.rooms ?? [])[0]
          : undefined;
        const query = firstRoom?.title ?? "EverRoom";
        const search = await host
          .runTool(connection, "everroom_search", { query, limit: 3 })
          .catch(unavailableState);
        const fetch = firstRoom
          ? await host
              .runTool(connection, "everroom_fetch", { uri: `everroom://rooms/${firstRoom.roomId}` })
              .catch(unavailableState)
          : ({ status: "empty", message: "授权范围内没有 Room 可精读" } satisfies AgentAccessState);
        const submit = await host
          .runTool(connection, "everroom_submit", {
            submissionId: `selftest-${Date.now()}`,
            items: [{ kind: "citation", targetUri: "everroom://selftest", note: "连接自检（可忽略）" }],
          })
          .catch(unavailableState);
        return { steps: { list, search, fetch, submit }, query };
      },
    );

    // PRD 7.1.4：展示一次示例查询及出处。
    app.post(
      "/v1/agent-access/connections/:id/example-query",
      {
        schema: {
          tags: ["agent-access"],
          params: IdParams,
          body: Type.Object({ query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
        },
      },
      async (request, reply) => {
        const view = service.getConnection(request.params.id);
        if (!view) return reply.code(404).send({ error: "not_found" });
        const connection = resolvedFrom(view);
        let query = request.body.query;
        if (!query) {
          const list = await host.runTool(connection, "everroom_list_rooms", {}).catch(unavailableState);
          query = list.status === "ok"
            ? (((list.data as { rooms?: Array<{ title?: string }> })?.rooms ?? [])[0]?.title ?? "EverRoom")
            : "EverRoom";
        }
        const result = await host
          .runTool(connection, "everroom_search", { query, limit: 5 })
          .catch(unavailableState);
        service.markExampleQuery(view.id);
        return { query, result };
      },
    );

    // 安装代写内容：需要创建/轮换时返回的明文 token 校验（库存只有哈希）。
    app.post(
      "/v1/agent-access/connections/:id/install/:target",
      {
        schema: {
          tags: ["agent-access"],
          params: Type.Object({
            id: Type.String({ minLength: 1, maxLength: 64 }),
            target: Type.String({ minLength: 1, maxLength: 40 }),
          }),
          body: Type.Object({ token: Type.String({ minLength: 8, maxLength: 128 }) }),
        },
      },
      async (request, reply) => {
        const view = service.getConnection(request.params.id);
        if (!view) return reply.code(404).send({ error: "not_found" });
        if (!isAgentAccessToolTarget(request.params.target)) {
          return reply.code(400).send({ error: "invalid_tool", message: "Unsupported target tool" });
        }
        if (!service.verifyTokenMatch(view.id, request.body.token)) {
          return reply.code(403).send({ error: "token_mismatch", message: "Token does not match this connection" });
        }
        return {
          install: buildInstallPlan({
            target: request.params.target,
            connection: view,
            url: `${baseUrl().replace(/\/+$/, "")}/v1/mcp/agents`,
            token: request.body.token,
          }),
        };
      },
    );
  };
}
