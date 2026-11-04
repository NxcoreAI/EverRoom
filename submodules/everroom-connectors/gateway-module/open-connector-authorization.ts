/**
 * Seam 4 · 授权流（oo 版）：取代 NangoAuthorizationService。
 *
 * 流程：
 *   start:  POST {base}/api/oauth/authorizations {service, connectionName}（admin token）
 *           → {authorizationUrl}
 *   桌面:   系统浏览器完成 provider OAuth，token 落 oo 密文存储
 *   status: 轮询 oo /v1/apps/services/{service}（runtime token）
 *           → 出现同名 connection → 返回连接（不再写本地连接表/scope）
 *
 * 本地模式由 Gateway 代发起（需要 admin token）；SaaS 模式由桌面经 SaaS 代发起，
 * 不经过这里。
 */
import { randomUUID } from "node:crypto";
import type {
  ConnectorAuthorizationAttempt,
  ConnectorConnection,
  ConnectorProvider,
} from "@nxcore/connector-contract";
import type { OpenConnectorCliConfig } from "./host-types.js";
import type { ConnectorConnectionCatalog } from "./connection-runtime.js";

export interface ConnectorAuthorizationStart extends ConnectorAuthorizationAttempt {
  authorizationUrl: string;
}

interface StoredAttempt {
  id: string;
  provider: ConnectorProvider;
  status: "pending" | "connected" | "failed" | "expired";
  createdAt: string;
  expiresAt: string;
  connection: ConnectorConnection | null;
  error: string | null;
  service: string;
  connectionName: string;
}

/** provider（EverRoom 侧）→ oo service。 */
const SERVICE_OF_PROVIDER: Partial<Record<ConnectorProvider, string>> = {
  gmail: "gmail",
  outlook: "outlook",
  notion: "notion",
  "google-calendar": "googlecalendar",
  "google-docs": "googledrive",
  feishu: "feishu",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function ooServiceOfProvider(provider: ConnectorProvider): string | null {
  return SERVICE_OF_PROVIDER[provider] ?? null;
}

export class OpenConnectorAuthorizationService {
  private readonly attempts = new Map<string, StoredAttempt>();

  constructor(
    private readonly config: OpenConnectorCliConfig,
    private readonly catalog: ConnectorConnectionCatalog,
  ) {}

  private baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  async start(provider: ConnectorProvider): Promise<ConnectorAuthorizationStart> {
    this.prune();
    const service = ooServiceOfProvider(provider);
    if (!service) throw new Error(`oo_service_unknown:${provider}`);
    if (!this.config.adminToken) throw new Error("oo_admin_token_missing");

    const id = randomUUID();
    const connectionName = `${provider}:${id.slice(0, 8)}`;
    const response = await fetch(new URL("/api/oauth/authorizations", this.baseUrl()), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.adminToken}`,
      },
      body: JSON.stringify({ service, connectionName }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json().catch(() => null)) as {
      authorizationUrl?: unknown;
      message?: unknown;
    } | null;
    const authorizationUrl = text(payload?.authorizationUrl);
    if (!response.ok || !authorizationUrl) {
      throw new Error(
        `oo_authorization_start_failed: ${text(payload?.message) ?? `HTTP ${String(response.status)}`}`,
      );
    }

    const now = new Date();
    const attempt: StoredAttempt = {
      id,
      provider,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      connection: null,
      error: null,
      service,
      connectionName,
    };
    this.attempts.set(id, attempt);
    return { ...this.toAttempt(attempt), authorizationUrl };
  }

  async status(id: string): Promise<ConnectorAuthorizationAttempt> {
    const attempt = this.attempts.get(id);
    if (!attempt) throw new Error("authorization_attempt_not_found");
    if (attempt.status === "pending") {
      try {
        const connections = await this.catalog.list();
        const fresh = connections.find(
          (connection) =>
            connection.service === attempt.service &&
            connection.connectionName === attempt.connectionName,
        );
        if (fresh) {
          attempt.connection = fresh;
          attempt.status = "connected";
        } else if (Date.now() > Date.parse(attempt.expiresAt)) {
          attempt.status = "expired";
          attempt.error = "authorization_timeout";
        }
      } catch (error) {
        attempt.status = "failed";
        attempt.error = error instanceof Error ? error.message : String(error);
      }
    }
    return this.toAttempt(attempt);
  }

  private toAttempt(attempt: StoredAttempt): ConnectorAuthorizationAttempt {
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
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, attempt] of this.attempts) {
      if (Date.parse(attempt.createdAt) < cutoff) this.attempts.delete(id);
    }
  }
}
