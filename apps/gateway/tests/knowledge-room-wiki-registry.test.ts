import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";
import { RoomWikiRegistry } from "../src/modules/knowledge/registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/**
 * 真实 sqlite（临时目录）+ 不可达 KS 的服务实例；KS 不可达不影响注册表行为
 * （复活/自愈/清单都是纯 DB 操作，只有首次建 wiki 才触达 KS）。
 */
async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-wiki-registry-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const config = {
    baseUrl: "http://127.0.0.1:9", // 不可达即可
    serviceId: "everroom",
    teamId: "everroom",
    dataDir,
    roomWikisEnabled: false,
    ingestDebounceMs: 600_000,
    routerEnabled: true,
    entityPromoteScore: 2.0,
    entityPromoteSources: 2,
    mergeAutoDice: 0.75,
    mergeJudgeDice: 0.6,
    llm: null,
    embeddingLlm: null,
    embeddingModel: "",
  };
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  return {
    db,
    sqlite,
    config,
    logger,
    /** 再建一个实例：构造时跑一遍启动自愈（僵尸 active 行翻 archived）。 */
    rebuildService: () => new KnowledgeService(db, config, logger),
    rows: <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    /** UPDATE/INSERT 用（better-sqlite3 不返回数据行）。 */
    run: (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params),
  };
}

describe("RoomWikiRegistry：已合并/软删房的 wiki 残卷治理", () => {
  it("listRoomWikis 只列活房——合并房与软删房的 wiki 不出现在顶层清单", async () => {
    const test = await serviceForTest();
    const service = test.rebuildService();
    service.upsertRoom({ id: "room-live", title: "活房" });
    service.upsertRoom({ id: "room-merged", title: "被合并房" });
    service.upsertRoom({ id: "room-deleted", title: "被删房" });
    test.run(
      "UPDATE rooms SET lifecycle = 'merged', merged_into_room_id = 'room-live' WHERE id = 'room-merged'",
    );
    test.run("UPDATE rooms SET deleted_at = strftime('%s','now') * 1000 WHERE id = 'room-deleted'");
    test.run(
      `INSERT INTO room_wikis (room_id, knowledge_id, status, created_at) VALUES
        ('room-live', 'wiki-live', 'active', strftime('%s','now') * 1000),
        ('room-merged', 'wiki-merged', 'active', strftime('%s','now') * 1000),
        ('room-deleted', 'wiki-deleted', 'archived', strftime('%s','now') * 1000)`,
    );

    const listed = service.listRoomWikis().map((wiki) => wiki.roomId);
    expect(listed).toEqual(["room-live"]);
  });

  it("启动自愈：已合并房残留的 status=active 僵尸行被翻回 archived", async () => {
    const test = await serviceForTest();
    const boot = test.rebuildService();
    boot.upsertRoom({ id: "room-a", title: "A" });
    boot.upsertRoom({ id: "room-b", title: "B" });
    test.run("UPDATE rooms SET lifecycle = 'merged', merged_into_room_id = 'room-a' WHERE id = 'room-b'");
    // 模拟旧版合并路径漏归档：房已 merged，wiki 还挂着 active
    test.run(
      "INSERT INTO room_wikis (room_id, knowledge_id, status, created_at) VALUES ('room-b', 'wiki-zombie', 'active', strftime('%s','now') * 1000)",
    );

    // 新实例构造时自愈（不 rebuildService 也能靠 listRoomWikis 的 join 过滤兜底，
    // 但自愈把库面状态也修正掉）
    test.rebuildService();

    const statuses = test.rows<{ room_id: string; status: string }>(
      "SELECT room_id, status FROM room_wikis",
    );
    expect(statuses).toEqual([{ room_id: "room-b", status: "archived" }]);
  });

  it("ensureWikiForRoom 不复活已合并房的 wiki，活房的归档行照常翻回 active", async () => {
    const test = await serviceForTest();
    const service = test.rebuildService();
    service.upsertRoom({ id: "room-live", title: "活房" });
    service.upsertRoom({ id: "room-merged", title: "被合并房" });
    test.run("UPDATE rooms SET lifecycle = 'merged', merged_into_room_id = 'room-live' WHERE id = 'room-merged'");
    test.run(
      `INSERT INTO room_wikis (room_id, knowledge_id, status, created_at) VALUES
        ('room-live', 'wiki-live', 'archived', strftime('%s','now') * 1000),
        ('room-merged', 'wiki-merged', 'archived', strftime('%s','now') * 1000)`,
    );

    const registry = new RoomWikiRegistry(
      test.db,
      new (await import("../src/modules/knowledge/ks-client.js")).KsAdminClient({
        baseUrl: "http://127.0.0.1:9",
        serviceId: "everroom",
        teamId: "everroom",
      }),
    );

    await expect(registry.ensureWikiForRoom("room-merged")).resolves.toBe("wiki-merged");
    expect(
      test.rows<{ status: string }>("SELECT status FROM room_wikis WHERE room_id = 'room-merged'")[0],
    ).toEqual({ status: "archived" });

    await expect(registry.ensureWikiForRoom("room-live")).resolves.toBe("wiki-live");
    expect(
      test.rows<{ status: string }>("SELECT status FROM room_wikis WHERE room_id = 'room-live'")[0],
    ).toEqual({ status: "active" });
  });
});
