import type { AgentLibraryInventory } from "@nxcore/agent-contract";

/** 只取计数的最小访问面（便于测试注入假实现）。 */
export interface LibraryCountSource {
  catalogCounts(options?: { workspaceId?: string }): {
    library: number;
    artifacts: number;
    total: number;
  };
}

/**
 * 工作区文件库规模。
 *
 * 只报数量，不报条目：资料库可能有上千份材料，任何「最近 N 条」都不足以代表全库，
 * 而模型看到清单就会以为看完了。条目由模型自己用 library_browse / file_search 取。
 * 库为空或服务未就绪时返回 null（不往提示里塞 0 份的空信息）。
 */
export function collectLibraryInventory(
  source: LibraryCountSource | null | undefined,
  options: { workspaceId?: string | null } = {},
): AgentLibraryInventory | null {
  if (!source) return null;
  const workspaceId = options.workspaceId?.trim() || undefined;
  let counts: ReturnType<LibraryCountSource["catalogCounts"]>;
  try {
    counts = source.catalogCounts(workspaceId ? { workspaceId } : {});
  } catch {
    return null;
  }
  const total = Math.max(0, Math.trunc(counts.total));
  if (total === 0) return null;
  const artifacts = Math.max(0, Math.trunc(counts.artifacts));
  return {
    library: Math.max(0, Math.trunc(counts.library)),
    artifacts,
    total,
  };
}
