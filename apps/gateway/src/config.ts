import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const LogLevelSchema = Type.Union([
  Type.Literal("fatal"),
  Type.Literal("error"),
  Type.Literal("warn"),
  Type.Literal("info"),
  Type.Literal("debug"),
  Type.Literal("trace"),
  Type.Literal("silent"),
]);

const AgentRuntimeSchema = Type.Union([
  Type.Literal("fake"),
  Type.Literal("pi"),
  Type.Literal("remote-http"),
]);
const AsrProviderSchema = Type.Union([Type.Literal("disabled"), Type.Literal("aliyun")]);
const AiApiSchema = Type.Union([
  Type.Literal("openai-completions"),
  Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"),
  Type.Literal("google-generative-ai"),
]);
const AiReasoningSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const RawConfigSchema = Type.Object(
  {
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 0, maximum: 65535 }),
    dataDir: Type.String({ minLength: 1 }),
    logLevel: LogLevelSchema,
    authToken: Type.String({ minLength: 16 }),
    agentRuntime: AgentRuntimeSchema,
    remoteAgentBaseUrl: Type.String({ minLength: 1 }),
    remoteAgentToken: Type.String(),
    remoteAgentMcpWebSocketUrl: Type.String(),
    aiProvider: Type.String(),
    aiModel: Type.String(),
    aiBaseUrl: Type.String(),
    aiApiKey: Type.String(),
    aiApi: AiApiSchema,
    aiMaxTokens: Type.Integer({ minimum: 1 }),
    aiContextWindow: Type.Integer({ minimum: 1 }),
    aiTemperature: Type.Number({ minimum: 0, maximum: 2 }),
    aiReasoning: AiReasoningSchema,
    asrProvider: AsrProviderSchema,
    asrAliyunApiKey: Type.String(),
    asrAliyunBaseUrl: Type.String(),
    asrAliyunModel: Type.String({ minLength: 1 }),
    asrAliyunOssRegion: Type.String(),
    asrAliyunOssBucket: Type.String(),
    asrAliyunOssAccessKeyId: Type.String(),
    asrAliyunOssAccessKeySecret: Type.String(),
    asrAliyunOssStsToken: Type.String(),
    asrAliyunOssPrefix: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type LogLevel = typeof LogLevelSchema.static;
export type AgentRuntimeMode = typeof AgentRuntimeSchema.static;
export type AiApi = typeof AiApiSchema.static;
export type AiReasoning = typeof AiReasoningSchema.static;

export interface AliyunAsrConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  oss: AliyunOssConfig | null;
}

export interface AliyunOssConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  prefix: string;
}

export interface PiRuntimeConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  api: AiApi;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  reasoning: AiReasoning;
  sessionsDir: string;
  workingDirectory: string;
  agentDirectory: string;
}

export interface GatewayConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  migrationsDir: string;
  runtimeManifestPath: string;
  logLevel: LogLevel;
  authToken: string;
  agentRuntime: AgentRuntimeMode;
  remoteAgent: {
    baseUrl: string;
    token: string | null;
    mcpWebSocketUrl: string | null;
  } | null;
  pi: PiRuntimeConfig | null;
  asrInputDir: string;
  asr: AliyunAsrConfig | null;
}

function defaultDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "NxCore");
    case "win32":
      return join(process.env.LOCALAPPDATA ?? homedir(), "NxCore");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "nxcore");
  }
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid gateway port: ${value}`);
  }

  return Number(value);
}

function parsePositiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return Number(value);
}

function parseTemperature(value: string): number {
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error(`Invalid NXCORE_AI_TEMPERATURE: ${value}`);
  }
  return temperature;
}

function validateAiEndpoint(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid NXCORE_AI_BASE_URL: expected an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid NXCORE_AI_BASE_URL: expected an absolute HTTP(S) URL");
  }
}

function validateHttpEndpoint(name: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}: expected an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Invalid ${name}: expected an absolute HTTPS URL`);
  }
}

function inferMcpWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/device-mcp`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function defaultMigrationsDir(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDirectory, "drizzle"),
    resolve(moduleDirectory, "..", "drizzle"),
    resolve("drizzle"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const { values } = parseArgs({
    args: normalizedArgv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "data-dir": { type: "string" },
      "log-level": { type: "string" },
      token: { type: "string" },
      "migrations-dir": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const dataDir = resolve(values["data-dir"] ?? env.NXCORE_GATEWAY_DATA_DIR ?? defaultDataDir());
  const remoteAgentBaseUrl = env.NXCORE_REMOTE_AGENT_BASE_URL?.trim()
    ?? "http://192.168.1.27:8280/ai/api";
  const rawConfig = {
    host: values.host ?? env.NXCORE_GATEWAY_HOST ?? "127.0.0.1",
    port: parsePort(values.port ?? env.NXCORE_GATEWAY_PORT ?? "0"),
    dataDir,
    logLevel: values["log-level"] ?? env.NXCORE_GATEWAY_LOG_LEVEL ?? "info",
    authToken: values.token ?? env.NXCORE_GATEWAY_TOKEN ?? randomBytes(32).toString("base64url"),
    agentRuntime: env.NXCORE_AGENT_RUNTIME ?? "remote-http",
    remoteAgentBaseUrl,
    remoteAgentToken: env.NXCORE_REMOTE_AGENT_TOKEN?.trim() ?? "",
    remoteAgentMcpWebSocketUrl: env.NXCORE_REMOTE_AGENT_MCP_WS_URL?.trim()
      ?? inferMcpWebSocketUrl(remoteAgentBaseUrl),
    aiProvider: env.NXCORE_AI_PROVIDER?.trim() ?? "",
    aiModel: env.NXCORE_AI_MODEL?.trim() ?? "",
    aiBaseUrl: env.NXCORE_AI_BASE_URL?.trim() ?? "",
    aiApiKey: env.NXCORE_AI_API_KEY?.trim() ?? "",
    aiApi: env.NXCORE_AI_API ?? "openai-completions",
    aiMaxTokens: parsePositiveInteger("NXCORE_AI_MAX_TOKENS", env.NXCORE_AI_MAX_TOKENS ?? "8192"),
    aiContextWindow: parsePositiveInteger(
      "NXCORE_AI_CONTEXT_WINDOW",
      env.NXCORE_AI_CONTEXT_WINDOW ?? "128000",
    ),
    aiTemperature: parseTemperature(env.NXCORE_AI_TEMPERATURE ?? "0.3"),
    aiReasoning: env.NXCORE_AI_REASONING ?? "medium",
    asrProvider: env.NXCORE_ASR_PROVIDER ?? "disabled",
    asrAliyunApiKey: env.NXCORE_ASR_ALIYUN_API_KEY?.trim() ?? "",
    asrAliyunBaseUrl: env.NXCORE_ASR_ALIYUN_BASE_URL?.trim()
      ?? "https://dashscope.aliyuncs.com/api/v1",
    asrAliyunModel: env.NXCORE_ASR_ALIYUN_MODEL?.trim()
      ?? "qwen-audio-3.0-asr-flash-filetrans",
    asrAliyunOssRegion: env.NXCORE_ASR_ALIYUN_OSS_REGION?.trim() ?? "",
    asrAliyunOssBucket: env.NXCORE_ASR_ALIYUN_OSS_BUCKET?.trim() ?? "",
    asrAliyunOssAccessKeyId: env.NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_ID?.trim() ?? "",
    asrAliyunOssAccessKeySecret: env.NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_SECRET?.trim() ?? "",
    asrAliyunOssStsToken: env.NXCORE_ASR_ALIYUN_OSS_STS_TOKEN?.trim() ?? "",
    asrAliyunOssPrefix: env.NXCORE_ASR_ALIYUN_OSS_PREFIX?.trim() ?? "nxcore-asr",
  };

  if (!Value.Check(RawConfigSchema, rawConfig)) {
    const details = [...Value.Errors(RawConfigSchema, rawConfig)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new Error(`Invalid gateway configuration: ${details}`);
  }

  if (rawConfig.agentRuntime === "pi") {
    const missing = [
      ["NXCORE_AI_PROVIDER", rawConfig.aiProvider],
      ["NXCORE_AI_MODEL", rawConfig.aiModel],
      ["NXCORE_AI_BASE_URL", rawConfig.aiBaseUrl],
      ["NXCORE_AI_API_KEY", rawConfig.aiApiKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Pi runtime requires: ${missing.join(", ")}`);
    }
    validateAiEndpoint(rawConfig.aiBaseUrl);
  }

  if (rawConfig.agentRuntime === "remote-http") {
    validateAiEndpoint(rawConfig.remoteAgentBaseUrl);
    if (rawConfig.remoteAgentMcpWebSocketUrl) {
      let mcpUrl: URL;
      try {
        mcpUrl = new URL(rawConfig.remoteAgentMcpWebSocketUrl);
      } catch {
        throw new Error("Invalid NXCORE_REMOTE_AGENT_MCP_WS_URL: expected an absolute WS(S) URL");
      }
      if (mcpUrl.protocol !== "ws:" && mcpUrl.protocol !== "wss:") {
        throw new Error("Invalid NXCORE_REMOTE_AGENT_MCP_WS_URL: expected an absolute WS(S) URL");
      }
    }
  }

  if (rawConfig.asrProvider === "aliyun") {
    if (!rawConfig.asrAliyunApiKey) {
      throw new Error("Aliyun ASR requires: NXCORE_ASR_ALIYUN_API_KEY");
    }
    validateHttpEndpoint("NXCORE_ASR_ALIYUN_BASE_URL", rawConfig.asrAliyunBaseUrl);
    const ossFields = [
      ["NXCORE_ASR_ALIYUN_OSS_REGION", rawConfig.asrAliyunOssRegion],
      ["NXCORE_ASR_ALIYUN_OSS_BUCKET", rawConfig.asrAliyunOssBucket],
      ["NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_ID", rawConfig.asrAliyunOssAccessKeyId],
      ["NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_SECRET", rawConfig.asrAliyunOssAccessKeySecret],
    ] as const;
    if (ossFields.some(([, value]) => value) && ossFields.some(([, value]) => !value)) {
      const missing = ossFields.filter(([, value]) => !value).map(([name]) => name);
      throw new Error(`Aliyun OSS configuration requires: ${missing.join(", ")}`);
    }
  }

  return {
    host: rawConfig.host,
    port: rawConfig.port,
    dataDir: rawConfig.dataDir,
    logLevel: rawConfig.logLevel,
    authToken: rawConfig.authToken,
    agentRuntime: rawConfig.agentRuntime,
    remoteAgent: rawConfig.agentRuntime === "remote-http"
      ? {
          baseUrl: rawConfig.remoteAgentBaseUrl,
          token: rawConfig.remoteAgentToken || null,
          mcpWebSocketUrl: rawConfig.remoteAgentMcpWebSocketUrl || null,
        }
      : null,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve(
      values["migrations-dir"] ?? env.NXCORE_GATEWAY_MIGRATIONS_DIR ?? defaultMigrationsDir(),
    ),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    asrInputDir: join(dataDir, "recordings"),
    asr: rawConfig.asrProvider === "aliyun"
      ? {
          apiKey: rawConfig.asrAliyunApiKey,
          baseUrl: rawConfig.asrAliyunBaseUrl,
          model: rawConfig.asrAliyunModel,
          oss: rawConfig.asrAliyunOssRegion
            ? {
                region: rawConfig.asrAliyunOssRegion,
                bucket: rawConfig.asrAliyunOssBucket,
                accessKeyId: rawConfig.asrAliyunOssAccessKeyId,
                accessKeySecret: rawConfig.asrAliyunOssAccessKeySecret,
                ...(rawConfig.asrAliyunOssStsToken
                  ? { stsToken: rawConfig.asrAliyunOssStsToken }
                  : {}),
                prefix: rawConfig.asrAliyunOssPrefix.replace(/^\/+|\/+$/g, ""),
              }
            : null,
        }
      : null,
    pi: rawConfig.agentRuntime === "pi"
      ? {
          provider: rawConfig.aiProvider,
          model: rawConfig.aiModel,
          baseUrl: rawConfig.aiBaseUrl,
          apiKey: rawConfig.aiApiKey,
          api: rawConfig.aiApi,
          maxTokens: rawConfig.aiMaxTokens,
          contextWindow: rawConfig.aiContextWindow,
          temperature: rawConfig.aiTemperature,
          reasoning: rawConfig.aiReasoning,
          sessionsDir: join(dataDir, "agent", "pi-sessions"),
          workingDirectory: join(dataDir, "agent", "workspace"),
          agentDirectory: join(dataDir, "agent", "pi-config"),
        }
      : null,
  };
}
