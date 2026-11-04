import type {
  ConnectorActionRuntime,
  ProfileQuery,
  QueryCoverage,
  QueryHit,
  QueryInput,
  QueryProfile,
  QueryReadResult,
  QueryResult,
} from "./types.js";
import { decodeRef, encodeRef } from "./ref.js";
import { defaultQueryProfiles } from "./profiles/index.js";

export class ConnectorQueryError extends Error {
  constructor(
    readonly code:
      | "invalid_query"
      | "invalid_ref"
      | "no_profile"
      | "detail_unsupported"
      | "query_failed",
    message: string,
  ) {
    super(message);
    this.name = "ConnectorQueryError";
  }
}

export interface ConnectorQueryOptions {
  profiles?: readonly QueryProfile[];
  /** 单个 provider action 超时（默认 8s）。 */
  timeoutMs?: number;
  /** 单次查询最多并发几个服务（默认 6）。 */
  maxServices?: number;
  /** 每个服务最多查几个连接（默认 2）。 */
  maxConnectionsPerService?: number;
  /** 每个服务最多几种查询（默认 2）。 */
  maxQueriesPerService?: number;
  /** read 返回的正文上限（默认 40k 字符）。 */
  maxReadChars?: number;
}

const DEFAULTS = {
  timeoutMs: 8_000,
  maxServices: 6,
  maxConnectionsPerService: 2,
  maxQueriesPerService: 2,
  maxReadChars: 40_000,
} as const;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface QueryTask {
  service: string;
  connectionName: string;
  profile: QueryProfile;
  query: ProfileQuery;
}

function clampLimit(value: number | undefined): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, numeric));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isActive(status: string | undefined): boolean {
  if (!status) return true;
  return ["active", "connected", "ready"].includes(status.toLowerCase());
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
    return error.message || error.name;
  }
  return String(error);
}

function compareHits(left: QueryHit, right: QueryHit): number {
  const leftTime = left.time ? Date.parse(left.time) : Number.NaN;
  const rightTime = right.time ? Date.parse(right.time) : Number.NaN;
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime) return rightTime - leftTime;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return 0;
}

function fallbackMarkdown(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2) ?? "";
  } catch {
    return String(data);
  }
}

/**
 * Query 层：把「概念 + 条件」翻译成各 provider 的只读 action，并发取回、
 * 合并成统一命中，并如实报告 coverage。
 *
 * 不持久化：每次查询都现场打 oo；ref 无状态；失败/超时只影响当次结果。
 */
export class ConnectorQueryService {
  private readonly profiles: Map<string, QueryProfile>;
  private readonly timeoutMs: number;
  private readonly maxServices: number;
  private readonly maxConnectionsPerService: number;
  private readonly maxQueriesPerService: number;
  private readonly maxReadChars: number;

  constructor(
    private readonly runtime: ConnectorActionRuntime,
    options: ConnectorQueryOptions = {},
  ) {
    const profiles = options.profiles ?? defaultQueryProfiles;
    this.profiles = new Map(profiles.map((profile) => [profile.service, profile]));
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxServices = options.maxServices ?? DEFAULTS.maxServices;
    this.maxConnectionsPerService = options.maxConnectionsPerService ?? DEFAULTS.maxConnectionsPerService;
    this.maxQueriesPerService = options.maxQueriesPerService ?? DEFAULTS.maxQueriesPerService;
    this.maxReadChars = options.maxReadChars ?? DEFAULTS.maxReadChars;
  }

