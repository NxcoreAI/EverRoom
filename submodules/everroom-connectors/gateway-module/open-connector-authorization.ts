/**
 * Seam 4 · 授权流（oo 版）：取代 NangoAuthorizationService。
 *
 * 流程（契约 ConnectorAuthorizationAttempt 不变，renderer 轮询零改动）：
 *   start:  POST {base}/api/oauth/authorizations {service, connectionName?}
 *           （Bearer adminToken）→ {authorizationUrl, state}
 *   桌面:   console 窗口打开 authorizationUrl 完成 provider OAuth，
 *           token 落 oo 密文存储（gateway 不接触 token）
 *   status: 轮询 GET {base}/v1/apps/services/{service}（runtime token）
 *           → 发现新 connectionName → manager.register（service/connectionName 标识）
 *
 * 连接名规范（P0 §5）：`{provider}:{attemptId 前 8 位}`——避免多授权互相覆盖，
 * 同账号重授权由 oo 侧同名覆盖语义收敛（UI 层默认仍用 default）。
 */
import { randomUUID } from "node:crypto";
import type {
  ConnectorAuthorizationAttempt,
  ConnectorConnection,
  ConnectorProvider,
} from "@nxcore/connector-contract";
import type { OpenConnectorCliConfig } from "./host-types.js";
import type { ConnectorManager } from "./manager.js";

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

interface OoAppSummary {
  service?: unknown;
  connectionName?: unknown;
  status?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** provider（EverRoom 侧）→ oo service。 */
const SERVICE_OF_PROVIDER: Partial<Record<ConnectorProvider, string>> = {
  gmail: "gmail",
  outlook: "outlook",
  notion: "notion",
  "google-calendar": "googlecalendar",
  "google-docs": "googledrive",
};

export function ooServiceOfProvider(provider: ConnectorProvider): string | null {
  return SERVICE_OF_PROVIDER[provider] ?? null;
}

export class OpenConnectorAuthorizationService {
  private readonly attempts = new Map<string, StoredAttempt>();

  constructor(
    private readonly config: OpenConnectorCliConfig,
    private readonly manager: ConnectorManager,
  ) {}

  private baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  private async listServiceConnections(service: string): Promise<OoAppSummary[]> {
    const response = await fetch(
      new URL(`/v1/apps/services/${encodeURIComponent(service)}`, this.baseUrl()),
      {
        headers: this.config.runtimeToken
          ? { authorization: `Bearer ${this.config.runtimeToken}` }
          : {},
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json().catch(() => null)) as
      | { data?: unknown }
      | unknown[]
      | null;
    const items = Array.isArray(payload) ? payload : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data)
      : [];
    return items as OoAppSummary[];
  }

  async start(provider: ConnectorProvider): Promise<ConnectorAuthorizationStart> {
    this.prune();
    const service = ooServiceOfProvider(provider);
    if (!service) throw new Error(`oo_service_unknown:${provider}`);
    if (!this.config.adminToken) throw new Error("oo_admin_token_missing");

    const id = randomUUID();
    const connectionName = `${provider}:${id.slice(0, 8)}`;
    const known = new Set<string>();
    for (const app of await this.listServiceConnections(service)) {
      const name = text(app.connectionName);
      if (name) known.add(name);
    }

    const response = await fetch(
      new URL("/api/oauth/authorizations", this.baseUrl()),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.adminToken}`,
        },
        body: JSON.stringify({ service, connectionName }),
        signal: AbortSignal.timeout(30_000),
      },
    );
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

    void known;
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
        const apps = await this.listServiceConnections(attempt.service);
        const active = apps.filter((app) => {
          const status = text(app.status)?.toLowerCase();
          return !status || ["active", "connected", "ready"].includes(status);
        });
        const fresh = active.find((app) => text(app.connectionName) === attempt.connectionName);
        if (fresh) {
          attempt.connection = await this.register(attempt, text(fresh.connectionName)!);
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

  private async register(attempt: StoredAttempt, connectionName: string): Promise<ConnectorConnection> {
    return this.manager.register({
      provider: attempt.provider,
      service: attempt.service,
      connectionName,
    });
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
