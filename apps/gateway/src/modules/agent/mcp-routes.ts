import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type, type Static } from "@sinclair/typebox";
import type { GatewayConfig } from "../../config.js";
import type { SecretStore } from "../../security/secret-store.js";

const SecretMutation = Type.Union([
  Type.Object({ operation: Type.Literal("keep") }),
  Type.Object({ operation: Type.Literal("set"), value: Type.String({ minLength: 1 }) }),
  Type.Object({ operation: Type.Literal("delete") }),
]);
const SecretState = Type.Object({ configured: Type.Boolean() });

const PublicFields = {
  command: Type.Optional(Type.String({ minLength: 1 })),
  args: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
  cwd: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  bearerTokenEnv: Type.Optional(Type.String()),
  lifecycle: Type.Optional(Type.Union([
    Type.Literal("lazy"), Type.Literal("eager"), Type.Literal("keep-alive"), Type.Literal("lazy-keep-alive"),
  ])),
  disabled: Type.Optional(Type.Boolean()),
};
const McpServerMutation = Type.Object({
  ...PublicFields,
  previousName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretMutation)),
  headers: Type.Optional(Type.Record(Type.String({ minLength: 1 }), SecretMutation)),
}, { additionalProperties: true });
const McpServerSnapshot = Type.Object({
  ...PublicFields,
  env: Type.Optional(Type.Record(Type.String(), SecretState)),
  headers: Type.Optional(Type.Record(Type.String(), SecretState)),
}, { additionalProperties: true });
const McpServersBody = Type.Object({
  servers: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), McpServerMutation),
});
const McpServersResponse = Type.Object({
  configPath: Type.String(),
  servers: Type.Record(Type.String({ minLength: 1, maxLength: 100 }), McpServerSnapshot),
});

type SecretKind = "env" | "headers";
type SecretMutationDto = Static<typeof SecretMutation>;
type McpServerMutationDto = Static<typeof McpServerMutation> & Record<string, unknown>;
type SecretIndex = Record<string, Partial<Record<SecretKind, string[]>>>;
type PublicServers = Record<string, Record<string, unknown>>;

