import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  contextRooms,
  documents as documentsTable,
} from "../src/infrastructure/database/schema.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentService } from "../src/modules/documents/service.js";
import { DocumentServiceError } from "../src/modules/documents/errors.js";
import { IndexBackfillLlm, type VerifyEntry } from "../src/modules/documents/index-backfill/llm.js";
import {
  DocumentIndexBackfillWorker,
  type DocumentIndexBackfillDocuments,
} from "../src/modules/documents/index-backfill/worker.js";
import { DOCUMENT_INDEX_BACKFILL_JOB_TYPE } from "../src/modules/documents/index-backfill/jobs.js";
import { jobs } from "../src/infrastructure/database/schema.js";
import type { TiptapJsonContent } from "@nxcore/agent-contract";

const SOURCE_PARAGRAPH = "PyTorch 是一种基于 Torch 的开源深度学习框架，由 Meta AI 维护，"
  + "支持动态计算图、自动求导机制与张量系统，采用 Python 优先的设计哲学，"
  + "兼顾易用性与性能，是学术界与工业界的主流深度学习框架之一。";

const REWRITTEN_PARAGRAPH = "该框架以动态图与自动微分见长（改写版表述）：研究者可以在运行时构建计算图，"
  + "借助 autograd 完成梯度计算，张量运算与 Python 控制流无缝衔接，"
  + "这种 Define-by-Run 的设计让调试与模型迭代非常直观。";

const MEMORY_CONTENT = "团队约定：深度学习相关文档统一使用 PyTorch 作为示例框架，示例代码必须可独立运行，禁止引用过时的 Torch 风格 API。";

const temporaryDirectories: string[] = [];
const closables: Array<() => void> = [];

function body(paragraphs: string[]): TiptapJsonContent {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  };
}

/** 构造"段落已带索引标记"的存量形态（复检用例的输入）。 */
function bodyWithMarks(paragraphs: string[], marks: Array<Record<string, unknown>>): TiptapJsonContent {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [
        ...marks.map((attrs) => ({ type: "blockIndexMark", attrs })),
        { type: "text", text },
      ],
    })),
  };
}

