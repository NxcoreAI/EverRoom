/**
 * Room wiki 页面标题缓存（③ 实体匹配的 Room 侧术语表来源，plan §5.2）。
 *
 * ingest 成功后失效重拉（invalidate），平时 TTL 兜底防陈旧；
 * 拉取失败按空表处理（该 Room 本轮不参与 ③，不阻塞路由）。
 * 标题缓存同时给 ⑤ 卷宗当"代表页面标题"。
 */

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { and, eq, isNull } from "drizzle-orm";
import { rooms, roomWikis } from "../../infrastructure/database/schema.js";
import type { KsAdminClient } from "./ks-client.js";

const CACHE_TTL_MS = 5 * 60_000;
/** 单 wiki 卷宗里展示的代表页面标题上限。 */
const REPRESENTATIVE_TITLES_LIMIT = 12;

interface CacheEntry {
  titles: string[];
  fetchedAt: number;
  /** 拉取失败后的短暂冷却，避免每轮路由都打 KS。 */
  retryAt: number;
  failed: boolean;
}

export interface RoomIndexSnapshot {
  roomId: string;
  knowledgeId: string;
  /** wiki 页面标题（③ 术语表 + ⑤ 卷宗）。 */
  pageTitles: string[];
}

export class WikiPageIndex {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly ks: KsAdminClient,
  ) {}

  /** ingest 落定后调用：下一轮路由重拉该 wiki 标题。 */
  invalidate(knowledgeId: string): void {
    this.cache.delete(knowledgeId);
  }

  /**
   * 全量快照：所有存活 Room 的 active wiki 各取一份标题索引。
   * 逐 wiki 串行拉取（KS 本地服务、page/ls 轻量）；失败的 wiki 跳过。
   */
  async snapshot(): Promise<Map<string, RoomIndexSnapshot>> {
    const rows = this.db.select({ roomId: roomWikis.roomId, knowledgeId: roomWikis.knowledgeId })
      .from(roomWikis)
      .innerJoin(rooms, eq(rooms.id, roomWikis.roomId))
      .where(and(eq(roomWikis.status, "active"), isNull(rooms.deletedAt)))
      .all();

    const snapshot = new Map<string, RoomIndexSnapshot>();
    const now = Date.now();
    for (const row of rows) {
      const entry = this.cache.get(row.knowledgeId);
      if (entry && !entry.failed && now - entry.fetchedAt < CACHE_TTL_MS) {
        snapshot.set(row.roomId, { roomId: row.roomId, knowledgeId: row.knowledgeId, pageTitles: entry.titles });
        continue;
      }
      if (entry?.failed && entry.retryAt > now) continue;

      try {
        const items = await this.ks.listPages(row.knowledgeId);
        const titles = items.map((item) => item.title).filter((title) => title.length > 0);
        this.cache.set(row.knowledgeId, { titles, fetchedAt: now, retryAt: 0, failed: false });
        snapshot.set(row.roomId, { roomId: row.roomId, knowledgeId: row.knowledgeId, pageTitles: titles });
      } catch {
        this.cache.set(row.knowledgeId, {
          titles: entry?.titles ?? [],
          fetchedAt: entry?.fetchedAt ?? 0,
          retryAt: now + CACHE_TTL_MS,
          failed: true,
        });
      }
    }
    return snapshot;
  }

  /** ⑤ 卷宗用：单个 wiki 的代表页面标题（走缓存，未命中现拉）。 */
  async representativeTitles(knowledgeId: string): Promise<string[]> {
    const now = Date.now();
    const entry = this.cache.get(knowledgeId);
    if (entry && !entry.failed && now - entry.fetchedAt < CACHE_TTL_MS) {
      return entry.titles.slice(0, REPRESENTATIVE_TITLES_LIMIT);
    }
    try {
      const items = await this.ks.listPages(knowledgeId);
      const titles = items.map((item) => item.title).filter((title) => title.length > 0);
      this.cache.set(knowledgeId, { titles, fetchedAt: now, retryAt: 0, failed: false });
      return titles.slice(0, REPRESENTATIVE_TITLES_LIMIT);
    } catch {
      if (entry && !entry.failed) return entry.titles.slice(0, REPRESENTATIVE_TITLES_LIMIT);
      return [];
    }
  }
}