function secretName(server: string, kind: SecretKind, key: string): string {
  return `mcp:${encodeURIComponent(server)}:${kind}:${encodeURIComponent(key)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateServers(servers: PublicServers): string | null {
  for (const [name, definition] of Object.entries(servers)) {
    if (!name.trim()) return "MCP server name cannot be empty";
    if (!definition.command && !definition.url && !definition.socket) {
      return `MCP server '${name}' requires command (stdio) or url (HTTP)`;
    }
  }
  return null;
}

export class McpConfigManager {
  private servers: PublicServers;
  private secretIndex: SecretIndex;

  constructor(private readonly config: GatewayConfig, private readonly secrets: SecretStore) {
    const parsed = this.readFile();
    this.servers = clone(parsed.mcpServers ?? this.runtimeServersFromConfig());
    this.secretIndex = clone(parsed.secretKeys ?? {});
    const changes: Record<string, string | undefined> = {};
    let migrated = false;
    for (const [server, definition] of Object.entries(this.servers)) {
      for (const kind of ["env", "headers"] as const) {
        const values = definition[kind];
        if (!values || typeof values !== "object" || Array.isArray(values)) continue;
        const keys = new Set(this.secretIndex[server]?.[kind] ?? []);
        for (const [key, value] of Object.entries(values)) {
          if (typeof value !== "string" || !value) continue;
          changes[secretName(server, kind, key)] = value;
          keys.add(key);
          migrated = true;
        }
        delete definition[kind];
        this.secretIndex[server] = { ...this.secretIndex[server], [kind]: [...keys] };
      }
    }
    if (migrated && this.secrets.isAvailable()) {
      this.secrets.update(changes);
      this.persist();
    }
    this.applyLiveConfig();
  }

  snapshot(): Static<typeof McpServersResponse> {
    const servers = clone(this.servers) as Record<string, Record<string, unknown>>;
    for (const [server, kinds] of Object.entries(this.secretIndex)) {
      const target = servers[server];
      if (!target) continue;
      for (const kind of ["env", "headers"] as const) {
        const keys = kinds[kind] ?? [];
        if (keys.length) target[kind] = Object.fromEntries(keys.map((key) => [
          key,
          { configured: this.secrets.isAvailable() && Boolean(this.secrets.get(secretName(server, kind, key))) },
        ]));
      }
    }
    return { configPath: this.config.mcpConfigPath, servers } as Static<typeof McpServersResponse>;
  }

  update(input: Record<string, McpServerMutationDto>): Static<typeof McpServersResponse> {
    const nextServers: PublicServers = {};
    const nextIndex: SecretIndex = {};
    const changes: Record<string, string | undefined> = {};
    const retainedNames = new Set<string>();
    for (const [server, raw] of Object.entries(input)) {
      const source = raw.previousName?.trim() || server;
      if (source !== server && retainedNames.has(source)) throw new Error("mcp_server_rename_conflict");
      retainedNames.add(source);
      const { previousName: _previousName, env, headers, ...definition } = raw;
      nextServers[server] = definition;
      for (const kind of ["env", "headers"] as const) {
        const mutations = (kind === "env" ? env : headers) as Record<string, SecretMutationDto> | undefined;
        const existingKeys = this.secretIndex[source]?.[kind] ?? [];
        const requestedKeys = mutations ? Object.keys(mutations) : existingKeys;
        const configured: string[] = [];
        for (const key of requestedKeys) {
          const mutation = mutations?.[key] ?? { operation: "keep" as const };
          const oldName = secretName(source, kind, key);
          const newName = secretName(server, kind, key);
          if (mutation.operation === "delete") {
            changes[oldName] = undefined;
            if (newName !== oldName) changes[newName] = undefined;
            continue;
          }
          const value = mutation.operation === "set" ? mutation.value : this.secrets.get(oldName);
          if (!value) throw new Error(`mcp_secret_missing:${server}:${kind}:${key}`);
          changes[newName] = value;
          if (newName !== oldName) changes[oldName] = undefined;
          configured.push(key);
        }
        if (configured.length) nextIndex[server] = { ...nextIndex[server], [kind]: configured };
      }
    }
    for (const [server, kinds] of Object.entries(this.secretIndex)) {
      if (retainedNames.has(server)) continue;
      for (const kind of ["env", "headers"] as const) {
        for (const key of kinds[kind] ?? []) changes[secretName(server, kind, key)] = undefined;
      }
    }
    const invalid = validateServers(nextServers);
    if (invalid) throw new Error(invalid);
    const previousServers = this.servers;
    const previousIndex = this.secretIndex;
    const previousSecrets = Object.fromEntries(Object.keys(changes).map((name) => [name, this.secrets.get(name)]));
    this.secrets.update(changes);
    this.servers = nextServers;
    this.secretIndex = nextIndex;
    try {
      this.persist();
    } catch (error) {
      this.servers = previousServers;
      this.secretIndex = previousIndex;
      this.secrets.update(previousSecrets);
      throw error;
    }
    this.applyLiveConfig();
    return this.snapshot();
  }

  clearSecrets(): void {
    const changes: Record<string, undefined> = {};
    for (const [server, kinds] of Object.entries(this.secretIndex)) {
      for (const kind of ["env", "headers"] as const) {
        for (const key of kinds[kind] ?? []) changes[secretName(server, kind, key)] = undefined;
      }
    }
    this.secrets.update(changes);
    this.secretIndex = {};
    this.persist();
    this.applyLiveConfig();
  }

  private runtimeServersFromConfig(): PublicServers {
    return (this.config.pi?.mcp?.mcpServers ?? this.config.backgroundPi?.mcp?.mcpServers ?? {}) as PublicServers;
  }

  private runtimeServers(): PublicServers {
    const output = clone(this.servers);
    for (const [server, kinds] of Object.entries(this.secretIndex)) {
      const target = output[server];
      if (!target) continue;
      for (const kind of ["env", "headers"] as const) {
        const values: Record<string, string> = {};
        for (const key of kinds[kind] ?? []) {
          const value = this.secrets.get(secretName(server, kind, key));
          if (!value) {
            if (!this.secrets.isAvailable()) continue;
            throw new Error(`mcp_secret_decryption_failed:${server}:${kind}:${key}`);
          }
          values[key] = value;
        }
        if (Object.keys(values).length) target[kind] = values;
      }
    }
    return output;
  }

  private applyLiveConfig(): void {
    const servers = this.runtimeServers();
    for (const runtime of [this.config.pi, this.config.backgroundPi]) {
      if (!runtime) continue;
      if (runtime.mcp) runtime.mcp.mcpServers = servers;
      else if (Object.keys(servers).length) runtime.mcp = { mcpServers: servers };
    }
  }

  private readFile(): { mcpServers?: PublicServers; secretKeys?: SecretIndex } {
    if (!existsSync(this.config.mcpConfigPath)) return {};
    try {
      return JSON.parse(readFileSync(this.config.mcpConfigPath, "utf8")) as {
        mcpServers?: PublicServers; secretKeys?: SecretIndex;
      };
    } catch (error) {
      throw new Error("mcp_config_read_failed", { cause: error });
    }
  }

  private persist(): void {
    const path = this.config.mcpConfigPath;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ mcpServers: this.servers, secretKeys: this.secretIndex }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

export function mcpRoutes(manager: McpConfigManager, onChanged?: () => Promise<void>): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get("/v1/agent/mcp/servers", {
      schema: { tags: ["agent"], response: { 200: McpServersResponse } },
    }, async () => manager.snapshot());

    app.put("/v1/agent/mcp/servers", {
      schema: {
        tags: ["agent"], body: McpServersBody,
        response: { 200: McpServersResponse, 400: Type.Object({ message: Type.String() }) },
      },
    }, async (request, reply) => {
      try {
        const result = manager.update(request.body.servers as Record<string, McpServerMutationDto>);
        await onChanged?.();
        return result;
      } catch (error) {
        return reply.code(400).send({ message: error instanceof Error ? error.message : "mcp_config_invalid" });
      }
    });
  };
}
