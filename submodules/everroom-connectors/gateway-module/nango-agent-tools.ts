import type {
  PiAgentRuntimeTool,
  PiAgentRuntimeToolFailurePolicy,
} from "@nxcore/agent-runtime-pi";
import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { ConnectorManager } from "./manager.js";
import { syncProviderOf } from "./sync-providers/index.js";
import type { NangoExecutor } from "./nango-executor.js";
import { type ExternalCallBudgetService } from "./ports.js";

/** 宿主与模块内的 ExternalCallBudgetExceededError 结构等价判定（跨 instanceof 不可靠）。 */
function isExternalCallBudgetExceeded(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "EXTERNAL_CALL_BUDGET_EXCEEDED";
}

const MODEL_CONTEXT_OUTPUT_LIMIT = 64 * 1024;
const PLACEHOLDER_PATTERN = /(?:\byour_username\b|\busername_here\b|\breplace_me\b|<\s*(?:username|paste\b|insert\b|粘贴|填写|替换)[^>]*>|\{\{\s*[^}]+\s*\}\})/i;

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unresolvedPlaceholderPath(value: unknown, path = "input"): string | null {
  if (typeof value === "string") return PLACEHOLDER_PATTERN.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const match = unresolvedPlaceholderPath(value[index], `${path}[${String(index)}]`);
      if (match) return match;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const match = unresolvedPlaceholderPath(item, `${path}.${key}`);
      if (match) return match;
    }
  }
  return null;
}

function textResult(data: unknown): { content: string; details: unknown } {
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) <= MODEL_CONTEXT_OUTPUT_LIMIT) {
    return { content: serialized, details: data };
  }
  let preview = serialized.slice(0, Math.floor(MODEL_CONTEXT_OUTPUT_LIMIT / 2));
  let limited = {
    truncated: true,
    originalBytes: Buffer.byteLength(serialized),
    preview,
    instruction: "The connector result exceeded the model context limit. Narrow the query or request fewer records before continuing.",
  };
  let content = JSON.stringify(limited);
  while (Buffer.byteLength(content) > MODEL_CONTEXT_OUTPUT_LIMIT && preview.length > 1024) {
    preview = preview.slice(0, Math.floor(preview.length * 0.75));
    limited = { ...limited, preview };
    content = JSON.stringify(limited);
  }
  return { content, details: limited };
}

/** provider 直连 URL 仅允许 https，且不允许携带凭据/query 外的成分，防代理滥用。 */
function assertProviderUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid provider URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Provider URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Provider URL must not embed credentials");
  }
  if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1$|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(parsed.hostname)) {
    throw new Error("Provider URL must not target loopback or private addresses");
  }
  return parsed;
}

