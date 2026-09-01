import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  agentRuns,
  agentSessions,
  documentOperations,
  documentVersions,
  documents,
  roomDocumentLinks,
} from "../src/infrastructure/database/schema.js";
import { WritingStyleService } from "../src/modules/writing-style/service.js";
import { classifyInstruction } from "../src/modules/writing-style/signals.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

async function setup(): Promise<{ database: DatabaseClient; service: WritingStyleService }> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-writing-style-signals-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return { database, service: new WritingStyleService(database.db) };
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.sqlite.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

function paragraph(text: string): unknown {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function seedDocument(database: DatabaseClient, id: string): void {
  const now = new Date();
  database.db.insert(documents).values({
    id, title: id,
    contentJson: { type: "doc", content: [paragraph("占位正文。")] },
    contentSchemaVersion: 3, version: 1, status: "active", createdAt: now, updatedAt: now,
  }).run();
  database.db.insert(roomDocumentLinks).values({ roomId: "room-1", documentId: id, linkedAt: now }).run();
}

function seedOperation(
  database: DatabaseClient,
  input: { id: string; capabilityId: string; documentId: string | null; status: "completed" | "rejected"; operationInput: Record<string, unknown>; runPrompt?: string },
): void {
  const now = new Date();
  const sessionId = `session-${input.id}`;
  const runId = `run-${input.id}`;
  database.db.insert(agentSessions).values({
    id: sessionId, pageLabel: "Agent", runtimeId: "pi:main",
    createdAt: now, updatedAt: now,
  }).run();
  database.db.insert(agentRuns).values({
    id: runId, sessionId, agentId: "main", idempotencyKey: `idem-${input.id}`,
    prompt: input.runPrompt ?? "改一下", status: "completed", lastEventSeq: 0, createdAt: now,
  }).run();
  database.db.insert(documentOperations).values({
    id: input.id,
    capabilityId: input.capabilityId,
    capabilityVersion: 1,
    interactionMode: "preview_replace",
    presenterKey: "document",
    roomId: "room-1",
    documentId: input.documentId,
    documentTitle: input.documentId ?? "文档",
    agentSessionId: sessionId,
    runId,
    status: input.status,
    input: input.operationInput,
    summary: "测试操作",
    createdAt: now,
    updatedAt: now,
  }).run();
}

function seedVersion(
  database: DatabaseClient,
  documentId: string,
  version: number,
  text: string,
  sourceTransactionId: string | null,
): void {
  database.db.insert(documentVersions).values({
    id: `${documentId}-v${version}`,
    documentId,
    version,
    title: documentId,
    contentJson: { type: "doc", content: [paragraph(text)] } as never,
    contentSchemaVersion: 3,
    sourceTransactionId,
    createdAt: new Date(Date.now() + version * 1_000),
  }).run();
}

describe("classifyInstruction 表驱动归类", () => {
  it("常见意图命中对应类目，未命中返回 null", () => {
    expect(classifyInstruction("写得太啰嗦了，精简一点")).toBe("concise");
    expect(classifyInstruction("改成口语化一些")).toBe("casual");
    expect(classifyInstruction("分点列出要点")).toBe("structured");
    expect(classifyInstruction("帮我把这段润色")).toBeNull();
  });
});

describe("scanSignals 三类回溯", () => {
  it("划词改写 instruction → rewrite_instruction 并归类", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1");
    seedOperation(database, {
      id: "op-rw-1",
      capabilityId: "document.selection-rewrite",
      documentId: "doc-1",
      status: "completed",
      operationInput: { instruction: "写得太啰嗦了，精简一点", originalText: "原文", replacementText: "改后" },
    });
    // rejected 的不计入。
    seedOperation(database, {
      id: "op-rw-2",
      capabilityId: "document.selection-rewrite",
      documentId: "doc-1",
      status: "rejected",
      operationInput: { instruction: "更正式一些" },
    });

    const inserted = service.scanSignals();
    expect(inserted).toBe(1);
    const behavior = service.aggregateSignals();
    expect(behavior.instructionCounts).toContainEqual({ label: "更简洁", count: 1 });
    expect(behavior.recentInstructions[0]).toContain("精简");
    // 幂等：再扫不重复。
    expect(service.scanSignals()).toBe(0);
  });

  it("document.edit 的 operation 反查 run prompt → edit_instruction", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1");
    seedOperation(database, {
      id: "op-edit-1",
      capabilityId: "document.edit",
      documentId: "doc-1",
      status: "completed",
      operationInput: { hunks: [] },
      runPrompt: "把第二节改得更口语化一些，自然一点",
    });

    expect(service.scanSignals()).toBe(1);
    const behavior = service.aggregateSignals();
    expect(behavior.instructionCounts).toContainEqual({ label: "更口语", count: 1 });
    expect(behavior.recentInstructions[0]).toContain("口语化");
  });

  it("agent 版本 → 用户版本的配对 → revision_delta（方向统计）", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1");
    seedVersion(database, "doc-1", 1, "用户写的第一版。", null);
    seedVersion(database, "doc-1", 2, "Agent 生成了一个非常漫长的版本！这里的每个句子都写得格外啰嗦而冗长！还带着好几个感叹号！", "op-agent-1");
    seedVersion(database, "doc-1", 3, "用户改短了。删掉感叹号。只留必要信息，语气平静。句子明显更收敛克制，不再铺陈展开更多内容。", null);

    expect(service.scanSignals()).toBe(1);
    const behavior = service.aggregateSignals();
    expect(behavior.revisionCount).toBe(1);
    expect(behavior.averageLenDeltaRatio).toBeLessThan(0);
    expect(behavior.revisionSamples[0]?.before).toContain("Agent");
    expect(behavior.revisionSamples[0]?.after).toContain("用户改短");
  });

  it("连续 agent 版本取最后一个与首个用户版本配对", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1");
    seedVersion(database, "doc-1", 1, "用户初始版。", null);
    seedVersion(database, "doc-1", 2, "Agent 第一稿的内容，写了一些展开的细节描述，还有若干补充说明的句子来撑长篇幅。", "op-1");
    seedVersion(database, "doc-1", 3, "Agent 第二稿的更多内容，继续补充了不少细节，篇幅进一步扩展变长，加入更多铺陈。", "op-2");
    seedVersion(database, "doc-1", 4, "用户最终手改的版本，收敛为一个精炼的说法，砍掉了大部分展开描述与客套铺垫内容。", null);

    expect(service.scanSignals()).toBe(1);
    const behavior = service.aggregateSignals();
    expect(behavior.revisionCount).toBe(1);
    expect(behavior.revisionSamples[0]?.before).toContain("第二稿");
  });
});

