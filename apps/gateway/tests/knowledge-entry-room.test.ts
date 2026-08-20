import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Windows：sqlite -shm 释放有延迟，EBUSY 时让 fs.rm 自带的重试兜底
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/**
 * 真实 sqlite（临时目录）+ 不可达 KS 的服务实例；不 start()——submitEnvelope
 * 的 wake() 在未 start 时也会 drain route job（路由是纯 DB 操作，KS 只在
 * ingest job 才触达，execute→ingest 会重试但不阻塞路由断言）。
 */
async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-entry-room-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new KnowledgeService(
    db,
    {
      baseUrl: "http://127.0.0.1:9", // 不可达即可：ingest job 会失败重试，不影响路由落库
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
      llm: null, // 无 LLM：瀑布非入口路径确定落 awaiting_review，断言稳定
      embeddingLlm: null,
      embeddingModel: "",
    },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  return {
    service,
    sqlite,
    rows: <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/** 轮询直到断言通过或超时（路由 job 异步 drain，毫秒级窗口）。 */
async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => T | null,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

describe("Room 内上传的入口直达路由（entryRoomId → ①-bis）", () => {
  it("带 roomId 的 file 源：决策 primaryRoomId=该 Room、decidedBy=entry、快照落库", async () => {
    const test = await serviceForTest();
    test.service.upsertRoom({ id: "room-x", title: "项目X" });

    test.service.submitEnvelope({
      sourceKind: "file",
      sourceId: "file-entry-1",
      sourceVersion: 1,
      title: "项目X资料",
      markdown: "# 项目X资料\n\n正文",
      entryRoomId: "room-x",
    });

    const decision = await until("entry route decision", 5_000, () =>
      test.rows<{
        primary_room_id: string | null;
        decided_by: string | null;
        confidence: number;
        status: string;
        source_markdown: string | null;
        reason: string;
      }>(
        "SELECT * FROM route_decisions WHERE source_kind = 'file' AND source_id = 'file-entry-1'",
      )[0] ?? null,
    );
    expect(decision.primary_room_id).toBe("room-x");
    expect(decision.decided_by).toBe("entry");
    expect(decision.confidence).toBe(1);
    expect(decision.status).toBe("auto");
    expect(decision.source_markdown).toContain("项目X资料");
    expect(decision.reason).toContain("入口确定性");

    // 云文档清单（listRoomFiles 的 a 源 = primaryRoomId）能看到该文件
    // （uploaded_files 无行：清单 join 落空属预期——归属指针已正确落库）
    test.sqlite.close();
  });

  it("Room 已删：忽略 entryRoomId 落瀑布（无 LLM → awaiting_review）", async () => {
    const test = await serviceForTest();
    test.service.upsertRoom({ id: "room-dead", title: "已删房" });
    test.sqlite.prepare("UPDATE rooms SET deleted_at = 1 WHERE id = 'room-dead'").run();

    test.service.submitEnvelope({
      sourceKind: "file",
      sourceId: "file-entry-2",
      sourceVersion: 1,
      title: "孤儿资料",
      markdown: "# 孤儿资料",
      entryRoomId: "room-dead",
    });

    const decision = await until("waterfall decision", 5_000, () =>
      test.rows<{ primary_room_id: string | null; decided_by: string | null; status: string }>(
        "SELECT * FROM route_decisions WHERE source_kind = 'file' AND source_id = 'file-entry-2'",
      )[0] ?? null,
    );
    expect(decision.primary_room_id).toBeNull();
    expect(decision.decided_by).toBeNull();
    expect(decision.status).toBe("awaiting_review");

    expect(test.service.listRoomFiles("room-dead")).toHaveLength(0);
    test.sqlite.close();
  });

  it("不带 entryRoomId：行为不变（awaiting_review，回归）", async () => {
    const test = await serviceForTest();
    test.service.upsertRoom({ id: "room-y", title: "项目Y" });

    test.service.submitEnvelope({
      sourceKind: "file",
      sourceId: "file-plain",
      sourceVersion: 1,
      title: "普通上传",
      markdown: "# 普通上传",
    });

    const decision = await until("plain decision", 5_000, () =>
      test.rows<{ primary_room_id: string | null; decided_by: string | null; status: string }>(
        "SELECT * FROM route_decisions WHERE source_kind = 'file' AND source_id = 'file-plain'",
      )[0] ?? null,
    );
    expect(decision.primary_room_id).toBeNull();
    expect(decision.decided_by).toBeNull();
    expect(decision.status).toBe("awaiting_review");
    test.sqlite.close();
  });
});
