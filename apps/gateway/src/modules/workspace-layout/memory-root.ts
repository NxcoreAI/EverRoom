import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentWorkspaces } from "../../infrastructure/database/schema.js";
import type { WorkspaceLayoutService } from "./service.js";

/**
 * 空间记忆库根（P2）：把「这个工作区的记忆放哪」收敛成一个可缓存的小查询。
 *
 * 规则：空间绑定了目录 → `<space>/.everoffice/memory`（位置来自标记的 layout 映射；
 * v1 未迁移的空间是 `<space>/Memory`）；未绑目录 → null，调用方继续用全局库
 * `<dataDir>/memory/hippo`。
 *
 * 记忆的读写在每次 run 都会发生（recall/remember），所以这里带 60 秒缓存：
 * 空间目录只有换绑/搬移时才会变。命中缓存时会顺手确认目录还在——v1→v2 迁移会把
 * `Memory/` 搬进 `.everoffice/memory`，不确认的话下一次 recall 会把旧路径复活成空目录。
 */

const CACHE_TTL_MS = 60_000;

export class SpaceMemoryRoots {
  private readonly cache = new Map<string, { root: string | null; at: number }>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly layout: WorkspaceLayoutService,
  ) {}

  /** 记忆库根；未绑定返回 null。 */
  resolve = (workspaceId: string | null | undefined): string | null => {
    const id = workspaceId?.trim();
    if (!id) return null;
    const cached = this.cache.get(id);
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS && (!cached.root || existsSync(cached.root))) {
      return cached.root;
    }
    const row = this.db.select({ path: agentWorkspaces.path }).from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, id)).get();
    let root: string | null = null;
    if (row?.path) {
      const read = this.layout.detect(row.path);
      if (read.status === "ok") {
        root = this.layout.pathsOf(row.path, read.marker.layout).memory;
      }
    }
    this.cache.set(id, { root, at: now });
    return root;
  };

  /** 换绑/搬移后主动失效。 */
  invalidate(workspaceId?: string): void {
    if (workspaceId) this.cache.delete(workspaceId);
    else this.cache.clear();
  }
}
