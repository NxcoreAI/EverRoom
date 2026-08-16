import { and, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { roomWikis, rooms } from "../../infrastructure/database/schema.js";
import { KsAdminClient } from "./ks-client.js";

/**
 * Room ↔ Wiki 注册表（plan §4.1）。
 *
 * 懒创建（D1）：Room 建立时不建 wiki，第一份文档路由到该 Room 时才
 * ensureWikiForRoom。KS create 幂等（同 service+team+name 返回原 wiki），
 * 并发调用下靠 onConflict 兜底回读，进程内另有一层 promise 去重。
 */
export class RoomWikiRegistry {
  private readonly ensuring = new Map<string, Promise<string>>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly ks: KsAdminClient,
  ) {}

  /** Room 当前活跃 wiki 的 knowledgeId；未建或已归档返回 null。 */
  resolveRoomWikiId(roomId: string): string | null {
    const row = this.db.select({ knowledgeId: roomWikis.knowledgeId })
      .from(roomWikis)
      .where(and(eq(roomWikis.roomId, roomId), eq(roomWikis.status, "active")))
      .get();
    return row?.knowledgeId ?? null;
  }

  /**
   * 幂等确保 Room 拥有活跃 wiki，返回 knowledgeId。
   * 首次创建后顺手写 summary（Room 标题的资料空间）——它是将来
   * agent 侧 about 线索和路由层候选身份卡（KS update-meta 维护）。
   */
  async ensureWikiForRoom(roomId: string): Promise<string> {
    const existing = this.resolveRoomWikiId(roomId);
    if (existing) return existing;

    const inflight = this.ensuring.get(roomId);
    if (inflight) return inflight;

    const created = (async () => {
      // 再查一次：等锁期间可能已被并发调用写入。
      const raced = this.resolveRoomWikiId(roomId);
      if (raced) return raced;

      // 归档过的 Room 复活：沿用原行（KS 侧 wiki 数据仍在），只翻状态。
      const archived = this.db.select()
        .from(roomWikis)
        .where(eq(roomWikis.roomId, roomId))
        .get();
      if (archived) {
        this.db.update(roomWikis)
          .set({ status: "active" })
          .where(eq(roomWikis.roomId, roomId))
          .run();
        return archived.knowledgeId;
      }

      const knowledgeId = await this.ks.createWiki(`room-${roomId}`);
      this.db.insert(roomWikis)
        .values({ roomId, knowledgeId })
        .onConflictDoNothing()
        .run();
      const summary = `Room ${this.roomTitle(roomId)} 的资料空间`;
      try {
        await this.ks.updateWikiSummary(knowledgeId, summary);
      } catch {
        // summary 只是身份卡，写失败不阻塞主流程（下次 ensure 会再尝试）。
      }
      return knowledgeId;
    })();

    this.ensuring.set(roomId, created);
    try {
      return await created;
    } finally {
      this.ensuring.delete(roomId);
    }
  }

  listRoomWikis(): Array<{ roomId: string; knowledgeId: string; status: string; createdAt: Date }> {
    return this.db.select().from(roomWikis).all();
  }

  private roomTitle(roomId: string): string {
    const row = this.db.select({ title: rooms.title })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .get();
    return row?.title ?? roomId;
  }
}
