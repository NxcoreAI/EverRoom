import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentService } from "../src/modules/documents/service.js";
import { DocumentOperationService } from "../src/modules/documents/operations/service.js";
import { createBuiltinDocumentCapabilityRegistry } from "../src/modules/documents/capabilities/builtins.js";

// 补挂索引（draft-edit"仅追加 blockIndexMark"）走 patch 链路的回归：
// 此前 comparableBlock 不感知零文本的 blockIndexMark，mark-only 替换被
// 误判 EDIT_NO_CHANGE，agent 反复重试全部失败（2026-09-04 真机日志实锤）。

const temporaryDirectories: string[] = [];
const closables: Array<() => void> = [];

async function createHarness(
  resolveRoomMemoryItems?: (roomId: string) => Array<{ id: string; content: string; type: string }>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-index-mark-patch-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  closables.push(() => database.sqlite.close());
  const broker = new DocumentEventBroker();
  const documents = new DocumentService(database.db, broker);
  const operations = new DocumentOperationService(database.db, broker);
  const registry = createBuiltinDocumentCapabilityRegistry(
    documents, undefined, operations, undefined, resolveRoomMemoryItems,
  );
  return { documents, operations, registry };
}

const SOURCE_TEXT = "PyTorch 提供动态计算图、自动求导与张量系统，采用 Python 优先的设计哲学，"
  + "兼顾易用性与性能，是学术界与工业界的主流深度学习框架之一，社区生态与工具链完善。";

