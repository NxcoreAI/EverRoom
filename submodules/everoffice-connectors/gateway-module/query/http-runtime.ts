import type { OpenConnectorCliConfig } from "../host-types.js";
import { OpenConnectorHttpClient, envelopeData } from "../open-connector-http-client.js";
import type { ConnectorActionRuntime } from "./types.js";

/** oo 的 /v1/apps 输出可能是数组，也可能包在 { success, data } 封套里。 */
function appsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(root.apps)) return root.apps;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Query 层在网关里的生产运行时：包装 OpenConnectorHttpClient。
 * 每次调用都读当前 config（会话热推后无需重建）。
 */
export class HttpConnectorActionRuntime implements ConnectorActionRuntime {
  private readonly client: OpenConnectorHttpClient;

  constructor(private readonly config: OpenConnectorCliConfig) {
    this.client = new OpenConnectorHttpClient(config);
  }

  async listConnections(): Promise<Array<{ service: string; connectionName: string; status?: string }>> {
    if (!this.config.baseUrl.trim()) return [];
    const raw = await this.client.listApps();
    return appsOf(raw).flatMap((item) => {
      const app = asRecord(item);
      const service = typeof app.service === "string" ? app.service.trim() : "";
      const connectionName =
        typeof app.connectionName === "string"
          ? app.connectionName.trim()
          : typeof app.alias === "string"
            ? app.alias.trim()
            : "";
      if (!service || !connectionName) return [];
      const status = typeof app.status === "string" ? app.status : undefined;
      return [{ service, connectionName, ...(status ? { status } : {}) }];
    });
  }

  async runAction(
    service: string,
    action: string,
    input: Record<string, unknown>,
    options: { connectionName: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const raw = await this.client.runAction(service, action, input, {
      connectionName: options.connectionName,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return envelopeData(raw);
  }
}