  async query(input: QueryInput, outerSignal?: AbortSignal): Promise<QueryResult> {
    const concept = input.concept.trim();
    const terms = unique((input.terms ?? []).map((term) => term.trim()).filter(Boolean)).slice(0, 8);
    if (!concept && terms.length === 0) {
      throw new ConnectorQueryError("invalid_query", "concept 或 terms 至少提供一个。");
    }
    const limit = clampLimit(input.limit);
    const requested = input.services
      ? unique(input.services.map((service) => service.trim()).filter(Boolean))
      : null;

    const connections = (await this.runtime.listConnections()).filter((connection) => isActive(connection.status));
    const byService = new Map<string, Array<{ service: string; connectionName: string }>>();
    for (const connection of connections) {
      const list = byService.get(connection.service) ?? [];
      list.push({ service: connection.service, connectionName: connection.connectionName });
      byService.set(connection.service, list);
    }

    const coverage: QueryCoverage = { searched: [], skipped: [], failed: [], partial: false };
    const selected = requested ?? [...this.profiles.keys()].filter((service) => (byService.get(service)?.length ?? 0) > 0);
    const tasks: QueryTask[] = [];

    for (const service of selected.slice(0, this.maxServices)) {
      const profile = this.profiles.get(service);
      if (!profile) {
        coverage.skipped.push({ service, reason: "no_profile" });
        continue;
      }
      const serviceConnections = (byService.get(service) ?? []).slice(0, this.maxConnectionsPerService);
      if (serviceConnections.length === 0) {
        coverage.skipped.push({ service, reason: "no_connection" });
        continue;
      }
      const context = {
        concept: concept || terms.join(" "),
        terms,
        limit,
        ...(input.since ? { since: input.since } : {}),
        ...(input.until ? { until: input.until } : {}),
      };
      let queries: ProfileQuery[];
      try {
        queries = profile.buildQueries(context).slice(0, this.maxQueriesPerService);
      } catch (error) {
        coverage.failed.push({ service, connection: "-", message: `build_queries_failed: ${errorMessage(error)}` });
        continue;
      }
      for (const connection of serviceConnections) {
        for (const query of queries) {
          tasks.push({ service, connectionName: connection.connectionName, profile, query });
        }
      }
    }

    const results = await Promise.allSettled(
      tasks.map(async (task) => {
        const data = await this.runWithTimeout(
          (signal) =>
            this.runtime.runAction(task.service, task.query.action, task.query.input, {
              connectionName: task.connectionName,
              signal,
            }),
          outerSignal,
        );
        return { task, data };
      }),
    );

    const hits: QueryHit[] = [];
    const seen = new Set<string>();
    results.forEach((result, index) => {
      const task = tasks[index];
      if (!task) return;
      if (result.status === "rejected") {
        coverage.failed.push({
          service: task.service,
          connection: task.connectionName,
          message: errorMessage(result.reason),
        });
        return;
      }
      coverage.searched.push({
        service: task.service,
        connection: task.connectionName,
        action: task.query.action,
      });
      let parsed;
      try {
        parsed = task.profile.parseHits(result.value.data, {
          concept: concept || terms.join(" "),
          terms,
          limit,
          ...(input.since ? { since: input.since } : {}),
          ...(input.until ? { until: input.until } : {}),
        });
      } catch (error) {
        coverage.failed.push({
          service: task.service,
          connection: task.connectionName,
          message: `parse_failed: ${errorMessage(error)}`,
        });
        return;
      }
      for (const hit of parsed) {
        const id = hit.id.trim();
        if (!id) continue;
        const key = `${task.service}|${task.connectionName}|${hit.kind}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          ref: encodeRef({ v: 1, s: task.service, c: task.connectionName, k: hit.kind, id }),
          service: task.service,
          connection: task.connectionName,
          kind: hit.kind,
          title: hit.title,
          snippet: hit.snippet,
          time: hit.time,
          ...(hit.url ? { url: hit.url } : {}),
        });
      }
    });

    hits.sort(compareHits);
    coverage.partial = coverage.failed.length > 0 || coverage.skipped.length > 0;
    const truncated = hits.length > limit;
    return {
      query: concept || terms.join(" "),
      hits: truncated ? hits.slice(0, limit) : hits,
      coverage,
      truncated,
    };
  }

  async read(refValue: string, outerSignal?: AbortSignal): Promise<QueryReadResult> {
    const ref = decodeRef(refValue);
    if (!ref) {
      throw new ConnectorQueryError("invalid_ref", "ref 无效或已损坏；请用 connector_query 返回的原始 ref。");
    }
    const profile = this.profiles.get(ref.s);
    if (!profile) {
      throw new ConnectorQueryError("no_profile", `没有 ${ref.s} 的查询档案；可改用 execute_action。`);
    }
    const call = profile.buildRead({ kind: ref.k, id: ref.id });
    if (!call) {
      throw new ConnectorQueryError(
        "detail_unsupported",
        `${ref.s} 的 ${ref.k} 命中不支持直接读取；可尝试用命中里的 url 或 execute_action。`,
      );
    }
    const data = await this.runWithTimeout(
      (signal) =>
        this.runtime.runAction(ref.s, call.action, call.input, {
          connectionName: ref.c,
          signal,
        }),
      outerSignal,
    );
    const rendered = profile.renderRead?.(data, { kind: ref.k, id: ref.id }) ?? null;
    const markdown = (rendered?.markdown ?? fallbackMarkdown(data)).trim();
    const totalChars = markdown.length;
    const truncated = totalChars > this.maxReadChars;
    return {
      ref: refValue,
      service: ref.s,
      connection: ref.c,
      kind: ref.k,
      ...(rendered?.title ? { title: rendered.title } : {}),
      ...(rendered?.url ? { url: rendered.url } : {}),
      markdown: truncated ? markdown.slice(0, this.maxReadChars) : markdown,
      truncated,
      totalChars,
    };
  }

  private async runWithTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    outerSignal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
    return run(signal);
  }
}
