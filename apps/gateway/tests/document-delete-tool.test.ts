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
import type { DocumentCapabilityRegistry } from "../src/modules/documents/capabilities/registry.js";

const TOOL = "context_room_document_delete";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Harness {
  registry: DocumentCapabilityRegistry
  documents: DocumentService
  events: DocumentEvent[]
}

async function createHarness(name: string): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), `nxcore-${name}-`));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const broker = new DocumentEventBroker();
  const documents = new DocumentService(database.db, broker);
  const operations = new DocumentOperationService(database.db, broker);
  const events: DocumentEvent[] = [];
  const registry = createBuiltinDocumentCapabilityRegistry(
    documents,
    undefined,
    operations,
    undefined,
    undefined,
    undefined,
    (event) => events.push(event),
  );
  disposables.push(() => database.sqlite.close());
  return { registry, documents, events };
}

const CONTENT = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { id: "blk-1" }, content: [{ type: "text", text: "待删除文档正文" }] },
  ],
} as never;

async function seedDocument(documents: DocumentService, id: string, roomId = "room-1") {
  return documents.import({ id, roomId, title: "删除测试文档", contentJson: CONTENT });
}

function expectServiceError(promise: Promise<unknown> | unknown, code: string, details?: Record<string, unknown>) {
  return expect(promise).rejects.toMatchObject(
    details ? { code, details } : { code },
  );
}

describe("context_room_document_delete", () => {
  it("注册进 listTools 且 promptGuidelines 包含确认要求", async () => {
    const { registry } = await createHarness("delete-tool-register");
    expect(registry.listTools().map((tool) => tool.name)).toContain(TOOL);
    const definition = registry.listTools().find((tool) => tool.name === TOOL);
    expect(definition?.annotations.destructiveHint).toBe(true);
    expect(definition?.annotations.readOnlyHint).toBe(false);
    expect(registry.promptGuidelines().some((line) => line.includes(TOOL))).toBe(true);
  });

  it("confirm=true 删除成功：移入回收站（可恢复），结果可读且不改 roomId", async () => {
    const { registry, documents } = await createHarness("delete-tool-happy");
    const document = await seedDocument(documents, "doc-del-1");
    const result = await registry.execute(TOOL, {
      documentId: document.id,
      confirm: true,
      reason: "用户要求删除",
    }, { agentSessionId: "s1", runId: "run-happy", roomId: "room-1" });

    const structured = result.structuredContent as {
      deleted: boolean;
      mode: string;
      recoverable: boolean;
      title: string;
    };
    expect(structured.deleted).toBe(true);
    expect(structured.mode).toBe("trash");
    expect(structured.recoverable).toBe(true);
    expect(structured.title).toBe("删除测试文档");

    // 活动列表不再包含，回收站列表包含；文档本身仍在（trash 非物理删除）。
    expect(documents.list("room-1").some((item) => item.id === document.id)).toBe(false);
    expect(documents.list("room-1", true).some((item) => item.id === document.id)).toBe(true);

    // 可恢复：restore 后回到活动列表。
    await documents.restore(document.id);
    expect(documents.list("room-1").some((item) => item.id === document.id)).toBe(true);
  });

  it("缺 confirm 或 confirm=false 被拒：文档保持原状", async () => {
    const { registry, documents } = await createHarness("delete-tool-confirm");
    const document = await seedDocument(documents, "doc-del-2");
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
    }, { agentSessionId: "s2", runId: "run-c1", roomId: "room-1" }), "DOCUMENT_DELETE_CONFIRM_REQUIRED", {
      retryable: true,
      nextAction: "ask_user_for_confirmation",
    });
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      confirm: false,
    }, { agentSessionId: "s2", runId: "run-c2", roomId: "room-1" }), "DOCUMENT_DELETE_CONFIRM_REQUIRED");
    expect(documents.list("room-1").some((item) => item.id === document.id)).toBe(true);
  });

  it("回收站文档、跨房间文档、不存在的文档被拒", async () => {
    const { registry, documents } = await createHarness("delete-tool-guard");
    const trashedDoc = await seedDocument(documents, "doc-del-3");
    await documents.delete(trashedDoc.id);
    await expectServiceError(registry.execute(TOOL, {
      documentId: trashedDoc.id,
      confirm: true,
    }, { agentSessionId: "s3", runId: "run-trash", roomId: "room-1" }), "DOCUMENT_TRASHED");

    const other = await seedDocument(documents, "doc-del-4");
    await expectServiceError(registry.execute(TOOL, {
      documentId: other.id,
      confirm: true,
    }, { agentSessionId: "s3", runId: "run-room", roomId: "room-other" }), "ROOM_MISMATCH");

    await expectServiceError(registry.execute(TOOL, {
      documentId: "doc-missing",
      confirm: true,
    }, { agentSessionId: "s3", runId: "run-missing", roomId: "room-1" }), "NOT_FOUND");
  });

  it("未选择 Room 时被拒（ROOM_SELECTION_REQUIRED）", async () => {
    const { registry, documents } = await createHarness("delete-tool-noroom");
    const document = await seedDocument(documents, "doc-del-5");
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      confirm: true,
    }, { agentSessionId: "s4", runId: "run-noroom", roomId: null }), "ROOM_SELECTION_REQUIRED");
    expect(documents.list("room-1").some((item) => item.id === document.id)).toBe(true);
  });
});
