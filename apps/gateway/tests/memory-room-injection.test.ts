import type { FastifyBaseLogger } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { contextRooms, roomMemoryAttributions } from "../src/infrastructure/database/schema.js";
import { ContextRoomService } from "../src/modules/context-rooms/service.js";
import { RoomOverviewService } from "../src/modules/context-rooms/overview-service.js";
import { createContextRoomAgentTools } from "../src/modules/context-rooms/room-agent-tools.js";
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

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-memory-injection-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const roomsService = new ContextRoomService(database.db);
  roomsService.saveSnapshot({
    rooms: [
      { id: "room-live", title: "上线项目", kind: "项目", data: { id: "room-live", title: "上线项目" } },
      { id: "room-gone", title: "已删主题", kind: "主题", data: { id: "room-gone", title: "已删主题" } },
    ],
    deletedRooms: [],
  });
  const now = new Date();
  database.db.update(contextRooms).set({ deletedAt: now })
    .where(eq(contextRooms.id, "room-gone")).run();

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/v3/atomic/provenance")) {
      if (body.memory_id === "memory-missing") {
        return new Response(JSON.stringify({ code: 1, message: "not found" }), { status: 404 });
      }
      return jsonResponse({
        memory_id: body.memory_id, type: "episodic", content: "记忆", kind: "conversation",
        session: null, document: null, anchor_message_ids: [], anchors: [],
      });
    }
    if (url.endsWith("/v3/atomic/update")) {
      return jsonResponse({ id: body.id, version: 2, updated_at: "2026-09-03T12:00:00.000Z" });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
  const service = new MemoryService(config, logger, { db: database.db, dataDir }, roomsService);
  const overview = new RoomOverviewService(database.db, roomsService);
  return { service, db: database.db, roomsService, overview, fetchMock, dataDir, logger };
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

function bindRow(db: DatabaseClient["db"], row: {
  id: string; roomId: string; memoryId: string; content: string | null; type?: string | null; memoryUpdatedAt?: string | null;
}) {
  const now = new Date();
  db.insert(roomMemoryAttributions).values({
    id: row.id,
    roomId: row.roomId,
    memoryId: row.memoryId,
    sourceKind: "user",
    confidence: "explicit",
    content: row.content,
    memoryType: row.type ?? null,
    memoryUpdatedAt: row.memoryUpdatedAt ?? null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: roomMemoryAttributions.memoryId,
    set: { roomId: row.roomId, content: row.content, updatedAt: now },
  }).run();
}

describe("room memory snapshots and injection retrieval", () => {
  it("listRoomMemories orders by recency, skips snapshot-less rows and truncates long content", async () => {
    const { service, db } = await harness();
    bindRow(db, { id: "a1", roomId: "room-live", memoryId: "m-old", content: "旧记忆", memoryUpdatedAt: "2026-08-01T00:00:00.000Z" });
    bindRow(db, { id: "a2", roomId: "room-live", memoryId: "m-new", content: "新记忆", type: "fact", memoryUpdatedAt: "2026-09-01T00:00:00.000Z" });
    bindRow(db, { id: "a3", roomId: "room-live", memoryId: "m-nosnap", content: null });

    const items = await service.listRoomMemories("room-live");
    expect(items.map((item) => item.memoryId)).toEqual(["m-new", "m-old"]);
    expect(items[0]).toMatchObject({ type: "fact", content: "新记忆", updatedAt: "2026-09-01T00:00:00.000Z" });

    const long = "长".repeat(600);
    bindRow(db, { id: "a4", roomId: "room-live", memoryId: "m-long", content: long, memoryUpdatedAt: "2026-09-02T00:00:00.000Z" });
    const truncated = await service.listRoomMemories("room-live");
    const longItem = truncated.find((item) => item.memoryId === "m-long");
    expect(longItem!.content.length).toBeLessThanOrEqual(501);
    expect(longItem!.content.endsWith("…")).toBe(true);
  });

  it("listRoomMemories returns empty for unavailable rooms and empty rooms", async () => {
    const { service } = await harness();
    await expect(service.listRoomMemories("room-gone")).resolves.toEqual([]);
    await expect(service.listRoomMemories("no-such-room")).resolves.toEqual([]);
  });

  it("searchRoomMemories filters by AND-matched lowercase tokens and honours limit", async () => {
    const { service, db } = await harness();
    bindRow(db, { id: "s1", roomId: "room-live", memoryId: "m1", content: "部署手册使用内部镜像仓库", memoryUpdatedAt: "2026-09-01T00:00:00.000Z" });
    bindRow(db, { id: "s2", roomId: "room-live", memoryId: "m2", content: "镜像每周自动同步", memoryUpdatedAt: "2026-09-02T00:00:00.000Z" });

    await expect(service.searchRoomMemories("room-live", "镜像 仓库", 5)).resolves.toHaveLength(1);
    await expect(service.searchRoomMemories("room-live", "MIRROR", 5)).resolves.toEqual([]);
    await expect(service.searchRoomMemories("room-live", "镜像", 1)).resolves.toHaveLength(1);
    await expect(service.searchRoomMemories("room-gone", "镜像", 5)).resolves.toEqual([]);
    await expect(service.searchRoomMemories("room-live", "  ", 5)).resolves.toEqual([]);
  });

  it("assignAtomicRoom stores snapshots, preserves them on snapshot-less rebind and clears rows", async () => {
    const { service, db } = await harness();
    await service.assignAtomicRoom("memory-a", "room-live", {
      content: "初始内容", type: "episodic", memoryUpdatedAt: "2026-09-01T00:00:00.000Z",
    });
    const first = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "memory-a")).all();
    expect(first[0]).toMatchObject({
      roomId: "room-live", content: "初始内容", memoryType: "episodic", memoryUpdatedAt: "2026-09-01T00:00:00.000Z",
    });

    // 换绑不带快照：roomId 跟随，既有快照保留。
    await service.assignAtomicRoom("memory-a", "room-live");
    const second = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "memory-a")).all();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ content: "初始内容" });

    await service.assignAtomicRoom("memory-a", null);
    expect(db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "memory-a")).all()).toHaveLength(0);
  });

  it("updateAtomic refreshes the snapshot row without blocking the edit", async () => {
    const { service, db } = await harness();
    bindRow(db, { id: "u1", roomId: "room-live", memoryId: "memory-a", content: "旧内容", memoryUpdatedAt: "2026-08-01T00:00:00.000Z" });
    const result = await service.updateAtomic("memory-a", "编辑后的内容");
    expect(result.updatedAt).toBe("2026-09-03T12:00:00.000Z");
    const row = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "memory-a")).all();
    expect(row[0]).toMatchObject({ content: "编辑后的内容", memoryUpdatedAt: "2026-09-03T12:00:00.000Z" });

    // 无归属行的记忆编辑不报错。
    await expect(service.updateAtomic("memory-unbound", "新内容")).resolves.toBeTruthy();
  });

  it("PUT /v1/memory/atomic/:id/room accepts snapshot fields", async () => {
    const { service, db, dataDir } = await harness();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(memoryRoutes(service));
    const response = await app.inject({
      method: "PUT",
      url: "/v1/memory/atomic/memory-a/room",
      payload: {
        roomId: "room-live",
        content: "路由快照内容",
        type: "persona",
        memoryUpdatedAt: "2026-09-03T08:00:00.000Z",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ memoryId: "memory-a", roomId: "room-live" });
    const row = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "memory-a")).all();
    expect(row[0]).toMatchObject({ content: "路由快照内容", memoryType: "persona" });
    expect(dataDir.length).toBeGreaterThan(0);
    await app.close();
  });

  it("context-room subagent memory_search honours room_id and degrades for unavailable rooms", async () => {
    const { service, db, overview } = await harness();
    bindRow(db, { id: "t1", roomId: "room-live", memoryId: "m1", content: "Room 绑定的部署约束", memoryUpdatedAt: "2026-09-01T00:00:00.000Z" });
    const tools = createContextRoomAgentTools({ db, memory: service, overview });
    const tool = tools.find((candidate) => candidate.name === "memory_search");
    expect(tool).toBeTruthy();
    const runInput = {
      sessionId: "s",
      runId: "r",
      runtimeSessionRef: null,
      prompt: "p",
      pageLabel: "l",
      roomId: "room-live",
    } as Parameters<NonNullable<typeof tool>["execute"]>[0];

    const scoped = await tool!.execute(runInput, {
      query: "部署 约束", room_id: "room-live",
    });
    expect(scoped.content).toContain("Room 绑定的部署约束");

    const unavailable = await tool!.execute(runInput, {
      query: "部署", room_id: "room-gone",
    });
    expect(unavailable.content).toContain("没有匹配的绑定记忆");
  });
});
