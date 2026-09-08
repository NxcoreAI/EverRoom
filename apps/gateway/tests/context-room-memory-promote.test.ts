import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { contextRooms } from "../src/infrastructure/database/schema.js";
import { ContextRoomService } from "../src/modules/context-rooms/service.js";

const databases: DatabaseClient[] = [];
const temporaryDirectories: string[] = [];

interface HarnessOptions {
  /** data.memoryItems 种子条目。 */
  memoryItems?: Array<Record<string, unknown>>;
  /** 模拟 MemoryCore 蒸馏捕获：记录入参并按配置返回。 */
  captureResult?: boolean;
  captureThrows?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-room-promote-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const service = new ContextRoomService(database.db);
  service.saveSnapshot({
    rooms: [
      {
        id: "room-live",
        title: "项目 Room",
        kind: "项目",
        data: { id: "room-live", title: "项目 Room", memoryItems: options.memoryItems ?? [] },
      },
    ],
    deletedRooms: [],
  });
  const captureCalls: Array<{ roomId: string; itemId: string; content: string; type?: string }> = [];
  service.setMemoryPromoter(async (input) => {
    captureCalls.push(input);
    if (options.captureThrows) throw new Error("memory down");
    return options.captureResult !== false;
  });
  return { service, db: database.db, captureCalls };
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

function roomMemoryItems(db: DatabaseClient["db"], roomId: string): Array<Record<string, unknown>> {
  const row = db.select().from(contextRooms).where(eq(contextRooms.id, roomId)).get();
  return Array.isArray(row?.data?.memoryItems) ? row.data.memoryItems : [];
}

describe("ContextRoomService.promoteMemoryItem", () => {
  it("captures via promoter, marks promotionSessionId and confirms the item", async () => {
    const { service, db, captureCalls } = await harness({
      memoryItems: [{ id: "room-live-memory-1", content: "客户要求 A", type: "客户要求", status: "待确认" }],
    });

    const result = await service.promoteMemoryItem("room-live", "room-live-memory-1");

    expect(result.promotionSessionId).toBe("room-memory:room-live:room-live-memory-1");
    expect(captureCalls).toEqual([
      { roomId: "room-live", itemId: "room-live-memory-1", content: "客户要求 A", type: "客户要求" },
    ]);
    expect(roomMemoryItems(db, "room-live")).toEqual([expect.objectContaining({
      id: "room-live-memory-1",
      status: "已确认",
      promotionSessionId: "room-memory:room-live:room-live-memory-1",
    })]);
  });

  it("is idempotent: a second call does not capture again", async () => {
    const { service, captureCalls } = await harness({
      memoryItems: [{ id: "room-live-memory-1", content: "客户要求 A", type: "客户要求", status: "待确认" }],
    });

    const first = await service.promoteMemoryItem("room-live", "room-live-memory-1");
    const second = await service.promoteMemoryItem("room-live", "room-live-memory-1");

    expect(second.promotionSessionId).toBe(first.promotionSessionId);
    expect(captureCalls).toHaveLength(1);
  });

  it("returns null for items already linked to a memory", async () => {
    const { service, captureCalls } = await harness({
      memoryItems: [{ id: "room-live-memory-2", content: "已关联", type: "事实", status: "已确认", memoryId: "mem-x" }],
    });

    const result = await service.promoteMemoryItem("room-live", "room-live-memory-2");

    expect(result.promotionSessionId).toBeNull();
    expect(captureCalls).toHaveLength(0);
  });

  it("throws for missing room or item without state change", async () => {
    const { service, db, captureCalls } = await harness({
      memoryItems: [{ id: "room-live-memory-1", content: "客户要求 A", type: "客户要求", status: "待确认" }],
    });

    await expect(service.promoteMemoryItem("room-none", "room-live-memory-1"))
      .rejects.toThrow("context_room_not_found");
    await expect(service.promoteMemoryItem("room-live", "item-none"))
      .rejects.toThrow("context_room_memory_item_not_found");
    expect(captureCalls).toHaveLength(0);
    expect(roomMemoryItems(db, "room-live")[0]).toMatchObject({ status: "待确认" });
  });

  it("propagates capture failure without marking the item", async () => {
    const { service, db } = await harness({
      memoryItems: [{ id: "room-live-memory-1", content: "客户要求 A", type: "客户要求", status: "待确认" }],
      captureThrows: true,
    });

    await expect(service.promoteMemoryItem("room-live", "room-live-memory-1"))
      .rejects.toThrow("context_room_memory_capture_failed");
    expect(roomMemoryItems(db, "room-live")[0]).toMatchObject({ status: "待确认" });

    const { service: service2, db: db2 } = await harness({
      memoryItems: [{ id: "room-live-memory-1", content: "客户要求 A", type: "客户要求", status: "待确认" }],
      captureResult: false,
    });
    await expect(service2.promoteMemoryItem("room-live", "room-live-memory-1"))
      .rejects.toThrow("context_room_memory_capture_failed");
    expect(roomMemoryItems(db2, "room-live")[0]).toMatchObject({ status: "待确认" });
  });

  it("throws when memory promotion is not configured", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-room-promote-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    databases.push(database);
    const service = new ContextRoomService(database.db);
    service.saveSnapshot({
      rooms: [{ id: "room-live", title: "项目 Room", kind: "项目", data: { id: "room-live", title: "项目 Room", memoryItems: [{ id: "i1", content: "c", type: "t", status: "待确认" }] } }],
      deletedRooms: [],
    });

    await expect(service.promoteMemoryItem("room-live", "i1"))
      .rejects.toThrow("context_room_memory_not_configured");
  });
});

