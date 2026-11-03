import type {
  AgentDebugAgent,
  AgentDebugRun,
  AgentDebugRunEvents,
  AgentDebugSnapshot,
  AgentStatusSnapshot,
} from "@nxcore/agent-contract";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { AgentResolver } from "../agent/resolver.js";
import type { AgentDebugService } from "./service.js";
import type { AgentDebugTraceStore } from "./trace-store.js";

/**
 * Agent 调试面板 REST（只读）：按 Agent 展示运行时实际装配的上下文。
 * 走网关全局 bearer（仅桌面端调用），不额外做鉴权。
 */

const AgentIdParams = Type.Object({
  agentId: Type.String({ minLength: 1, maxLength: 100 }),
});

const UsageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const DEFAULT_USAGE_LIMIT = 20;

const ArchivedQuery = Type.Union([
  Type.Literal("include"),
  Type.Literal("only"),
  Type.Literal("exclude"),
]);

const SnapshotQuery = Type.Object({
  runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
  archived: Type.Optional(ArchivedQuery),
});

const RunParams = Type.Object({
  runId: Type.String({ minLength: 1, maxLength: 200 }),
});

const RunEventsQuery = Type.Object({
  afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5_000 })),
});

const ERROR_RUN_STATUSES = new Set(["failed", "interrupted", "timed_out"]);

/** main gateway: AgentStatusService.snapshot() → 调试页 Agent 目录。 */
export function debugAgentsFromStatusSnapshot(snapshot: AgentStatusSnapshot): AgentDebugAgent[] {
  return snapshot.agents.map((agent) => ({
    id: agent.agentId,
    name: agent.name,
    description: agent.description,
    kind: agent.kind,
    state: agent.state,
    activeRunCount: agent.activeRunCount,
    lastRunAt: agent.lastRun?.completedAt ?? agent.lastRun?.startedAt ?? agent.updatedAt ?? null,
  }));
}

/** cursor-completion gateway（无 status service）：从 resolver 定义 + activity 推导。 */
export function debugAgentsFromResolver(resolver: AgentResolver): AgentDebugAgent[] {
  return resolver.list().map((definition) => {
    const activity = resolver.getActivity(definition.id);
    const lastRun = activity.lastRun;
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      kind: definition.kind,
      state: activity.activeRuns.length > 0
        ? "running"
        : lastRun && ERROR_RUN_STATUSES.has(lastRun.status) ? "error" : "idle",
      activeRunCount: activity.activeRuns.length,
      lastRunAt: lastRun?.completedAt ?? lastRun?.startedAt ?? null,
    } satisfies AgentDebugAgent;
  });
}

/** 以调用方 catalog 为准，追加 store 观测到但不在 catalog 里的 Agent（本机 CLI Agent）。 */
export function mergeDebugAgents(
  catalog: AgentDebugAgent[],
  observed: AgentDebugAgent[],
): AgentDebugAgent[] {
  const merged = [...catalog];
  const ids = new Set(catalog.map((agent) => agent.id));
  for (const agent of observed) {
    if (ids.has(agent.id)) continue;
    ids.add(agent.id);
    merged.push(agent);
  }
  return merged;
}

/** 会话标题批量查询（调用方注入 drizzle 查询；缺省或查询失败按 null 处理）。 */
export interface AgentDebugRoutesOptions {
  sessionTitles?: (sessionIds: readonly string[]) => ReadonlyMap<string, string | null>;
}

/** 返回前批量补全 `sessionTitle`：对唯一 sessionId 只查一次库；
 * 子 Agent / 已删除会话 / 查询失败一律为 null（字段始终存在，便于 UI 判断）。 */