afterEach(async () => {
  for (const close of closables.splice(0)) close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("patch hunk block index marks", () => {
  it("仅追加索引标记的替换被 patch_commit 自动应用，落库保留标记", async () => {
    const { documents, operations, registry } = await createHarness();
    const source = await documents.import({
      id: "doc-source",
      roomId: "room-1",
      title: "来源文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] }] },
    });
    const target = await documents.import({
      id: "doc-target",
      roomId: "room-1",
      title: "目标文档",
      contentJson: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] },
        { type: "paragraph", content: [{ type: "text", text: "另一段与本来源无关的内容，长度补齐避免其他校验。" }] },
      ] },
    });
    const sourceBlockId = documents.listBlocks(source.id)[0]!.blockId;
    const targetBlockId = documents.listBlocks(target.id)[0]!.blockId;
    const context = { agentSessionId: "session-mark", runId: "run-mark", roomId: "room-1" };
    await registry.execute("context_room_document_read", { documentId: target.id }, context);
    const begun = await registry.execute("context_room_patch_begin", {
      documentId: target.id,
      baseVersion: target.version,
      kind: "edit",
      summary: "为段落追加来源索引标记",
    }, context);
    const operationId = String(begun.structuredContent.operationId);
    await registry.execute("context_room_patch_hunk", {
      operationId,
      sequence: 1,
      operation: "replace",
      target: { blockId: targetBlockId },
      markdown: `${SOURCE_TEXT}^[来源文档](everroom://room/room-1/${source.id}/${sourceBlockId})`,
    }, context);
    const storedItem = operations.get(operationId)!.items[0]!;
    expect(JSON.stringify(storedItem.after)).toContain("blockIndexMark");
    const committed = await registry.execute("context_room_patch_commit", { operationId, finalSequence: 1 }, context);
    // 正文零改动、仅段末追加索引标记的提案由 patch_commit 直接自动应用。
    expect(committed.structuredContent).toMatchObject({ state: "completed", applied: true, documentChanged: true });
    expect(operations.get(operationId)!.status).toBe("completed");

    const updated = documents.get(target.id)!;
    expect(updated.version).toBe(target.version + 1);
    const firstParagraph = updated.contentJson.content?.[0];
    expect(firstParagraph?.type).toBe("paragraph");
    const mark = firstParagraph?.content?.find((node) => node.type === "blockIndexMark");
    expect(mark?.attrs).toMatchObject({
      kind: "document",
      targetDocumentId: source.id,
      targetBlockId: sourceBlockId,
    });
    expect(updated.contentJson.content?.[1]?.type).toBe("paragraph");
  });

  it("正文有改动的提案不被自动应用，保持 awaiting_review 由用户接受", async () => {
    const { documents, operations, registry } = await createHarness();
    const source = await documents.import({
      id: "doc-source",
      roomId: "room-1",
      title: "来源文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] }] },
    });
    const target = await documents.import({
      id: "doc-target",
      roomId: "room-1",
      title: "目标文档",
      contentJson: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] },
      ] },
    });
    const sourceBlockId = documents.listBlocks(source.id)[0]!.blockId;
    const targetBlockId = documents.listBlocks(target.id)[0]!.blockId;
    const context = { agentSessionId: "session-mark-3", runId: "run-mark-3", roomId: "room-1" };
    await registry.execute("context_room_document_read", { documentId: target.id }, context);
    const begun = await registry.execute("context_room_patch_begin", {
      documentId: target.id,
      baseVersion: target.version,
      kind: "edit",
      summary: "改写正文并附来源索引标记",
    }, context);
    const operationId = String(begun.structuredContent.operationId);
    await registry.execute("context_room_patch_hunk", {
      operationId,
      sequence: 1,
      operation: "replace",
      target: { blockId: targetBlockId },
      markdown: `PyTorch 是主流深度学习框架，以动态图与自动求导著称。^[来源文档](everroom://room/room-1/${source.id}/${sourceBlockId})`,
    }, context);
    const storedItem = operations.get(operationId)!.items[0]!;
    const committed = await registry.execute("context_room_patch_commit", { operationId, finalSequence: 1 }, context);
    expect(committed.structuredContent).toMatchObject({ state: "awaiting_review" });
    expect(documents.get(target.id)!.version).toBe(target.version);
    // 用户在 UI 点接受后走 review.apply 真正写入。
    const awaiting = operations.get(operationId)!;
    await operations.execute(operationId, {
      commandId: `${operationId}:apply`,
      expectedRevision: awaiting.revision,
      type: "review.apply",
      payload: { acceptedItemIds: [storedItem.id] },
    }, (operation, command) => registry.command(operation, command));
    const updated = documents.get(target.id)!;
    expect(updated.version).toBe(target.version + 1);
    expect(JSON.stringify(updated.contentJson)).toContain("blockIndexMark");
    expect(operations.get(operationId)!.status).toBe("completed");
  });

  it("指向不存在块的索引标记被拒绝（截短/伪造 id 可重试报错）", async () => {
    const { documents, registry } = await createHarness();
    const source = await documents.import({
      id: "doc-source",
      roomId: "room-1",
      title: "来源文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] }] },
    });
    const target = await documents.import({
      id: "doc-target",
      roomId: "room-1",
      title: "目标文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] }] },
    });
    const targetBlockId = documents.listBlocks(target.id)[0]!.blockId;
    const sourceBlockId = documents.listBlocks(source.id)[0]!.blockId;
    const context = { agentSessionId: "session-mark-2", runId: "run-mark-2", roomId: "room-1" };
    await registry.execute("context_room_document_read", { documentId: target.id }, context);
    const begun = await registry.execute("context_room_patch_begin", {
      documentId: target.id,
      baseVersion: target.version,
      kind: "edit",
      summary: "为段落追加来源索引标记",
    }, context);
    const operationId = String(begun.structuredContent.operationId);
    await expect(registry.execute("context_room_patch_hunk", {
      operationId,
      sequence: 1,
      operation: "replace",
      target: { blockId: targetBlockId },
      markdown: `${SOURCE_TEXT}^[来源文档](everroom://room/room-1/${source.id}/458ec0fa)`,
    }, context)).rejects.toMatchObject({
      code: "INDEX_MARK_TARGET_NOT_FOUND",
      statusCode: 409,
      details: {
        retryable: true,
        invalidTargets: [{ documentId: source.id, blockId: "458ec0fa" }],
        // 自纠提示：随错误回传出问题文档的当前块清单，调用方不重读也能换用合法 id。
        availableTargets: [{
          documentId: source.id,
          blockCount: 1,
          truncated: false,
          blocks: [{ blockId: sourceBlockId, textPreview: expect.stringContaining("PyTorch") }],
        }],
      },
    });
    // 目标文档不存在同样拒绝。
    await expect(registry.execute("context_room_patch_hunk", {
      operationId,
      sequence: 1,
      operation: "replace",
      target: { blockId: targetBlockId },
      markdown: `${SOURCE_TEXT}^[来源文档](everroom://room/room-1/doc-missing/some-block)`,
    }, context)).rejects.toMatchObject({ code: "INDEX_MARK_TARGET_NOT_FOUND" });
    expect(JSON.stringify(documents.get(target.id)!.contentJson)).not.toContain("blockIndexMark");
  });

  it("patch_begin 注入 Room 归属记忆清单，直写模式有 memoryId 可抄", async () => {
    const { documents, operations, registry } = await createHarness((roomId) => roomId === "room-1"
      ? [
        { id: "mem-1", content: "EverRoom 的文档块索引用 ^[短标题](everroom://...) 挂在段末。".repeat(3), type: "事实" },
        { id: "mem-2", content: "第二条记忆", type: "" },
      ]
      : []);
    const target = await documents.import({
      id: "doc-target",
      roomId: "room-1",
      title: "目标文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] }] },
    });
    const context = { agentSessionId: "session-memory", runId: "run-memory", roomId: "room-1" };
    await registry.execute("context_room_document_read", { documentId: target.id }, context);
    const begun = await registry.execute("context_room_patch_begin", {
      documentId: target.id,
      baseVersion: target.version,
      kind: "edit",
      summary: "补挂记忆索引标记",
    }, context);
    const memoryIndex = begun.structuredContent.memoryIndex as Array<Record<string, unknown>>;
    expect(memoryIndex).toHaveLength(2);
    expect(memoryIndex[0]).toMatchObject({ memoryId: "mem-1", type: "事实" });
    expect(String(memoryIndex[0]!.contentPreview).length).toBeLessThanOrEqual(200);
    expect(memoryIndex[1]).toEqual({ memoryId: "mem-2", contentPreview: "第二条记忆" });

    // 凭 memoryIndex 抄来的 memoryId 挂记忆标记可入提案（正文有改动 → 待审阅，
    // 用户接受后落库；memory 标记不做存在性拦截）。
    const targetBlockId = documents.listBlocks(target.id)[0]!.blockId;
    await registry.execute("context_room_patch_hunk", {
      operationId: String(begun.structuredContent.operationId),
      sequence: 1,
      operation: "replace",
      target: { blockId: targetBlockId },
      markdown: `PyTorch 以动态计算图与自动求导著称，是主流深度学习框架之一。^[事实](everroom://memory/room-1/mem-1)`,
    }, context);
    const storedItem = operations.get(String(begun.structuredContent.operationId))!.items[0]!;
    expect(JSON.stringify(storedItem.after)).toContain("blockIndexMark");
    const committed = await registry.execute("context_room_patch_commit", {
      operationId: String(begun.structuredContent.operationId),
      finalSequence: 1,
    }, context);
    expect(committed.structuredContent).toMatchObject({ state: "awaiting_review" });
    const awaiting = operations.get(String(begun.structuredContent.operationId))!;
    await operations.execute(String(begun.structuredContent.operationId), {
      commandId: `${begun.structuredContent.operationId}:apply`,
      expectedRevision: awaiting.revision,
      type: "review.apply",
      payload: { acceptedItemIds: [storedItem.id] },
    }, (operation, command) => registry.command(operation, command));
    const mark = documents.get(target.id)!.contentJson.content?.[0]?.content
      ?.find((node) => node.type === "blockIndexMark");
    expect(mark?.attrs).toMatchObject({ kind: "memory", targetMemoryId: "mem-1" });
  });

  it("未接记忆清单或清单为空时 patch_begin 不带 memoryIndex 字段", async () => {
    const bare = await createHarness();
    const target = await bare.documents.import({
      id: "doc-target",
      roomId: "room-1",
      title: "目标文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] }] },
    });
    const context = { agentSessionId: "session-bare", runId: "run-bare", roomId: "room-1" };
    await bare.registry.execute("context_room_document_read", { documentId: target.id }, context);
    const begun = await bare.registry.execute("context_room_patch_begin", {
      documentId: target.id,
      baseVersion: target.version,
      kind: "edit",
      summary: "无记忆清单",
    }, context);
    expect(begun.structuredContent.memoryIndex).toBeUndefined();

    const empty = await createHarness(() => []);
    const target2 = await empty.documents.import({
      id: "doc-target",
      roomId: "room-1",
      title: "目标文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: SOURCE_TEXT }] }] },
    });
    const context2 = { agentSessionId: "session-empty", runId: "run-empty", roomId: "room-1" };
    await empty.registry.execute("context_room_document_read", { documentId: target2.id }, context2);
    const begun2 = await empty.registry.execute("context_room_patch_begin", {
      documentId: target2.id,
      baseVersion: target2.version,
      kind: "edit",
      summary: "空记忆清单",
    }, context2);
    expect(begun2.structuredContent.memoryIndex).toBeUndefined();
  });
});
