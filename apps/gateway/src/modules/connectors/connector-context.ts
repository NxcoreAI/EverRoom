import { defaultQueryProfiles } from "@nxcore/connectors-module/query/index.js";
import type { ConnectorActionRuntime } from "@nxcore/connectors-module/query/index.js";

/**
 * 每个 run 开始时注入的「连接器上下文」。
 *
 * 只给服务清单和能力，不给 action 目录（太多）。
 * 30s 缓存，避免每个 run 都打 oo；会话/连接变化最迟 30s 后生效。
 */
export function createConnectorContextResolver(
  runtime: ConnectorActionRuntime,
  options: { ttlMs?: number; now?: () => number } = {},
): () => Promise<string | null> {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let cachedAt = 0;
  let cached: string | null = null;
  const profileServices = new Set(defaultQueryProfiles.map((profile) => profile.service));

  return async () => {
    if (now() - cachedAt < ttlMs) return cached;
    cachedAt = now();
    try {
      const connections = await runtime.listConnections();
      if (connections.length === 0) {
        cached = null;
        return null;
      }
      const byService = new Map<string, string[]>();
      for (const connection of connections) {
        const names = byService.get(connection.service) ?? [];
        names.push(connection.connectionName);
        byService.set(connection.service, names);
      }
      const lines = [...byService.entries()].map(([service, names]) => {
        const capability = profileServices.has(service) ? "支持模糊查询" : "仅支持 action/链接读取";
        return `- ${service}（${capability}；连接：${names.join(", ")}）`;
      });
      cached = [
        "<connectors>",
        "用户已连接以下外部服务，Agent 可以在工作途中即席检索（不落库、不预同步）：",
        ...lines,
        "外部账号里的资料优先用 connector_query 检索；命中后用 connector_read 读 ref 指向的原文。",
        "注意看返回的 coverage：skipped / failed 表示该来源没查成，不能据此说“没有”。",
        "长尾场景才用 search_actions / get_action_guide / execute_action；当前版本只允许只读 action。",
        "</connectors>",
      ].join("\n");
      return cached;
    } catch {
      cached = null;
      return null;
    }
  };
}
