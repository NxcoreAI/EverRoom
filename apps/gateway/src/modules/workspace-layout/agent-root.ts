import { eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentWorkspaces } from "../../infrastructure/database/schema.js";
import type { WorkspaceLayoutService } from "./service.js";

/**
 * 空间目录 → Agent 工作目录（项目空间目录化 P2 的最后一块，
 * 见 docs/project-space-layout-plan.zh-CN.md §8.5）。
 *
 * 规则与记忆落点一致：绑了目录且标记可读（`space.everoffice` 健康）→ 返回空间根，
 * 该轮 run 的 pi 会话 cwd、bash 沙箱根、AGENTS.md 来源都换成它；未绑定 / 目录丢了
 * / 标记坏了 → 返回 null，调用方回落 agent 默认工作目录（旧行为不变，绝不静默
 * 重建用户目录）。
 *
 * 与 `SpaceMemoryRoots` 不同，这里**不做缓存**：记忆是每次 recall/remember 都要解析
 * 的热路径，而工作目录一轮 run 只解析一次；缓存反而会让「刚搬完目录就发消息」的这一轮
 * 拿到旧路径——旧目录已不存在，会话会静默回落到 agent 默认工作目录，比多读一个
 * 标记文件贵得多。
 */

export class SpaceAgentRoots {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly layout: WorkspaceLayoutService,
  ) {}

  /** 空间根；未绑定目录或目录不可用时返回 null。 */
  resolve = (workspaceId: string | null | undefined): string | null => {
    const id = workspaceId?.trim();
    if (!id) return null;
    const row = this.db.select({ path: agentWorkspaces.path }).from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, id)).get();
    if (!row?.path) return null;
    const read = this.layout.detect(row.path);
    // 只认「能读懂标记」的空间目录：布局映射来自标记，标记坏了就没有可信的工作根。
    if (read.status !== "ok") return null;
    return this.layout.pathsOf(row.path, read.marker.layout).root;
  };
}