export function withSessionTitles(
  runs: readonly AgentDebugRun[],
  lookup?: AgentDebugRoutesOptions["sessionTitles"],
): AgentDebugRun[] {
  if (runs.length === 0) return [];
  const sessionIds = [...new Set(
    runs
      .map((run) => run.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0),
  )];
  let titles: ReadonlyMap<string, string | null> = new Map();
  if (lookup && sessionIds.length > 0) {
    try {
      titles = lookup(sessionIds);
    } catch {
      // 调试数据面：标题查询失败不影响 run 列表返回。
    }
  }
  return runs.map((run) => ({
    ...run,
    sessionTitle: run.sessionId ? titles.get(run.sessionId) ?? null : null,
  }));
}

/**
 * Agent 调试台（独立浏览器页）只读 HTTP API。
 *
 * - `catalog` 由调用方注入（主网关走 AgentStatusService，补全网关走 resolver）；
 * - 缓冲里观测到的本机 Agent 会自动合并进 `agents`（按 id 去重）；
 * - `archived` 控制 snapshot 是否合并磁盘归档（默认 include），响应带 archive 概况；
 * - 可选 `sessionTitles` 批量补全会话标题；
 * - 增量事件默认返回 `seq > afterSeq`，尾部仍在增长的合并 delta 事件会额外
 *   重复返回一条（客户端按 seq upsert）；内存没有时回落到磁盘归档。
 */
export function agentDebugTraceRoutes(
  store: AgentDebugTraceStore,
  catalog: () => AgentDebugAgent[],
  options: AgentDebugRoutesOptions = {},
): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent-debug/snapshot",
      { schema: { tags: ["agent-debug"], querystring: SnapshotQuery } },
      async (request): Promise<AgentDebugSnapshot> => {
        const runs = request.query.runs ?? 150;
        const archived = request.query.archived ?? "include";
        return {
          generatedAt: new Date().toISOString(),
          agents: mergeDebugAgents(catalog(), store.listObservedAgents()),
          runs: withSessionTitles(store.listRuns(runs, archived), options.sessionTitles),
          droppedRuns: store.droppedRuns,
          archive: store.archiveInfo(),
        };
      },
    );

    app.get(
      "/v1/agent-debug/runs/:runId/events",
      { schema: { tags: ["agent-debug"], params: RunParams, querystring: RunEventsQuery } },
      async (request, reply): Promise<AgentDebugRunEvents | undefined> => {
        const run = store.getRun(request.params.runId);
        if (!run) {
          return reply.code(404).send({ error: "not_found", message: "Agent debug run not found" });
        }
        const page = store.listEvents(
          request.params.runId,
          request.query.afterSeq ?? 0,
          request.query.limit ?? 1_000,
        );
        if (!page) {
          return reply.code(404).send({ error: "not_found", message: "Agent debug run not found" });
        }
        return {
          run: withSessionTitles([run], options.sessionTitles)[0] ?? run,
          events: page.events,
          latestSeq: page.latestSeq,
        };
      },
    );
  };
}

export function agentDebugRoutes(service: AgentDebugService): FastifyPluginAsyncTypebox {
  return async (app) => {
    app.get(
      "/v1/agent-debug/agents",
      { schema: { tags: ["agent"] } },
      async () => service.listAgents(),
    );

    app.get(
      "/v1/agent-debug/agents/:agentId/usage",
      { schema: { tags: ["agent"], params: AgentIdParams, querystring: UsageQuery } },
      async (request, reply) => {
        const response = await service.usage(
          request.params.agentId,
          request.query.limit ?? DEFAULT_USAGE_LIMIT,
        );
        if (!response) {
          return reply.code(404).send({
            error: "not_found",
            message: `Unknown Agent: ${request.params.agentId}`,
          });
        }
        return response;
      },
    );

    app.get(
      "/v1/agent-debug/agents/:agentId",
      { schema: { tags: ["agent"], params: AgentIdParams } },
      async (request, reply) => {
        const response = await service.getAgent(request.params.agentId);
        if (!response) {
          return reply.code(404).send({
            error: "not_found",
            message: `Unknown Agent: ${request.params.agentId}`,
          });
        }
        return response;
      },
    );
  };
}