function nangoFailurePolicy(
  operation: "list" | "trigger" | "request",
  error: unknown,
): PiAgentRuntimeToolFailurePolicy {
  if (isExternalCallBudgetExceeded(error)) {
    return {
      category: "external_call_budget_exceeded",
      recoverable: true,
      instruction: "Skip this tool and continue with another available path.",
      retryKey: "external-call-budget",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/oauth|unauthori[sz]ed|forbidden|missing scope|insufficient scope|token.*expired|HTTP 401|HTTP 403|connection_disabled/i.test(message)) {
    return {
      category: "authentication_required",
      recoverable: false,
      instruction: "Stop automatic retries and ask the user to reconnect this service in the connector settings.",
      retryKey: "nango",
    };
  }
  if (/timed? out|ECONN|ENOTFOUND|network|socket|fetch failed|HTTP 429|rate.?limit/i.test(message)) {
    return {
      category: /429|rate.?limit/i.test(message) ? "rate_limited" : "transient_network",
      recoverable: true,
      ...(operation === "request" ? { recommendedTool: "nango_request" } : {}),
      instruction: operation === "request"
        ? "Retry nango_request once with the same validated request. If it fails again, stop and report the network blocker."
        : "Report the network blocker; do not retry a sync trigger automatically.",
      retryKey: "nango",
      maxAttempts: 1,
    };
  }
  return {
    category: "connector_failure",
    recoverable: false,
    instruction: "Stop automatic retries and report the exact connector error without claiming success.",
    retryKey: "nango",
  };
}

// 阶段二：显示名走注册表 ui 元数据（兜底返回注册名本身）。
const providerLabel = (provider: string): string =>
  syncProviderOf(provider)?.ui.label ?? provider;

export function createNangoPiTools(
  manager: ConnectorManager,
  executor: NangoExecutor,
  externalCalls?: ExternalCallBudgetService,
): PiAgentRuntimeTool[] {
  return [
    {
      name: "nango_connections",
      label: "列出已连接的服务账号",
      description: "列出用户在 EverRoom 中已连接的 Nango 连接器账号及其同步范围（scope）。调用其他 nango 工具前先调用本工具，获取精确的 connectionId / scopeId。",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "可选，按 provider 过滤（gmail / outlook / google-docs / notion / google-calendar）",
          },
        },
        additionalProperties: false,
      },
      promptGuidelines: [
        "Copy connectionId and scopeId exactly from this tool's results; never guess them.",
        "Connections with status other than active cannot be used; ask the user to reconnect instead of retrying.",
      ],
      execute: async (_input, params) => {
        const provider = textValue(params.provider);
        const connections = manager.repository
          .listConnections()
          .filter((c) => !provider || c.provider === provider)
          .map((c) => ({
            connectionId: c.id,
            provider: c.provider,
            displayName: providerLabel(c.provider),
            status: c.status,
            scopes: manager.repository
              .listScopes()
              .filter((s) => s.connectionId === c.id)
              .map((s) => ({
                scopeId: s.id,
                displayName: s.displayName,
                state: s.state,
                hasCursor: s.sourceCursor != null,
              })),
          }));
        return textResult({ connections });
      },
      classifyFailure: (error: unknown) => nangoFailurePolicy("list", error),
    },
    {
      name: "nango_sync_trigger",
      label: "触发连接器同步",
      description: "为一个同步范围（scope）触发数据同步。scopeId 必须来自 nango_connections 的返回。返回本次同步运行的 runId 与状态，同步在后台执行。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          scopeId: { type: "string", minLength: 1 },
          mode: {
            type: "string",
            enum: ["incremental", "full", "rebuild"],
            description: "默认 incremental；rebuild 会全量重建本地数据，仅在明确需要时使用",
          },
        },
        required: ["scopeId"],
        additionalProperties: false,
      },
      promptGuidelines: [
        "Use only a scopeId returned by nango_connections.",
        "Triggering starts a background run; report the run status instead of waiting for completion.",
        "Do not trigger rebuild unless the user explicitly asks for a full re-sync.",
      ],
      execute: async (_input, params) => {
        const scopeId = String(params.scopeId);
        const mode = params.mode === "full" || params.mode === "rebuild" ? params.mode : "incremental";
        const scope = manager.repository.getScope(scopeId);
        if (!scope) {
          throw new Error(`Scope "${scopeId}" does not exist. Use nango_connections to list valid scopeId values.`);
        }
        const run = manager.trigger(scopeId, mode);
        return textResult({
          runId: run.id,
          scopeId: run.scopeId,
          mode: run.mode,
          status: run.status,
        });
      },
      classifyFailure: (error: unknown) => nangoFailurePolicy("trigger", error),
    },
    {
      name: "nango_request",
      label: "调用已连接服务的 API",
      description: "通过 Nango 代理对用户已连接的服务发起只读（GET）API 请求，例如读取邮件、日程或文档的实时数据。必须先由 nango_connections 确认连接，且 URL 为该服务官方 API 的 HTTPS 端点。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          connectionId: {
            type: "string",
            minLength: 1,
            description: "来自 nango_connections 返回的 connectionId",
          },
          url: {
            type: "string",
            minLength: 1,
            description: "服务官方 API 的绝对 HTTPS URL，例如 https://gmail.googleapis.com/gmail/v1/users/me/messages",
          },
          query: {
            type: "object",
            description: "可选 URL 查询参数（值须为字符串）",
            additionalProperties: true,
          },
        },
        required: ["connectionId", "url"],
        additionalProperties: false,
      },
      promptGuidelines: [
        "Call nango_connections first and use only a returned connectionId; never guess one.",
        "Only GET requests are allowed. Never attempt writes, deletes, or state-changing calls.",
        "Every required parameter value must come from the user or a previous tool result; never submit example placeholders.",
        "Use provider pagination parameters (pageSize/maxResults/pageToken) to keep responses small.",
      ],
      execute: async (input: StartRuntimeRunInput, params, signal) => {
        const connectionId = String(params.connectionId);
        const connection = manager.repository.getConnection(connectionId);
        if (!connection) {
          throw new Error(`Connection "${connectionId}" does not exist. Use nango_connections to list valid connectionId values.`);
        }
        if (connection.status !== "active") {
          throw new Error(`Connection "${connectionId}" is ${connection.status}. Ask the user to reconnect the service before retrying.`);
        }
        const target = assertProviderUrl(String(params.url));
        const query = objectValue(params.query);
        for (const [key, value] of Object.entries(query)) {
          target.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        if (unresolvedPlaceholderPath(params.query)) {
          throw new Error("Query parameters contain an unresolved example placeholder. Use a real value from the user or a previous tool result.");
        }
        signal?.throwIfAborted();
        const invoke = async (markDispatched: () => void) => {
          markDispatched();
          return executor.proxyGet(
            connection.nangoConnectionId,
            connection.nangoConfigKey,
            target.toString(),
          );
        };
        const result = externalCalls
          ? await externalCalls.execute("CONNECTOR", "nango_request", {
              source: "agent",
              runId: input.runId,
              correlationId: input.sessionId,
            }, invoke)
          : await invoke(() => undefined);
        return textResult(result);
      },
      classifyFailure: (error: unknown) => nangoFailurePolicy("request", error),
    },
  ];
}
