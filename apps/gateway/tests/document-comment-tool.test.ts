import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DocumentEvent } from "@nxcore/agent-contract";
import { createBuiltinDocumentCapabilityRegistry } from "../src/modules/documents/capabilities/builtins.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentOperationService } from "../src/modules/documents/operations/service.js";
import { DocumentService } from "../src/modules/documents/service.js";
import { DocumentCommentService } from "../src/modules/documents/comments.js";
import type { DocumentCapabilityRegistry } from "../src/modules/documents/capabilities/registry.js";

const TOOL = "context_room_document_comment_add";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Harness {
  registry: DocumentCapabilityRegistry
  documents: DocumentService
  comments: DocumentCommentService
  events: DocumentEvent[]
}

async function createHarness(name: string, withComments = true): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), `nxcore-${name}-`));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const broker = new DocumentEventBroker();
  const documents = new DocumentService(database.db, broker);
  const operations = new DocumentOperationService(database.db, broker);
  const comments = new DocumentCommentService(database.db, (documentId) => Boolean(documents.get(documentId)));
  const events: DocumentEvent[] = [];
  const registry = createBuiltinDocumentCapabilityRegistry(
    documents,
    undefined,
    operations,
    undefined,
    undefined,
    withComments ? comments : undefined,
    (event) => events.push(event),
  );
  disposables.push(() => database.sqlite.close());
  return { registry, documents, comments, events };
}

const CONTENT = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { id: "blk-1" }, content: [{ type: "text", text: "Alpha 参考正文段落" }] },
    { type: "paragraph", content: [{ type: "text", text: "第二段没有块 id" }] },
  ],
} as never;

async function seedDocument(documents: DocumentService, id: string, roomId = "room-1") {
  return documents.import({ id, roomId, title: "审阅测试文档", contentJson: CONTENT });
}

function expectServiceError(promise: Promise<unknown> | unknown, code: string, details?: Record<string, unknown>) {
  return expect(promise).rejects.toMatchObject(
    details ? { code, details } : { code },
  );
}

describe("context_room_document_comment_add", () => {
  it("注册进 listTools 且 promptGuidelines 包含审阅工作流", async () => {
    const { registry } = await createHarness("comment-tool-register");
    expect(registry.listTools().map((tool) => tool.name)).toContain(TOOL);
    expect(registry.promptGuidelines().some((line) => line.includes(TOOL))).toBe(true);
  });

  it("逐字引用正文成功落库：AI 署名 + 锚定信息 + document.comments.changed 事件", async () => {
    const { registry, documents, comments, events } = await createHarness("comment-tool-happy");
    const document = await seedDocument(documents, "doc-tool-1");
    // 导入归一化会重新生成块 id，从落库内容里取真实 id。
    const firstBlock = document.contentJson.content?.[0]
    const blockId = ((firstBlock?.attrs ?? {}) as { id?: string }).id
    if (!blockId) throw new Error("seed document lost its block id");
    const result = await registry.execute(TOOL, {
      documentId: document.id,
      body: "这段缺少数据支撑，建议补充对比数据",
      blockId,
      quotedText: "Alpha 参考正文段落",
    }, { agentSessionId: "s1", runId: "run-happy", roomId: "room-1" });

    const comment = result.structuredContent.comment as { authorName: string; quotedText: string };
    expect(comment.authorName).toBe("AI 审阅");
    expect(comment.quotedText).toBe("Alpha 参考正文段落");
    expect((result.structuredContent as { anchored: boolean }).anchored).toBe(true);
    expect(comments.list(document.id)).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("document.comments.changed");
    expect(events[0]!.roomId).toBe("room-1");
    expect(events[0]!.documentId).toBe(document.id);
  });

  it("带 Markdown 标记的引用被拒（锚定校验），不落库", async () => {
    const { registry, documents, comments } = await createHarness("comment-tool-markdown");
    const document = await seedDocument(documents, "doc-tool-2");
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      body: "建议",
      quotedText: "**Alpha 参考正文段落**",
    }, { agentSessionId: "s2", runId: "run-md", roomId: "room-1" }), "COMMENT_QUOTE_NOT_FOUND", {
      retryable: true,
      nextAction: "context_room_document_read",
    });
    expect(comments.list(document.id)).toHaveLength(0);
  });

  it("不存在的 blockId 被拒", async () => {
    const { registry, documents } = await createHarness("comment-tool-block");
    const document = await seedDocument(documents, "doc-tool-3");
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      body: "建议",
      blockId: "blk-missing",
    }, { agentSessionId: "s3", runId: "run-block", roomId: "room-1" }), "BLOCK_NOT_FOUND");
  });

  it("回收站文档与跨房间文档被拒", async () => {
    const { registry, documents } = await createHarness("comment-tool-guard");
    const document = await seedDocument(documents, "doc-tool-4");
    await documents.delete(document.id);
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      body: "建议",
    }, { agentSessionId: "s4", runId: "run-trash", roomId: "room-1" }), "DOCUMENT_TRASHED");

    const other = await seedDocument(documents, "doc-tool-5");
    await expectServiceError(registry.execute(TOOL, {
      documentId: other.id,
      body: "建议",
    }, { agentSessionId: "s5", runId: "run-room", roomId: "room-other" }), "ROOM_MISMATCH");
  });

  it("单 run 评论数超限后拒绝；新 run 重新计数", async () => {
    const { registry, documents, comments } = await createHarness("comment-tool-cap");
    const document = await seedDocument(documents, "doc-tool-6");
    for (let index = 0; index < 8; index += 1) {
      await registry.execute(TOOL, {
        documentId: document.id,
        body: `第 ${index} 条建议`,
      }, { agentSessionId: "s6", runId: "run-cap", roomId: "room-1" });
    }
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      body: "第九条",
    }, { agentSessionId: "s6", runId: "run-cap", roomId: "room-1" }), "COMMENT_RUN_LIMIT", {
      retryable: false,
    });
    expect(comments.list(document.id)).toHaveLength(8);
    await registry.execute(TOOL, {
      documentId: document.id,
      body: "新 run 的建议",
    }, { agentSessionId: "s6", runId: "run-cap-next", roomId: "room-1" });
    expect(comments.list(document.id)).toHaveLength(9);
  });

  it("未注入评论服务时返回 COMMENT_SERVICE_UNAVAILABLE", async () => {
    const { registry, documents } = await createHarness("comment-tool-nosvc", false);
    const document = await seedDocument(documents, "doc-tool-7");
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      body: "建议",
    }, { agentSessionId: "s7", runId: "run-nosvc", roomId: "room-1" }), "COMMENT_SERVICE_UNAVAILABLE");
  });
});
