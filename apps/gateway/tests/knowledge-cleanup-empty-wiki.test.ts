import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { jobs, routeDecisions, rooms, roomSourceMemberships, roomWikis } from "../src/infrastructure/database/schema.js";
import { KsAdminClient, KsClientError } from "../src/modules/knowledge/ks-client.js";
import { KnowledgeService, type KnowledgeServiceConfig } from "../src/modules/knowledge/service.js";

const temporaryDirectories: string[] = [];

/** 复现线上故障的替身 KS：rawRm 后源删尽，ingest 抛 KS 400 no source files。 */
class EmptyAfterRmKs extends KsAdminClient {
  rawRmCalls: string[][] = [];
  ingestCalls = 0;

  constructor() {
    super({ baseUrl: "http://127.0.0.1:1", serviceId: "everroom", teamId: "everroom" });
  }

  override async rawRm(_wikiId: string, filenames: string[]): Promise<void> {
    this.rawRmCalls.push(filenames);
  }

  override async ingest(_wikiId: string): Promise<void> {
    this.ingestCalls += 1;
    throw new KsClientError(
      `Knowledge service /v3/wiki/ingest failed: HTTP 400 ({"message":"wiki has no source files, upload before ingest"})`,
      400,
    );
  }
}

const noLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function createHarness(ks: KsAdminClient) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-knowledge-cleanup-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const config: KnowledgeServiceConfig = {
    baseUrl: "http://127.0.0.1:1",
    serviceId: "everroom",
    teamId: "everroom",
    dataDir,
    roomWikisEnabled: true,
    ingestDebounceMs: 600_000,
    routerEnabled: false,
    entityPromoteScore: 2.4,
    entityPromoteSources: 3,
    mergeAutoDice: 0.75,
    mergeJudgeDice: 0.6,
    llm: null,
    embeddingLlm: null,
    embeddingModel: "",
  };
  const knowledge = new KnowledgeService(db, config, noLogger, undefined, { ksClient: ks });
  return { db, sqlite, knowledge };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("knowledge cleanup job：源删尽后的降级与决策回退", () => {
  it("rawRm 成功但 KS ingest 400（no source files）：job 完成、决策 reverted、membership 已清", async () => {
    const ks = new EmptyAfterRmKs();
    const { db, sqlite, knowledge } = await createHarness(ks);
    try {
      const roomId = "room-cleanup-1";
      db.insert(rooms).values([{
        id: roomId, title: "资料", kind: "主题",
        lifecycle: "active", deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      }]).run();
      db.insert(roomWikis).values([{
        roomId, knowledgeId: "wiki-x", status: "active", centroidDocs: 0,
        createdAt: new Date(),
      }]).run();
      db.insert(routeDecisions).values([{
        id: "decision-1",
        sourceKind: "everroom-doc",
        sourceId: "doc-cleanup-1",
        sourceVersion: 1,
        sourceTitle: "工作计划",
        status: "confirmed",
        primaryRoomId: roomId,
        confidence: 0.9,
        decidedBy: "user",
        evidence: {
          filename: "everroom-doc-doc-cleanup-1__a.md",
          knowledgeId: "wiki-x",
          rooms: [{ roomId, knowledgeId: "wiki-x", filename: "everroom-doc-doc-cleanup-1__a.md" }],
        },
        linkedRoomIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }]).run();
      db.insert(roomSourceMemberships).values([{
        id: "membership-1", roomId, sourceKind: "everroom-doc", sourceId: "doc-cleanup-1",
        sourceVersion: 1, evidenceGroupKey: "g", role: "primary", effectiveWeight: 1,
        qualityLevel: "normal", trusted: true, scoringVersion: 1, entityIndexed: true,
        createdAt: new Date(), updatedAt: new Date(),
      }]).run();

      knowledge.requestSourceCleanup("everroom-doc", "doc-cleanup-1");
      // wake() 启动 drain 循环并立即认领 job；轮询等它终态
      await vi.waitFor(() => {
        const job = db.select().from(jobs).all().find((row) => row.type === "knowledge.cleanup");
        expect(job).toBeTruthy();
        expect(["completed", "failed"]).toContain(job!.status);
      });
      const job = db.select().from(jobs).all().find((row) => row.type === "knowledge.cleanup");

      // 源已从 KS 删除
      expect(ks.rawRmCalls).toEqual([["everroom-doc-doc-cleanup-1__a.md"]]);
      // job 不因 KS 400 失败：状态 completed
      expect(job?.status).toBe("completed");
      // 决策 reverted（启动 rebuildFromFacts 不会复活 membership）
      const decision = db.select().from(routeDecisions).where(eq(routeDecisions.id, "decision-1")).get();
      expect(decision?.status).toBe("reverted");
      // 投影已清
      expect(db.select().from(roomSourceMemberships).all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
