import type { FastifyBaseLogger } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRuntimeConfig } from "@nxcore/agent-runtime-pi";
import { eq } from "drizzle-orm";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  agentRuns,
  agentSessions,
  contextRooms,
  documents,
  gatewayMetadata,
  roomDocumentLinks,
  roomMemoryAttributions,
  roomMemorySuppressions,
  roomSourceMemberships,
} from "../src/infrastructure/database/schema.js";
import { ContextRoomService } from "../src/modules/context-rooms/service.js";
import { MemoryService } from "../src/modules/memory/service.js";
import { RoomMemoryDeriveWorker } from "../src/modules/memory/room-derive-worker.js";

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

interface FakeMemoryRow {
  id: string;
  type: string;
  content: string;
  created_at: string;
  updated_at: string;
  session_id: string | null;
  /** 无会话的 document 来源记忆（统一 ingest 导入）：caller_ref = 知识 sourceId。 */
  document_caller_ref?: string;
}

interface HarnessOptions {
  memories?: FakeMemoryRow[];
  /** 可变失败名单：provenance 对其中的 id 返回 500；清空即模拟恢复。 */
  provenanceFailFor?: string[];
}

async function harness(options: HarnessOptions = {}) {
  const memories = options.memories ?? [];
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-memory-derive-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const roomsService = new ContextRoomService(database.db);
  roomsService.saveSnapshot({
    rooms: [
      { id: "room-live", title: "上线项目", kind: "项目", data: { id: "room-live", title: "上线项目" } },
      { id: "room-old", title: "合并源", kind: "事件", data: { id: "room-old", title: "合并源" } },
      { id: "room-new", title: "合并目标", kind: "事件", data: { id: "room-new", title: "合并目标" } },
    ],
    deletedRooms: [],
  });
  const now = new Date();
  database.db.update(contextRooms)
    .set({ lifecycle: "merged", mergedIntoRoomId: "room-new", mergedAt: now })
    .where(eq(contextRooms.id, "room-old")).run();

  const provenanceCalls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/v3/atomic/query")) {
      // 忠实模拟 MemoryCore：updated_at DESC + time_start 含端点过滤 + limit/offset + 真实 total。
      let rows = [...memories].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      const timeStart = typeof body.time_start === "string" ? body.time_start : null;
      if (timeStart !== null) {
        rows = rows.filter((row) => row.updated_at >= timeStart);
      }
      const total = rows.length;
      const offset = Number(body.offset ?? 0);
      const limit = Number(body.limit ?? 100);
      return jsonResponse({ items: rows.slice(offset, offset + limit), total });
    }
    if (url.endsWith("/v3/atomic/provenance")) {
      provenanceCalls.push(String(body.memory_id));
      const row = memories.find((candidate) => candidate.id === body.memory_id);
      if (!row) {
        return new Response(JSON.stringify({ code: 1, message: "not found" }), { status: 404 });
      }
      if (options.provenanceFailFor?.includes(row.id)) {
        return new Response(JSON.stringify({ code: 1, message: "boom" }), { status: 500 });
      }
      const document = row.document_caller_ref
        ? {
            document_id: `mc-${row.id}`,
            title: "导入文档",
            caller_ref: row.document_caller_ref,
            version: 1,
            session_id: row.session_id ?? undefined,
          }
        : null;
      return jsonResponse({
        memory_id: row.id, type: row.type, content: row.content,
        kind: document ? "document" : "conversation",
        session: row.session_id && !document ? { session_id: row.session_id } : null,
        document, anchor_message_ids: [], anchors: [],
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as FastifyBaseLogger;
  const service = new MemoryService(config, logger, { db: database.db, dataDir }, roomsService);
  const worker = new RoomMemoryDeriveWorker(database.db, service, logger as never, { intervalMs: 3_600_000 });
  return {
    service, worker, db: database.db, fetchMock, provenanceCalls, logger,
  };
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ code: 0, message: "ok", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function memory(id: string, updatedAt: string, sessionId: string | null): FakeMemoryRow {
  return { id, type: "fact", content: `记忆 ${id}`, created_at: updatedAt, updated_at: updatedAt, session_id: sessionId };
}

function seedRun(db: DatabaseClient["db"], sessionId: string, roomId: string | null, createdAt: Date) {
  db.insert(agentSessions).values({ id: sessionId, pageLabel: "页", runtimeId: "pi", createdAt, updatedAt: createdAt })
    .onConflictDoNothing().run();
  db.insert(agentRuns).values({
    id: `run-${sessionId}-${createdAt.getTime()}`,
    sessionId,
    agentId: "main",
    invocationMode: "explicit_switch",
    idempotencyKey: `ik-${sessionId}-${createdAt.getTime()}`,
    roomId,
    status: "completed",
    prompt: "p",
    createdAt,
    completedAt: createdAt,
  }).onConflictDoNothing().run();
}

function cursorValue(db: DatabaseClient["db"]): string | null {
  const row = db.select({ value: gatewayMetadata.value }).from(gatewayMetadata)
    .where(eq(gatewayMetadata.key, "memory.room-derive.v3:cursor")).get();
  if (!row?.value) return null;
  return (JSON.parse(row.value) as { updatedAt: string | null }).updatedAt;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

describe("RoomMemoryDeriveWorker", () => {
  it("derives an attribution through session→run→room with merge-chain terminal and snapshot", async () => {
    const at = "2026-09-03T10:00:00.000Z";
    const { worker, db } = await harness({ memories: [memory("m1", at, "sess-1")] });
    seedRun(db, "sess-1", "room-old", new Date("2026-09-03T09:00:00.000Z"));

    await worker.drain();

    const row = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "m1")).all();
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({
      roomId: "room-new", // 合并链终点（room-old → room-new）
      sourceKind: "conversation",
      sourceId: "sess-1",
      confidence: "derived",
      content: "记忆 m1",
      memoryType: "fact",
      memoryUpdatedAt: at,
    });
    // 扫尽且无失败：游标上收到最新已检查项。
    expect(cursorValue(db)).toBe(at);
  });

  it("never overwrites explicit bindings and skips suppressed memories", async () => {
    const at1 = "2026-09-03T10:00:00.000Z";
    const at2 = "2026-09-03T10:05:00.000Z";
    const { worker, db } = await harness({
      memories: [memory("m-explicit", at1, "sess-1"), memory("m-suppressed", at2, "sess-1")],
    });
    seedRun(db, "sess-1", "room-live", new Date("2026-09-03T09:00:00.000Z"));
    const now = new Date();
    db.insert(roomMemoryAttributions).values({
      id: "x1", roomId: "room-live", memoryId: "m-explicit", sourceKind: "user",
      confidence: "explicit", createdAt: now, updatedAt: now,
    }).run();
    db.insert(roomMemorySuppressions).values({ memoryId: "m-suppressed", roomId: "room-live", createdAt: now }).run();

    await worker.drain();

    const explicit = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "m-explicit")).all();
    expect(explicit[0]).toMatchObject({ confidence: "explicit", sourceKind: "user" });
    expect(db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "m-suppressed")).all()).toHaveLength(0);
    expect(cursorValue(db)).toBe(at2);
  });

  it("skips synthetic session ids and runs without roomId as stable terminals", async () => {
    const at = "2026-09-03T10:00:00.000Z";
    const { worker, db } = await harness({
      memories: [memory("m-wiki", at, "wiki:src:doc-1"), memory("m-noroom", at, "sess-2")],
    });
    seedRun(db, "sess-2", null, new Date("2026-09-03T09:00:00.000Z"));

    await worker.drain();

    expect(db.select().from(roomMemoryAttributions).all()).toHaveLength(0);
    expect(cursorValue(db)).toBe(at);
  });

  it("only considers runs created before the memory was created", async () => {
    const at = "2026-09-03T12:00:00.000Z";
    const { worker, db } = await harness({ memories: [memory("m1", at, "sess-3")] });
    seedRun(db, "sess-3", "room-live", new Date("2026-09-03T08:00:00.000Z"));
    seedRun(db, "sess-3", null, new Date("2026-09-03T10:00:00.000Z"));
    // 晚于记忆创建时间的 run（另一 Room）不参与映射。
    seedRun(db, "sess-3", "room-new", new Date("2026-09-03T18:00:00.000Z"));

    await worker.drain();

    const row = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "m1")).all();
    expect(row[0]?.roomId).toBe("room-live");
  });

  it("retries after a provenance failure and settles once recovered", async () => {
    const at1 = "2026-09-03T10:03:00.000Z";
    const at2 = "2026-09-03T10:01:00.000Z";
    const failIds = ["m-flaky"];
    const { worker, db, provenanceCalls } = await harness({
      memories: [memory("m-ok", at1, "sess-1"), memory("m-flaky", at2, "sess-1")],
      provenanceFailFor: failIds,
    });
    seedRun(db, "sess-1", "room-live", new Date("2026-09-03T09:00:00.000Z"));

    // drain1：DESC 序先遇 m-ok 成功，再遇 m-flaky 失败中止；游标停在 min(examined)=at2。
    await worker.drain();
    expect(db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "m-flaky")).all()).toHaveLength(0);
    expect(cursorValue(db)).toBe(at2);

    failIds.length = 0; // 模拟恢复。
    await worker.drain();
    const row = db.select().from(roomMemoryAttributions)
      .where(eq(roomMemoryAttributions.memoryId, "m-flaky")).all();
    expect(row).toHaveLength(1);
    expect(cursorValue(db)).toBe(at1);

    // drain3：两条都有归属行，provenance 不再被调用。
    const calls = provenanceCalls.length;
    await worker.drain();
    expect(provenanceCalls.length).toBe(calls);
  });

  it("spreads work across drains with maxPerDrain", async () => {
    const { worker: _unused, db, service, logger } = await harness({
      memories: [
        memory("m-a", "2026-09-03T10:03:00.000Z", "sess-1"),
        memory("m-b", "2026-09-03T10:02:00.000Z", "sess-1"),
        memory("m-c", "2026-09-03T10:01:00.000Z", "sess-1"),
      ],
    });
    void _unused;
    seedRun(db, "sess-1", "room-live", new Date("2026-09-03T09:00:00.000Z"));
    const capped = new RoomMemoryDeriveWorker(db, service, logger as never, {
      intervalMs: 3_600_000,
      maxPerDrain: 2,
    });

    await capped.drain();
    expect(db.select().from(roomMemoryAttributions).all()).toHaveLength(2);
    expect(cursorValue(db)).toBe("2026-09-03T10:01:00.000Z"); // stopAt=首个未检查项，下轮窗口含它。

    await capped.drain();
    expect(db.select().from(roomMemoryAttributions).all()).toHaveLength(3);
    expect(cursorValue(db)).toBe("2026-09-03T10:03:00.000Z"); // 扫尽上收。
  });

  it("idles when memory is disabled and treats provenance 404 as processed", async () => {
    const at = "2026-09-03T10:00:00.000Z";
    const { worker, db, service, fetchMock } = await harness({
      memories: [memory("m-gone", at, "sess-1")],
    });
    // 记忆在 provenance 里不存在（404）→ 视为已处理，游标推进。
    await worker.drain();
    expect(db.select().from(roomMemoryAttributions).all()).toHaveLength(0);
    expect(cursorValue(db)).toBe(at);

    service.replaceConfig(null);
    const queryCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/v3/atomic/query")).length;
    await worker.drain();
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/v3/atomic/query")).length)
      .toBe(queryCalls);
  });

  it("derives document: rewrite sessions through room_doc_links", async () => {
    const at = "2026-09-03T10:00:00.000Z";
    const { worker, db } = await harness({
      memories: [
        { ...memory("m-rewrite", at, "document:doc-1") },
        { ...memory("m-unlinked", at, "document:doc-none") },
      ],
    });
    const now = new Date();
    db.insert(documents).values({ id: "doc-1", title: "文档一", contentJson: {} }).run();
    db.insert(roomDocumentLinks).values([
      { roomId: "room-live", documentId: "doc-1", linkedAt: now },
      { roomId: "room-old", documentId: "doc-1", linkedAt: new Date(now.getTime() - 1) },
    ]).run();

    await worker.drain();
    const rows = db.select().from(roomMemoryAttributions).all();
    // doc-1 挂过两个 Room（合并源 + 上线项目）：取最新挂载 room-live。
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memoryId: "m-rewrite",
      roomId: "room-live",
      sourceKind: "document",
      sourceId: "document:doc-1",
      confidence: "derived",
    });
  });

  it("derives wiki: sessions and ingest callerRef through room_source_memberships", async () => {
    const at = "2026-09-03T10:00:00.000Z";
    const { worker, db } = await harness({
      memories: [
        { ...memory("m-wiki", at, "wiki:src-1:doc-9") },
        { ...memory("m-ingest", at, null), document_caller_ref: "src-1" },
        { ...memory("m-excluded", at, "wiki:src-x:doc-8") },
      ],
    });
    const now = new Date();
    db.insert(roomSourceMemberships).values([
      {
        id: "mem-1", roomId: "room-live", sourceKind: "file", sourceId: "src-1",
        sourceVersion: 1, evidenceGroupKey: "gk-1", role: "primary", qualityLevel: "normal", createdAt: now, updatedAt: now,
      },
      {
        id: "mem-2", roomId: "room-live", sourceKind: "file", sourceId: "src-x",
        sourceVersion: 1, evidenceGroupKey: "gk-2", role: "mention", qualityLevel: "excluded", createdAt: now, updatedAt: now,
      },
    ]).run();

    await worker.drain();
    const rows = db.select().from(roomMemoryAttributions).all();
    // wiki 会话与 ingest callerRef 都映射到知识源；excluded 证据不绑。
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.memoryId === "m-wiki")).toMatchObject({
      roomId: "room-live", sourceKind: "source", sourceId: "wiki:src-1:doc-9",
    });
    expect(rows.find((row) => row.memoryId === "m-ingest")).toMatchObject({
      roomId: "room-live", sourceKind: "source", sourceId: "source:src-1",
    });
  });

  it("derives room-memory: promotion sessions with attribution and item writeback", async () => {
    const at = "2026-09-03T10:00:00.000Z";
    const sessionId = "room-memory:room-live:room-live-memory-1";
    const { worker, db } = await harness({
      memories: [memory("m-promoted", at, sessionId)],
    });
    // 晋升条目：promotionSessionId 已由 promote API 落库，等 worker 回填 memoryId。
    const roomRow = db.select().from(contextRooms).where(eq(contextRooms.id, "room-live")).get();
    db.update(contextRooms).set({
      data: {
        ...roomRow!.data,
        memoryItems: [{
          id: "room-live-memory-1",
          content: "用户偏好事实",
          type: "人物偏好",
          status: "已确认",
          promotionSessionId: sessionId,
        }],
      },
    }).where(eq(contextRooms.id, "room-live")).run();

    await worker.drain();

    const rows = db.select().from(roomMemoryAttributions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memoryId: "m-promoted",
      roomId: "room-live",
      sourceKind: "room_item",
      sourceId: sessionId,
      confidence: "derived",
      content: "记忆 m-promoted",
    });
    const updated = db.select().from(contextRooms).where(eq(contextRooms.id, "room-live")).get();
    expect(updated!.data.memoryItems).toEqual([expect.objectContaining({
      id: "room-live-memory-1",
      memoryId: "m-promoted",
    })]);
  });

  it("room-memory: writeback is idempotent and survives missing items", async () => {
    const at = "2026-09-03T10:00:00.000Z";
    const { worker, db } = await harness({
      memories: [
        memory("m-1", at, "room-memory:room-live:item-gone"),
        memory("m-2", at, "room-memory:room-old:item-old"),
      ],
    });

    await worker.drain();

    // 条目不存在（room-live 无该条目）或 Room 已合并（room-old → resolveRoom 指向
    // room-new 但条目在 room-old 行上）：归属仍落，回写跳过不报错。
    const rows = db.select().from(roomMemoryAttributions).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.memoryId === "m-1")?.roomId).toBe("room-live");
    expect(rows.find((row) => row.memoryId === "m-2")?.roomId).toBe("room-new");
  });
});