async function createHarness(options: {
  quietWindowMs?: number;
  rescanMs?: number;
  listMemoryItems?: (roomId: string) => Array<{ id: string; content: string; type: string }>;
  listAllMemoryItems?: (roomId: string) => Array<{ id: string; content: string; type: string }>;
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-index-backfill-test-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  closables.push(() => database.sqlite.close());
  const broker = new DocumentEventBroker();
  const documents = new DocumentService(database.db, broker);
  database.db.insert(contextRooms).values({
    id: "room-1",
    title: "测试房间",
    data: {},
  }).run();

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const worker = new DocumentIndexBackfillWorker(
    database.db,
    documents,
    null,
    logger,
    {
      quietWindowMs: options.quietWindowMs ?? 0,
      scanIntervalMs: 1_000,
      pollIntervalMs: 60_000,
      retryBaseDelayMs: 0,
      ...(options.rescanMs === undefined ? {} : { rescanMs: options.rescanMs }),
      ...(options.listMemoryItems ? { listMemoryItems: options.listMemoryItems } : {}),
      ...(options.listAllMemoryItems ? { listAllMemoryItems: options.listAllMemoryItems } : {}),
    },
  );
  return { database, documents, worker, logger };
}

async function importDocument(
  documents: DocumentService,
  id: string,
  content: TiptapJsonContent,
): Promise<{ id: string; version: number }> {
  const document = await documents.import({
    id,
    roomId: "room-1",
    title: `文档 ${id}`,
    contentJson: content,
  });
  return { id: document.id, version: document.version };
}

/** 把文档 createdAt 回拨（方向启发式要求来源严格早于目标）。 */
function backdateCreation(db: ReturnType<typeof createDatabase>["db"], documentId: string, ms: number): void {
  db.update(documentsTable)
    .set({ createdAt: new Date(Date.now() - ms) })
    .where(eq(documentsTable.id, documentId))
    .run();
}

function findMarkNodes(content: TiptapJsonContent): Array<Record<string, unknown>> {
  const marks: Array<Record<string, unknown>> = [];
  const visit = (node: TiptapJsonContent) => {
    if (node.type === "blockIndexMark") marks.push(node.attrs as Record<string, unknown>);
    (node.content ?? []).forEach(visit);
  };
  (content.content ?? []).forEach(visit);
  return marks;
}

const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

afterEach(async () => {
  for (const close of closables.splice(0)) close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document index backfill worker", () => {
  it("为复述段落自动挂索引并收敛（不再重复写库）", async () => {
    const { database, documents, worker } = await createHarness();
    const source = await importDocument(documents, "doc-source", body([SOURCE_PARAGRAPH, "另一段内容，与本目标无关，长度补齐到下限以上避免误配。"]));
    const target = await importDocument(documents, "doc-target", body([SOURCE_PARAGRAPH]));
    backdateCreation(database.db, source.id, 60_000);

    await worker.drain();
    const targetDocument = documents.get(target.id)!;
    const marks = findMarkNodes(targetDocument.contentJson);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      kind: "document",
      targetRoomId: "room-1",
      targetDocumentId: source.id,
      fallbackTitle: "文档 doc-source",
    });
    expect(targetDocument.version).toBe(target.version + 1);
    // 来源文档自身不被回写。
    expect(findMarkNodes(documents.get(source.id)!.contentJson)).toHaveLength(0);

    // 自触发收敛：自己的保存会 bump updatedAt 触发重扫；重扫零新增不写库。
    await wait(1_100);
    await worker.drain();
    expect(documents.get(target.id)!.version).toBe(target.version + 1);
    const pending = database.db.select().from(jobs).where(eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE)).all()
      .filter((job) => job.status === "pending" || job.status === "running");
    expect(pending).toHaveLength(0);
  });

  it("确定性未命中的改写段落由 LLM 兜底挂标；LLM 抛错时确定性结果照常落库", async () => {
    const { database, documents, worker } = await createHarness();
    const source = await importDocument(documents, "doc-source", body([SOURCE_PARAGRAPH, "无关段落，长度补齐到下限以上避免误配。"]));
    const target = await importDocument(documents, "doc-target", body([SOURCE_PARAGRAPH, REWRITTEN_PARAGRAPH]));
    backdateCreation(database.db, source.id, 60_000);

    const judge = vi.fn(async () => [{ paragraphOrdinal: 1, sourceId: "doc:stub-block", confidence: 0.95 }]);
    const llmWorker = new DocumentIndexBackfillWorker(
      database.db,
      documents,
      { available: true, judge } as unknown as IndexBackfillLlm,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { quietWindowMs: 0, scanIntervalMs: 1_000, pollIntervalMs: 60_000, retryBaseDelayMs: 0 },
    );

    // 先跑确定性：LLM 桩的 blockId 不在白名单会被丢弃，只剩确定性命中。
    await llmWorker.drain();
    const deterministicOnly = findMarkNodes(documents.get(target.id)!.contentJson);
    expect(deterministicOnly).toHaveLength(1);

    // LLM 抛错：剩余改写段不挂，job 正常完成，已落的确定性结果不动。
    const throwing = new DocumentIndexBackfillWorker(
      database.db,
      documents,
      { available: true, judge: vi.fn(async () => { throw new Error("llm down"); }) } as unknown as IndexBackfillLlm,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { quietWindowMs: 0, scanIntervalMs: 1_000, pollIntervalMs: 60_000, retryBaseDelayMs: 0 },
    );
    await wait(1_100);
    await throwing.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(1);
    expect(worker).toBeDefined();
  });

  it("安静窗内的文档不入队；占用租约的文档处理时跳过", async () => {
    const quiet = await createHarness({ quietWindowMs: 300_000 });
    await importDocument(quiet.documents, "doc-fresh", body([SOURCE_PARAGRAPH]));
    await quiet.worker.drain();
    const enqueued = quiet.database.db.select().from(jobs)
      .where(eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE)).all();
    expect(enqueued).toHaveLength(0);

    const busy = await createHarness();
    const source = await importDocument(busy.documents, "doc-source", body([SOURCE_PARAGRAPH]));
    const target = await importDocument(busy.documents, "doc-target", body([SOURCE_PARAGRAPH]));
    backdateCreation(busy.database.db, source.id, 60_000);
    busy.database.db.update(documentsTable)
      .set({ activeTransactionId: "op-busy" })
      .where(eq(documentsTable.id, target.id))
      .run();
    await busy.worker.drain();
    const targetAfter = busy.documents.get(target.id)!;
    expect(findMarkNodes(targetAfter.contentJson)).toHaveLength(0);
    const jobRow = busy.database.db.select().from(jobs)
      .where(eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE)).all();
    expect(jobRow.every((job) => job.status === "completed")).toBe(true);
  });

  it("save 冲突时重读重放直至成功", async () => {
    const { database, documents, worker } = await createHarness();
    const source = await importDocument(documents, "doc-source", body([SOURCE_PARAGRAPH]));
    const target = await importDocument(documents, "doc-target", body([SOURCE_PARAGRAPH]));
    backdateCreation(database.db, source.id, 60_000);

    const realSave = documents.save.bind(documents);
    let conflictsLeft = 1;
    const flaky: DocumentIndexBackfillDocuments = {
      get: (id) => documents.get(id),
      list: (roomId) => documents.list(roomId),
      listBlocks: (id) => documents.listBlocks(id),
      save: async (id, input) => {
        if (conflictsLeft > 0) {
          conflictsLeft -= 1;
          throw new DocumentServiceError("DOCUMENT_CONFLICT", "simulated conflict", 409, { retryable: true });
        }
        return realSave(id, input);
      },
    };
    const flakyWorker = new DocumentIndexBackfillWorker(
      database.db,
      flaky,
      null,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { quietWindowMs: 0, scanIntervalMs: 60_000, pollIntervalMs: 60_000, retryBaseDelayMs: 0 },
    );
    await flakyWorker.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(1);
    expect(worker).toBeDefined();
  });

  it("逐字复述记忆项的段落由确定性匹配挂记忆索引", async () => {
    const { documents, worker, logger } = await createHarness({
      listMemoryItems: (roomId) => roomId === "room-1"
        ? [{ id: "room-1-memory-1", content: MEMORY_CONTENT, type: "事实" }]
        : [],
    });
    // 无来源文档，仅记忆候选；目标段落整句复述记忆内容。
    const target = await importDocument(documents, "doc-target", body([
      `${MEMORY_CONTENT}本文所有示例遵循该约定。`,
    ]));

    await worker.drain();
    const targetDocument = documents.get(target.id)!;
    const marks = findMarkNodes(targetDocument.contentJson);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      kind: "memory",
      targetRoomId: "room-1",
      targetDocumentId: "",
      targetBlockId: "",
      targetMemoryId: "room-1-memory-1",
      fallbackTitle: "事实",
    });
    expect(targetDocument.version).toBe(target.version + 1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "document.index-backfill.applied", memoryMarks: 1 }),
      expect.any(String),
    );
  });

  it("记忆项未被逐字复述时由 LLM 兜底；白名单外的 mem: id 被丢弃", async () => {
    const { database, documents } = await createHarness({
      listMemoryItems: () => [{ id: "room-1-memory-1", content: MEMORY_CONTENT, type: "事实" }],
    });
    const target = await importDocument(documents, "doc-target", body([REWRITTEN_PARAGRAPH]));

    // 判决落在白名单内的记忆 id → 挂记忆索引。
    const judge = vi.fn(async () => [
      { paragraphOrdinal: 0, sourceId: "mem:room-1-memory-1", confidence: 0.95 },
      { paragraphOrdinal: 0, sourceId: "mem:forged-memory", confidence: 0.99 },
    ]);
    const llmLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const llmWorker = new DocumentIndexBackfillWorker(
      database.db,
      documents,
      { available: true, judge } as unknown as IndexBackfillLlm,
      llmLogger,
      {
        quietWindowMs: 0,
        scanIntervalMs: 1_000,
        pollIntervalMs: 60_000,
        retryBaseDelayMs: 0,
        listMemoryItems: () => [{ id: "room-1-memory-1", content: MEMORY_CONTENT, type: "事实" }],
      },
    );
    await llmWorker.drain();
    const marks = findMarkNodes(documents.get(target.id)!.contentJson);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ kind: "memory", targetMemoryId: "room-1-memory-1" });
    // 判决输入里带上了记忆候选，llm 被调用且文档候选为空。
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({
      documents: [],
      memories: [expect.objectContaining({ memoryId: "room-1-memory-1" })],
    }));
  });

  it("未注入 listMemoryItems 时保持纯文档行为", async () => {
    const { documents, worker } = await createHarness();
    const target = await importDocument(documents, "doc-target", body([MEMORY_CONTENT]));
    await worker.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(0);
  });

  it("目标文档进废纸篓后标记被摘除；恢复后由补挂阶段自动补回", async () => {
    const { database, documents, worker } = await createHarness({ rescanMs: 0 });
    const source = await importDocument(documents, "doc-source", body([SOURCE_PARAGRAPH, "无关段落，长度补齐到下限以上避免误配。"]));
    const target = await importDocument(documents, "doc-target", body([SOURCE_PARAGRAPH]));
    backdateCreation(database.db, source.id, 60_000);

    await worker.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(1);
    const versionAfterAdd = documents.get(target.id)!.version;

    database.db.update(documentsTable)
      .set({ deletedAt: new Date() })
      .where(eq(documentsTable.id, source.id))
      .run();
    // 扫描节流（scanIntervalMs）需要流逝才会重新入队。
    await wait(1_100);
    await worker.drain();
    const afterTrash = documents.get(target.id)!;
    expect(findMarkNodes(afterTrash.contentJson)).toHaveLength(0);
    expect(afterTrash.version).toBe(versionAfterAdd + 1);

    // 恢复文档：containment 仍成立 → 补挂阶段自动补回（摘除可自愈）。
    database.db.update(documentsTable)
      .set({ deletedAt: null })
      .where(eq(documentsTable.id, source.id))
      .run();
    await wait(1_100);
    await worker.drain();
    const restored = documents.get(target.id)!;
    expect(findMarkNodes(restored.contentJson)).toHaveLength(1);
    expect(restored.version).toBe(versionAfterAdd + 2);
  });

  it("目标文档被彻底删除（purge）后标记被摘除", async () => {
    const { database, documents, worker } = await createHarness({ rescanMs: 0 });
    const source = await importDocument(documents, "doc-source", body([SOURCE_PARAGRAPH]));
    const target = await importDocument(documents, "doc-target", body([SOURCE_PARAGRAPH]));
    backdateCreation(database.db, source.id, 60_000);
    await worker.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(1);

    database.db.delete(documentsTable).where(eq(documentsTable.id, source.id)).run();
    await wait(1_100);
    await worker.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(0);
  });

  it("记忆项被删除后记忆索引被摘除", async () => {
    const items = [{ id: "room-1-memory-1", content: MEMORY_CONTENT, type: "事实" }];
    const { documents, worker } = await createHarness({ rescanMs: 0, listMemoryItems: () => items });
    const target = await importDocument(documents, "doc-target", body([
      `${MEMORY_CONTENT}本文所有示例遵循该约定。`,
    ]));
    await worker.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(1);

    items.length = 0;
    await wait(1_100);
    await worker.drain();
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(0);
  });

  it("快照条目（禁用 shadow/legacy id）经 listAllMemoryItems 并集保住已挂标记，且不产生新标记", async () => {
    const snapshotItems = [{ id: "room-1-memory-9", content: MEMORY_CONTENT, type: "事实" }];
    const { documents, worker } = await createHarness({
      rescanMs: 0,
      // 归属清单为空（条目已禁用解绑/legacy），存在性走快照并集。
      listMemoryItems: () => [],
      listAllMemoryItems: () => snapshotItems,
    });
    const marked = await importDocument(documents, "doc-marked", bodyWithMarks(
      [`${MEMORY_CONTENT}已挂标的复述段落。`],
      [{
        kind: "memory",
        targetRoomId: "room-1",
        targetDocumentId: "",
        targetBlockId: "",
        targetMemoryId: "room-1-memory-9",
        fallbackTitle: "事实",
        fallbackPreview: MEMORY_CONTENT.slice(0, 50),
      }],
    ));
    const quotable = await importDocument(documents, "doc-quotable", body([
      `${MEMORY_CONTENT}未挂标的复述段落。`,
    ]));
    await worker.drain();

    // 复检存在性命中最照条目 → 已挂标记不摘。
    expect(findMarkNodes(documents.get(marked.id)!.contentJson)).toHaveLength(1);
    // 候选生成只用归属清单（空）→ 不为快照条目补挂新标记。
    expect(findMarkNodes(documents.get(quotable.id)!.contentJson)).toHaveLength(0);
  });

  it("段落漂移经 LLM 复验确认失联后摘除；复验入参携带当前来源文本", async () => {
    const { database, documents } = await createHarness({ rescanMs: 0 });
    const source = await importDocument(documents, "doc-source", body([SOURCE_PARAGRAPH, "无关段落，长度补齐到下限以上。"]));
    backdateCreation(database.db, source.id, 60_000);
    const sourceBlock = documents.listBlocks(source.id)
      .find((block) => block.textPreview.includes("PyTorch"))!;
    // 手工构造"挂标后段落被改写"的存量形态：段落与双探针均不匹配（漂移候选）。
    const target = await importDocument(documents, "doc-target", bodyWithMarks([REWRITTEN_PARAGRAPH], [{
      kind: "document",
      targetRoomId: "room-1",
      targetDocumentId: source.id,
      targetBlockId: sourceBlock.blockId,
      targetMemoryId: "",
      fallbackTitle: "文档 doc-source",
      fallbackPreview: SOURCE_PARAGRAPH,
    }]));
    const versionBefore = documents.get(target.id)!.version;

    const verify = vi.fn(async (_entries: VerifyEntry[]) => [{ index: 0, stillDerived: false, confidence: 0.9 }]);
    const llmWorker = new DocumentIndexBackfillWorker(
      database.db,
      documents,
      { available: true, judge: vi.fn(), verify } as unknown as IndexBackfillLlm,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { quietWindowMs: 0, scanIntervalMs: 1_000, pollIntervalMs: 60_000, retryBaseDelayMs: 0, rescanMs: 0 },
    );
    await llmWorker.drain();
    const after = documents.get(target.id)!;
    expect(findMarkNodes(after.contentJson)).toHaveLength(0);
    expect(after.version).toBe(versionBefore + 1);
    // 复验入参：sourcePreview 用当前来源块文本（而非挂标时的 fallbackPreview）。
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![0]).toEqual([expect.objectContaining({
      index: 0,
      sourceKind: "document",
      sourceLabel: "文档 doc-source",
      sourcePreview: expect.stringContaining("PyTorch"),
    })]);
  });

  it("漂移候选经 LLM 复验仍源自时保留；LLM 未配置时同样保留", async () => {
    const { database, documents } = await createHarness({ rescanMs: 0 });
    const source = await importDocument(documents, "doc-source", body([SOURCE_PARAGRAPH]));
    backdateCreation(database.db, source.id, 60_000);
    const sourceBlock = documents.listBlocks(source.id)
      .find((block) => block.textPreview.includes("PyTorch"))!;
    const target = await importDocument(documents, "doc-target", bodyWithMarks([REWRITTEN_PARAGRAPH], [{
      kind: "document",
      targetRoomId: "room-1",
      targetDocumentId: source.id,
      targetBlockId: sourceBlock.blockId,
      targetMemoryId: "",
      fallbackTitle: "文档 doc-source",
      fallbackPreview: SOURCE_PARAGRAPH,
    }]));
    const versionBefore = documents.get(target.id)!.version;

    const keepWorker = new DocumentIndexBackfillWorker(
      database.db,
      documents,
      { available: true, judge: vi.fn(), verify: vi.fn(async () => [{ index: 0, stillDerived: true, confidence: 0.9 }]) } as unknown as IndexBackfillLlm,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { quietWindowMs: 0, scanIntervalMs: 1_000, pollIntervalMs: 60_000, retryBaseDelayMs: 0, rescanMs: 0 },
    );
    await keepWorker.drain();
    const kept = documents.get(target.id)!;
    expect(findMarkNodes(kept.contentJson)).toHaveLength(1);
    expect(kept.version).toBe(versionBefore);

    // LLM 未配置：漂移候选保留（宁留勿删），只有事实性失配才确定性摘除。
    const bareWorker = new DocumentIndexBackfillWorker(
      database.db,
      documents,
      null,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { quietWindowMs: 0, scanIntervalMs: 1_000, pollIntervalMs: 60_000, retryBaseDelayMs: 0, rescanMs: 0 },
    );
    await bareWorker.drain();
    expect(documents.get(target.id)!.version).toBe(versionBefore);
    expect(findMarkNodes(documents.get(target.id)!.contentJson)).toHaveLength(1);
  });

  it("rescanMs 到期后游标归零重走全量（复检覆盖宿主未动的文档）", async () => {
    const { database, documents, worker } = await createHarness({ rescanMs: 0 });
    await importDocument(documents, "doc-target", body(["独立段落，与任何来源无关，长度补齐到下限以上即可。"]));
    await worker.drain();
    const jobAfterFirst = database.db.select().from(jobs)
      .where(eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE)).all()
      .find((job) => (job.payload as { documentId: string }).documentId === "doc-target")!;
    expect(jobAfterFirst.status).toBe("completed");

    // rescanMs=0：距 sweep 开始 >= 0 即触发回绕 → 下次扫描重新入队同一文档。
    await wait(1_100);
    await worker.drain();
    const jobAfterSecond = database.db.select().from(jobs)
      .where(eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE)).all()
      .find((job) => (job.payload as { documentId: string }).documentId === "doc-target")!;
    expect(jobAfterSecond.status).toBe("completed");
    expect(new Date(jobAfterSecond.updatedAt).getTime())
      .toBeGreaterThan(new Date(jobAfterFirst.updatedAt).getTime());
  });
});
