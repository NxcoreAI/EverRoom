import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type, type Static } from "@sinclair/typebox";
import type { GatewayConfig } from "../../config.js";

/** MCP 服务器定义（pi-mcp-adapter 子集 + 透传扩展字段）。 */
const McpServerDefinition = Type.Object(
  {
    command: Type.Optional(Type.String({ minLength: 1 })),
    args: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    cwd: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    bearerTokenEnv: Type.Optional(Type.String()),
    lifecycle: Type.Optional(Type.Union([
      Type.Literal("lazy"),
      Type.Literal("eager"),
      Type.Literal("keep-alive"),
      Type.Literal("lazy-keep-alive"),
    ])),
    disabled: Type.Optional(Type.Boolean()),
  },
  // requestTimeoutMs / includeTools / excludeTools / directTools 等高级项原样保留。
  { additionalProperties: true },
);

const McpServersBody = Type.Object({
  servers: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), McpServerDefinition),
});

const McpServersResponse = Type.Object({
  configPath: Type.String(),
  servers: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), McpServerDefinition),
});

type McpServerDefinitionDto = Static<typeof McpServerDefinition>;
type McpServersMap = Record<string, McpServerDefinitionDto>;

function validateServers(servers: Record<string, unknown>): string | null {
  for (const [name, definition] of Object.entries(servers)) {
    if (!name.trim()) return `服务器名称不能为空`;
    const entry = definition as { command?: unknown; url?: unknown; socket?: unknown };
    if (!entry.command && !entry.url && !entry.socket) {
      return `服务器「${name}」缺少 command（stdio）或 url（HTTP）`;
    }
  }
  return null;
}

/**
 * 设置页 MCP 管理：读写 agent mcp.json 并热更新 Pi 运行时配置。
 * 新配置对新会话生效（pi-mcp-adapter lazy 连接，无需重启 gateway）。
 */
export function mcpRoutes(config: GatewayConfig): FastifyPluginAsyncTypebox {
  return async (app) => {
    const configPath = config.mcpConfigPath;

    const applyLiveConfig = (servers: Record<string, unknown>): void => {
      for (const runtime of [config.pi, config.backgroundPi]) {
        if (!runtime) continue;
        if (runtime.mcp) runtime.mcp.mcpServers = servers;
        else if (Object.keys(servers).length > 0) runtime.mcp = { mcpServers: servers };
      }
    };

    app.get(
      "/v1/agent/mcp/servers",
      { schema: { tags: ["agent"], response: { 200: McpServersResponse } } },
      async () => ({
        configPath,
        servers: (config.pi?.mcp?.mcpServers ?? {}) as McpServersMap,
      }),
    );

    app.put(
      "/v1/agent/mcp/servers",
      {
        schema: {
          tags: ["agent"],
          body: McpServersBody,
          response: {
            200: McpServersResponse,
            400: Type.Object({ message: Type.String() }),
          },
        },
      },
      async (request, reply) => {
        const servers = request.body.servers;
        const invalid = validateServers(servers);
        if (invalid) return reply.code(400).send({ message: invalid });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf8");
        applyLiveConfig(servers);
        return { configPath, servers };
      },
    );
  };
}
