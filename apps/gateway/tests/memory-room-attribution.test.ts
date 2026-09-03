import type { FastifyBaseLogger } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { contextRooms, roomMemoryAttributions, roomMemorySuppressions } from "../src/infrastructure/database/schema.js";
import { ContextRoomService } from "../src/modules/context-rooms/service.js";
import { MemoryGatewayError } from "../src/modules/memory/errors.js";
import { memoryRoutes } from "../src/modules/memory/routes.js";
import { MemoryService } from "../src/modules/memory/service.js";

const config: MemoryRuntimeConfig = {
  baseUrl: "http://127.0.0.1:8420",
  apiKey: "memory-key",
  serviceId: "everroom",
  teamId: "everroom",
  agentId: "pi-agent",
  userId: "local-user",
  recallLimit: 5,
  charBudget: 2_000,
};

const databases: DatabaseClient[] = [];
const temporaryDirectories: string[] = [];

const ATOMIC_ITEMS = [
  { id: "memory-a", type: "episodic", content: "记忆 A", background: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  { id: "memory-b", type: "persona", content: "记忆 B", background: null, created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z" },
  { id: "memory-c", type: "instruction", content: "记忆 C", background: null, created_at: "2026-09-03T00:00:00.000Z", updated_at: "2026-09-03T00:00:00.000Z" },
];

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-memory-room-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const roomsService = new ContextRoomService(database.db);
  roomsService.saveSnapshot({
    rooms: [
      { id: "room-live", title: "上线项目", kind: "项目", data: { id: "room-live", title: "上线项目" } },
      { id: "room-gone", title: "已删主题", kind: "主题", data: { id: "room-gone", title: "已删主题" } },
      { id: "room-a", title: "合并源", kind: "事件", data: { id: "room-a", title: "合并源" } },
      { id: "room-b", title: "合并目标", kind: "事件", data: { id: "room-b", title: "合并目标" } },
    ],
    deletedRooms: [],
  });
  const now = new Date();
  database.db.update(contextRooms).set({ deletedAt: now })
    .where(eq(contextRooms.id, "room-gone")).run();
  database.db.update(contextRooms).set({ lifecycle: "merged", mergedIntoRoomId: "room-b", mergedAt: now })
    .where(eq(contextRooms.id, "room-a")).run();

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/v3/atomic/query")) {
      return jsonResponse({ items: ATOMIC_ITEMS, total: ATOMIC_ITEMS.length });
    }
    if (url.endsWith("/v3/atomic/search")) {
      return jsonResponse({ items: ATOMIC_ITEMS.slice(0, 2).map((item) => ({ ...item, score: 0.9 })) });
    }
    if (url.endsWith("/v3/atomic/provenance")) {
      if (body.memory_id === "memory-missing") {
        return new Response(JSON.stringify({ code: 1, message: "not found" }), { status: 404 });
      }
      return jsonResponse({
        memory_id: body.memory_id, type: "episodic", content: "记忆", kind: "conversation",
        session: null, document: null, anchor_message_ids: [], anchors: [],
      });
    }
    if (url.endsWith("/v3/atomic/delete")) {
      return jsonResponse({ deleted_count: (body.ids as string[]).length });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
  const service = new MemoryService(config, logger, { db: database.db, dataDir }, roomsService);
  return { service, db: database.db, roomsService, fetchMock };
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

describe("memory room attribution", () => {
  it("enriches listAtomic with roomId/roomTitle and tolerates unbound or unavailable rooms", async () => {
    const { service, db } = await harness();
    const now = new Date();
    db.insert(roomMemoryAttributions).values([
      { id: "attr-1", roomId: "room-live", memoryId: "memory-a", sourceKind: "user", confidence: "explicit", createdAt: now, updatedAt: now },
      { id: "attr-2", roomId: "room-gone", memoryId: "memory-c", sourceKind: "user", confidence: "explicit", createdAt: now, updatedAt: now },
    ]).run();

    const page = await service.listAtomic({ limit: 50, offset: 0 });
    const byId = new Map(page.items.map((item) => [item.id, item]));
    expect(byId.get("memory-a")).toMatchObject({ roomId: "room-live", roomTitle: "上线项目" });
    expect(byId.get("memory-b")).toMatchObject({ roomId: null, roomTitle: null });
    // 绑定行保留（恢复 Room 即恢复展示），但不可用 Room 不给标题。
    expect(byId.get("memory-c")).toMatchObject({ roomId: "room-gone", roomTitle: null });
  });

  it("enriches searchAtomic results the same way", async () => {
    const { service, db } = await harness();
    const now = new Date();
    db.insert(roomMemoryAttributions).values({
      id: "attr-search", roomId: "room-live", memoryId: "memory-a", sourceKind: "user", confidence: "explicit", createdAt: now, updatedAt: now,
    }).run();

    const result = await service.searchAtomic("记忆", 10);
    expect(result.items.find((item) => item.id === "memory-a")).toMatchObject({ roomId: "room-live", roomTitle: "上线项目" });
    expect(result.items.find((item) => item.id === "memory-b")).toMatchObject({ roomId: null, roomTitle: null });
  });

  it("assigns and re-assigns through the unique memoryId row", async () => {
    const { service, db } = await harness();

    await expect(service.assignAtomicRoom("memory-a", "room-live"))
      .resolves.toEqual({ memoryId: "memory-a", roomId: "room-live" });
    expect(db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, "memory-a")).get())
      .toMatchObject({ roomId: "room-live", sourceKind: "user", confidence: "explicit", sourceId: null });

    // 换绑：memoryId 唯一索引 ⇒ 同一行被 update，不产生第二行。
    await expect(service.assignAtomicRoom("memory-a", "room-b"))
      .resolves.toEqual({ memoryId: "memory-a", roomId: "room-b" });
    const rows = db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, "memory-a")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomId: "room-b" });
  });

  it("binds to the merge-chain terminal room", async () => {
    const { service, db } = await harness();

    await expect(service.assignAtomicRoom("memory-b", "room-a"))
      .resolves.toEqual({ memoryId: "memory-b", roomId: "room-b" });
    expect(db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, "memory-b")).get())
      .toMatchObject({ roomId: "room-b" });
  });

  it("rejects unavailable rooms and missing memories with 404", async () => {
    const { service } = await harness();

    await expect(service.assignAtomicRoom("memory-a", "room-gone")).rejects.toMatchObject({
      code: "memory_error", statusCode: 404,
    } as Partial<MemoryGatewayError>);
    await expect(service.assignAtomicRoom("memory-a", "room-nope")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.assignAtomicRoom("memory-missing", "room-live")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("clears the binding idempotently with roomId=null and suppresses re-derivation", async () => {
    const { service, db } = await harness();
    const now = new Date();
    db.insert(roomMemoryAttributions).values({
      id: "attr-clear", roomId: "room-live", memoryId: "memory-a", sourceKind: "user", confidence: "explicit", createdAt: now, updatedAt: now,
    }).run();

    await expect(service.assignAtomicRoom("memory-a", null)).resolves.toEqual({ memoryId: "memory-a", roomId: null });
    expect(db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, "memory-a")).get()).toBeUndefined();
    // 清除即永久压制：压制行记录被清的 Room，重复清除幂等（保留首次审计值）。
    expect(db.select().from(roomMemorySuppressions).where(eq(roomMemorySuppressions.memoryId, "memory-a")).get())
      .toMatchObject({ memoryId: "memory-a", roomId: "room-live" });
    // 无行时清除同样成功（幂等），且不新增压制行。
    await expect(service.assignAtomicRoom("memory-a", null)).resolves.toEqual({ memoryId: "memory-a", roomId: null });
    expect(db.select().from(roomMemorySuppressions).where(eq(roomMemorySuppressions.memoryId, "memory-a")).all()).toHaveLength(1);
    // 手动重绑不受压制影响（覆盖压制行的 memoryId 冲突策略：归属表独立于压制表）。
    await expect(service.assignAtomicRoom("memory-a", "room-live")).resolves.toEqual({ memoryId: "memory-a", roomId: "room-live" });
    expect(db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, "memory-a")).get()).toBeTruthy();
  });

  it("cleans attribution and suppression rows when memories are deleted", async () => {
    const { service, db } = await harness();
    const now = new Date();
    db.insert(roomMemoryAttributions).values({
      id: "attr-del", roomId: "room-live", memoryId: "memory-a", sourceKind: "user", confidence: "explicit", createdAt: now, updatedAt: now,
    }).run();
    db.insert(roomMemorySuppressions).values({ memoryId: "memory-b", roomId: "room-live", createdAt: now }).run();

    await expect(service.deleteAtomic(["memory-a", "memory-b"])).resolves.toEqual({ deletedCount: 2 });
    expect(db.select().from(roomMemoryAttributions).where(eq(roomMemoryAttributions.memoryId, "memory-a")).get()).toBeUndefined();
    expect(db.select().from(roomMemorySuppressions).where(eq(roomMemorySuppressions.memoryId, "memory-b")).get()).toBeUndefined();
  });

  it("keeps memories readable when the gateway db is absent (enrichment degrades to null)", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/v3/atomic/query")) return jsonResponse({ items: ATOMIC_ITEMS, total: ATOMIC_ITEMS.length });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
    const service = new MemoryService(config, logger, null);

    const page = await service.listAtomic({ limit: 50, offset: 0 });
    expect(page.items.every((item) => item.roomId === null && item.roomTitle === null)).toBe(true);
    await expect(service.assignAtomicRoom("memory-a", "room-live")).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("PUT /v1/memory/atomic/:id/room route", () => {
  it("validates the body and passes roomId through (null = clear)", async () => {
    const assignAtomicRoom = vi.fn(async (id: string, roomId: string | null) => ({ memoryId: id, roomId }));
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(memoryRoutes({ assignAtomicRoom } as unknown as MemoryService));

    const assigned = await app.inject({
      method: "PUT", url: "/v1/memory/atomic/memory-a/room", payload: { roomId: "room-live" },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({ memoryId: "memory-a", roomId: "room-live" });

    const cleared = await app.inject({
      method: "PUT", url: "/v1/memory/atomic/memory-a/room", payload: { roomId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ memoryId: "memory-a", roomId: null });
    expect(assignAtomicRoomMockCalls(assignAtomicRoom)).toEqual([
      ["memory-a", "room-live", { content: undefined, type: undefined, memoryUpdatedAt: undefined }],
      ["memory-a", null, { content: undefined, type: undefined, memoryUpdatedAt: undefined }],
    ]);

    // 缺 roomId 字段 → schema 校验拒绝。
    const invalid = await app.inject({
      method: "PUT", url: "/v1/memory/atomic/memory-a/room", payload: {},
    });
    expect(invalid.statusCode).toBe(400);
  });
});

function assignAtomicRoomMockCalls(
  mock: ReturnType<typeof vi.fn>,
): Array<[string, string | null, { content?: string; type?: string; memoryUpdatedAt?: string }]> {
  return mock.mock.calls as Array<[string, string | null, { content?: string; type?: string; memoryUpdatedAt?: string }]>;
}
