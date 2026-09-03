import { randomUUID } from "node:crypto";
import axios, { type AxiosInstance } from "axios";
import type {
  ConnectorAuthorizationAttempt,
  ConnectorConnection,
  ConnectorProvider,
} from "@nxcore/connector-contract";
import type { ConnectorManager } from "./manager.js";

export function nangoAuthorizationErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (!axios.isAxiosError(error)) return fallback;
  const status = error.response?.status;
  const body = error.response?.data as {
    code?: unknown;
    error?: unknown;
  } | undefined;
  const nested = body?.error && typeof body.error === "object"
    ? body.error as { code?: unknown }
    : null;
  const code = typeof nested?.code === "string"
    ? nested.code
    : typeof body?.code === "string"
      ? body.code
      : null;
  if (status) return `${fallback}（Nango HTTP ${status}${code ? `: ${code}` : ""}）`;
  return error.code ? `${fallback}（Nango ${error.code}）` : fallback;
}

interface StoredAttempt extends ConnectorAuthorizationAttempt {
  configKey: string;
  completion?: Promise<void>;
}

interface NangoConnectionSummary {
  connection_id?: unknown;
  provider_config_key?: unknown;
  tags?: Record<string, unknown> | null;
  errors?: Array<{ type?: unknown }>;
}

export interface ConnectorAuthorizationStart extends ConnectorAuthorizationAttempt {
  authorizationUrl: string;
}

export class NangoAuthorizationService {
  private readonly http: AxiosInstance;
  private readonly apiURL: string;
  private readonly secret: () => string;
  private readonly attempts = new Map<string, StoredAttempt>();

  constructor(
    baseURL: string,
    secret: string | (() => string),
    private readonly configKeys: Partial<Record<ConnectorProvider, string>>,
    private readonly manager: ConnectorManager,
    http?: AxiosInstance,
  ) {
    this.apiURL = baseURL.replace(/\/$/, "");
    this.secret = typeof secret === "function" ? secret : () => secret;
    this.http = http ?? axios.create({
      baseURL: this.apiURL,
      timeout: 30_000,
    });
  }

  private authorizationHeaders(): { Authorization: string } {
    return { Authorization: `Bearer ${this.secret()}` };
  }

  async start(provider: ConnectorProvider): Promise<ConnectorAuthorizationStart> {
    this.prune();
    const configKey = this.configKeys[provider];
    if (!configKey) throw new Error(`nango_config_missing:${provider}`);
    const id = randomUUID();
    const response = await this.http.post("/connect/sessions", {
      tags: {
        end_user_id: `everroom-local-${id}`,
        auth_attempt_id: id,
      },
      allowed_integrations: [configKey],
    }, { headers: this.authorizationHeaders() });
    const data = response.data?.data;
    if (
      typeof data?.connect_link !== "string" ||
      typeof data?.expires_at !== "string" ||
      !Number.isFinite(Date.parse(data.expires_at))
    ) {
      throw new Error("nango_connect_session_invalid");
    }
    const authorizationUrl = new URL(data.connect_link);
    if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") {
      throw new Error("nango_connect_link_invalid");
    }
    // The self-hosted Connect UI bundle defaults to api.nango.dev unless this
    // runtime parameter is present, even when the server environment is set.
    authorizationUrl.searchParams.set("apiURL", this.apiURL);
    const attempt: StoredAttempt = {
      id,
      provider,
      configKey,
      status: "pending",
      expiresAt: data.expires_at,
      connection: null,
      error: null,
    };
    this.attempts.set(id, attempt);
    return { ...this.snapshot(attempt), authorizationUrl: authorizationUrl.toString() };
  }

  async status(id: string): Promise<ConnectorAuthorizationAttempt | null> {
    const attempt = this.attempts.get(id);
    if (!attempt) return null;
    if (attempt.status === "pending" && Date.now() >= Date.parse(attempt.expiresAt)) {
      attempt.status = "expired";
      attempt.error = "授权会话已过期，请重新连接。";
    }
    if (attempt.status !== "pending") return this.snapshot(attempt);

    const response = await this.http.get("/connections", {
      headers: this.authorizationHeaders(),
      params: {
        "tags[auth_attempt_id]": attempt.id,
        limit: 10,
      },
    });
    const connections = Array.isArray(response.data?.connections)
      ? response.data.connections as NangoConnectionSummary[]
      : [];
    const match = connections.find((connection) =>
      connection.tags?.auth_attempt_id === attempt.id &&
      connection.provider_config_key === attempt.configKey,
    );
    if (!match) return this.snapshot(attempt);
    if (match.errors?.some((error) => error.type === "auth")) {
      attempt.status = "failed";
      attempt.error = "Nango 报告授权失败，请重新连接。";
      return this.snapshot(attempt);
    }
    if (typeof match.connection_id !== "string" || !match.connection_id) {
      attempt.status = "failed";
      attempt.error = "Nango 返回了无效的连接标识。";
      return this.snapshot(attempt);
    }

    if (!attempt.completion) {
      attempt.completion = this.complete(attempt, match.connection_id);
    }
    await attempt.completion;
    return this.snapshot(attempt);
  }

  private async complete(attempt: StoredAttempt, nangoConnectionId: string): Promise<void> {
    try {
      const existing = this.manager.repository.listConnections().find((connection) =>
        connection.nangoConfigKey === attempt.configKey &&
        connection.nangoConnectionId === nangoConnectionId,
      );
      attempt.connection = existing ?? await this.manager.register({
        provider: attempt.provider,
        nangoConfigKey: attempt.configKey,
        nangoConnectionId,
        // Notion migrations must begin immediately after OAuth. Other providers
        // retain the filter-preference gate used by their existing onboarding.
        deferFirstSync: attempt.provider !== "notion",
      });
      attempt.status = "connected";
    } catch {
      attempt.status = "failed";
      attempt.error = "授权已完成，但初始化同步范围失败。";
    }
  }

  private snapshot(attempt: StoredAttempt): ConnectorAuthorizationAttempt {
    return {
      id: attempt.id,
      provider: attempt.provider,
      status: attempt.status,
      expiresAt: attempt.expiresAt,
      connection: attempt.connection,
      error: attempt.error,
    };
  }

  private prune(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [id, attempt] of this.attempts) {
      if (Date.parse(attempt.expiresAt) < cutoff) this.attempts.delete(id);
    }
    while (this.attempts.size >= 100) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.attempts.delete(oldest);
    }
  }
}
