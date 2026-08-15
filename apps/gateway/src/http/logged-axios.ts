import { randomUUID } from "node:crypto";
import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import type { Logger } from "pino";

interface RequestMetadata {
  requestId: string;
  startedAt: number;
  method: string;
  url: string;
}

function safeUrl(rawUrl: string | undefined, baseUrl: string | undefined): string {
  try {
    const url = new URL(rawUrl ?? "", baseUrl);
    const keys = [...new Set([...url.searchParams.keys()])];
    url.search = keys.length > 0
      ? `?${keys.map((key) => `${encodeURIComponent(key)}=<redacted>`).join("&")}`
      : "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return (rawUrl ?? "").replace(/\?.*$/, "?<redacted>");
  }
}

function responseFields(
  client: string,
  response: AxiosResponse,
  metadata: WeakMap<InternalAxiosRequestConfig, RequestMetadata>,
): Record<string, unknown> {
  const request = metadata.get(response.config);
  return {
    event: "http.response",
    source: "gateway",
    module: "axios",
    client,
    requestId: request?.requestId,
    method: request?.method ?? response.config.method?.toUpperCase(),
    url: request?.url ?? safeUrl(response.config.url, response.config.baseURL),
    status: response.status,
    durationMs: request ? Date.now() - request.startedAt : undefined,
  };
}

export function createLoggedHttpClient(client: string, logger?: Logger): AxiosInstance {
  const http = axios.create({ timeout: 15_000 });
  const metadata = new WeakMap<InternalAxiosRequestConfig, RequestMetadata>();

  http.interceptors.request.use((config) => {
    const request = {
      requestId: randomUUID(),
      startedAt: Date.now(),
      method: (config.method ?? "GET").toUpperCase(),
      url: safeUrl(config.url, config.baseURL),
    };
    metadata.set(config, request);
    const fields = {
      event: "http.request",
      source: "gateway",
      module: "axios",
      client,
      ...request,
      startedAt: undefined,
    };
    if (logger) logger.info(fields, "[axios] request");
    else console.info(`[gateway][axios] ${JSON.stringify(fields)}`);
    return config;
  });

  http.interceptors.response.use(
    (response) => {
      const fields = responseFields(client, response, metadata);
      if (logger) {
        if (response.status >= 400) logger.warn(fields, "[axios] response");
        else logger.info(fields, "[axios] response");
      } else {
        console[response.status >= 400 ? "warn" : "info"](`[gateway][axios] ${JSON.stringify(fields)}`);
      }
      return response;
    },
    (error: unknown) => {
      if (axios.isAxiosError(error)) {
        const request = error.config ? metadata.get(error.config) : undefined;
        const fields = {
          event: "http.error",
          source: "gateway",
          module: "axios",
          client,
          requestId: request?.requestId,
          method: request?.method ?? error.config?.method?.toUpperCase(),
          url: request?.url ?? safeUrl(error.config?.url, error.config?.baseURL),
          status: error.response?.status,
          durationMs: request ? Date.now() - request.startedAt : undefined,
          code: error.code,
          message: error.message,
        };
        if (logger) logger.error(fields, "[axios] request failed");
        else console.error(`[gateway][axios] ${JSON.stringify(fields)}`);
      }
      return Promise.reject(error);
    },
  );

  return http;
}