describe("行为信号进画像", () => {
  it("refresh 后画像文本含行为偏好段（无 LLM 也可用）", async () => {
    const { database, service } = await setup();
    seedDocument(database, "doc-1");
    seedOperation(database, {
      id: "op-rw-1",
      capabilityId: "document.selection-rewrite",
      documentId: "doc-1",
      status: "completed",
      operationInput: { instruction: "精简一点，太啰嗦" },
    });
    await service.refreshProfile();
    const text = service.getProfileText();
    expect(text.content).toContain("行为偏好");
    expect(text.content).toContain("更简洁");
    expect(text.content).toContain("精简一点");
    // profile DTO 的 behavior 摘要可用。
    expect(service.getProfile().behavior.instructionCounts).toContainEqual({ label: "更简洁", count: 1 });
  });

  it("只有行为信号、无文档语料时也生成画像文本", async () => {
    const { database, service } = await setup();
    seedOperation(database, {
      id: "op-rw-1",
      capabilityId: "document.selection-rewrite",
      documentId: null,
      status: "completed",
      operationInput: { instruction: "更正式一点" },
    });
    await service.refreshProfile();
    expect(service.getProfileText().content).toContain("更正式");
  });

  it("接管后新行为信号触发 systemUpdateAvailable 提示", async () => {
    const { database, service } = await setup();
    seedOperation(database, {
      id: "op-rw-1",
      capabilityId: "document.selection-rewrite",
      documentId: null,
      status: "completed",
      operationInput: { instruction: "更正式一点" },
    });
    await service.refreshProfile();
    service.replaceUserContent("我的接管版本。");
    expect(service.getProfileText().systemUpdateAvailable).toBe(false);

    // 新增行为信号（cursor 变化）→ 接管态下出现"有新沉淀"提示。
    seedOperation(database, {
      id: "op-rw-2",
      capabilityId: "document.selection-rewrite",
      documentId: null,
      status: "completed",
      operationInput: { instruction: "再简洁一些" },
    });
    await service.refreshProfile();
    expect(service.getProfileText().systemUpdateAvailable).toBe(true);
    expect(service.getProfileText().content).toBe("我的接管版本。");
  });
});
