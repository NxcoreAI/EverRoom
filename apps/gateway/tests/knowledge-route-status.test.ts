import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/** 真实 sqlite（临时目录）：只测 routeStatusOf 的读取面，不 start()、不触 KS。 */
async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-route-status-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new KnowledgeService(
    db,
    {
      baseUrl: "http://127.0.0.1:9",
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
    },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  return { service, sqlite };
}

interface DecisionRow {
  id: string;
  sourceId: string;
  status: string;
  updatedAt: number;
}

function insertDecisionFactory(sqlite: Awaited<ReturnType<typeof serviceForTest>>["sqlite"]) {
  return (row: DecisionRow) => {
    sqlite.prepare(`
      INSERT INTO route_decisions (id, source_kind, source_id, source_version, source_title, confidence, status, created_at, updated_at)
      VALUES (?, 'file', ?, 1, ?, 0.8, ?, ?, ?)
    `).run(row.id, row.sourceId, `title-${row.id}`, row.status, row.updatedAt - 1, row.updatedAt);
  };
}

describe("KnowledgeService.routeStatusOf：任意状态按 sourceId 取最新决策", () => {
  it("每个 sourceId 只回最新一条（confirmed → awaiting_review 翻转后按新状态），未路由的缺席", async () => {
    const { service, sqlite } = await serviceForTest();
    const insertDecision = insertDecisionFactory(sqlite);
    const now = Date.now();
    insertDecision( { id: "d-a1", sourceId: "file-a", status: "confirmed", updatedAt: now - 5_000 });
    insertDecision({ id: "d-a2", sourceId: "file-a", status: "awaiting_review", updatedAt: now - 1_000 });
    insertDecision({ id: "d-b1", sourceId: "file-b", status: "auto", updatedAt: now - 500 });

    const items = service.routeStatusOf(["file-a", "file-b", "file-c"]);
    expect(items).toHaveLength(2);
    const bySource = new Map(items.map((item) => [item.sourceId, item]));
    expect(bySource.get("file-a")?.status).toBe("awaiting_review");
    expect(bySource.get("file-a")?.title).toBe("title-d-a2");
    expect(bySource.get("file-b")?.status).toBe("auto");
    expect(bySource.has("file-c")).toBe(false);
  });

  it("空列表与全部未命中都返回空数组", async () => {
    const { service } = await serviceForTest();
    expect(service.routeStatusOf([])).toEqual([]);
    expect(service.routeStatusOf(["file-none"])).toEqual([]);
  });
});
