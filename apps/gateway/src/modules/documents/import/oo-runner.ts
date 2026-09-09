import type { OpenConnectorCliConfig } from "../../../config.js";
import { envelopeData } from "@nxcore/connectors-module/open-connector-http-client.js";
import { runOoHttp, type OoHttpRunner } from "@nxcore/connectors-module/open-connector-tools.js";

/**
 * 导入链路专用的 OpenConnector 调用层：只做读操作（apps / run 只读 action），
 * 走连接器统一后的 HTTP 传输缝（runOoHttp → 本地 OpenConnector runtime），
 * 错误统一分类成 ImportConnectorError，供上层把鉴权缺失降级为
 * "导入连接未建立"而不是半份结果。
 */
export type ImportConnectorErrorCode =
  | "authentication_required"
  | "no_connection"
  | "action_not_found"
  | "invalid_input"
  | "timeout"
  | "connector_unavailable"
  | "connector_error";

export class ImportConnectorError extends Error {
  readonly code: ImportConnectorErrorCode;
  readonly detail: string;

  constructor(code: ImportConnectorErrorCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

export interface ImportConnectorActionCall {
  service: string;
  action: string;
  input: Record<string, unknown>;
  connectionName?: string;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface ImportConnectorApp {
  connectionName: string;
  isDefault: boolean;
  status: string | null;
}

function parseConnectorApps(value: unknown): ImportConnectorApp[] {
  const root = objectValue(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.connections)
        ? root.connections
        : Array.isArray(root.apps)
          ? root.apps
          : [];
  return items.flatMap((item) => {
    const app = objectValue(item);
    // HTTP /v1/apps 条目的连接名在 alias；旧 CLI 形状用 connectionName/name。
    const connectionName = textValue(app.connectionName) ?? textValue(app.alias) ?? textValue(app.name);
    if (!connectionName) return [];
    return [{
      connectionName,
      isDefault: app.isDefault === true,
      status: textValue(app.status),
    }];
  });
}

function usableApps(apps: ImportConnectorApp[]): ImportConnectorApp[] {
  const unusable = new Set(["disconnected", "error", "expired", "inactive", "revoked", "unauthorized"]);
  return apps.filter((app) => !app.status || !unusable.has(app.status.toLowerCase()));
}

function classifyConnectorError(error: unknown): ImportConnectorError {
  const message = error instanceof Error ? error.message : String(error);
  // OpenConnectorHttpError 携带 status/errorCode，优先按 HTTP 语义分类。
  const status = (error as { status?: unknown }).status;
  if (status === 401 || status === 403) {
    return new ImportConnectorError("authentication_required", message);
  }
  if (status === 404) {
    return new ImportConnectorError("action_not_found", message);
  }
  if (status === 400) {
    return new ImportConnectorError("invalid_input", message);
  }
  if (status === 408) {
    return new ImportConnectorError("timeout", message);
  }
  if (/oauth|unauthori[sz]ed|forbidden|missing scope|insufficient scope|token.*expired|HTTP 401|HTTP 403/i.test(message)) {
    return new ImportConnectorError("authentication_required", message);
  }
  if (/no active connection|connection_not_found|connection.*not available/i.test(message)) {
    return new ImportConnectorError("no_connection", message);
  }
  if (/HTTP 404|action.*(?:not found|could not be verified)|action metadata/i.test(message)) {
    return new ImportConnectorError("action_not_found", message);
  }
  if (/invalid_input|Validation Failed|input payload is invalid|additional properties|must NOT have|HTTP 400/i.test(message)) {
    return new ImportConnectorError("invalid_input", message);
  }
  if (/timed? out/i.test(message)) {
    return new ImportConnectorError("timeout", message);
  }
  if (/连接失败|fetch failed|ECONN|ENOTFOUND|network|socket|UND_ERR/i.test(message)) {
    return new ImportConnectorError("connector_unavailable", message);
  }
  return new ImportConnectorError("connector_error", message);
}

/** 可注入的 action 执行器（生产走 runOoHttp；测试注入 fake）。 */
export type ImportActionRunner = typeof runImportConnectorAction;

export async function runImportConnectorAction(
  config: OpenConnectorCliConfig,
  call: ImportConnectorActionCall,
  signal?: AbortSignal,
  runHttpFn: OoHttpRunner = runOoHttp,
): Promise<unknown> {
  try {
    const connectionName = await resolveImportConnectionName(config, call.service, call.connectionName, signal, runHttpFn);
    const envelope = await runHttpFn(
      config,
      {
        kind: "run",
        service: call.service,
        action: call.action,
        input: call.input,
        connectionName,
      },
      signal,
    );
    return envelopeData(envelope);
  } catch (error) {
    if (error instanceof ImportConnectorError) throw error;
    throw classifyConnectorError(error);
  }
}

export async function resolveImportConnectionName(
  config: OpenConnectorCliConfig,
  service: string,
  requested?: string,
  signal?: AbortSignal,
  runHttpFn: OoHttpRunner = runOoHttp,
): Promise<string> {
  let apps: unknown;
  try {
    apps = await runHttpFn(config, { kind: "apps", service }, signal);
  } catch (error) {
    throw classifyConnectorError(error);
  }
  const usable = usableApps(parseConnectorApps(apps));
  if (usable.length === 0) {
    throw new ImportConnectorError(
      "no_connection",
      `Connector service "${service}" has no active connection`,
    );
  }
  if (requested) {
    if (!usable.some((app) => app.connectionName === requested)) {
      throw new ImportConnectorError(
        "no_connection",
        `Connector connection "${requested}" is not available for service "${service}"`,
      );
    }
    return requested;
  }
  const defaultApp = usable.find((app) => app.isDefault);
  if (defaultApp) return defaultApp.connectionName;
  if (usable.length === 1) return usable[0]!.connectionName;
  throw new ImportConnectorError(
    "no_connection",
    `Connector service "${service}" has multiple active connections`,
  );
}
