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

const TOOL = "document_delete";

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

async function seedDocument(documents: DocumentService, id: string, roomId: string | null = "room-1") {
  return documents.import({ id, roomId, title: "删除测试文档", contentJson: CONTENT });
}

function expectServiceError(promise: Promise<unknown> | unknown, code: string, details?: Record<string, unknown>) {
  return expect(promise).rejects.toMatchObject(
    details ? { code, details } : { code },
  );
}

describe("document_delete", () => {
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
    }, { agentSessionId: "s1", runId: "run-happy" });

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
    expect(documents.list().some((item) => item.id === document.id)).toBe(false);
    expect(documents.list(true).some((item) => item.id === document.id)).toBe(true);

    // 可恢复：restore 后回到活动列表。
    await documents.restore(document.id);
    expect(documents.list().some((item) => item.id === document.id)).toBe(true);
  });

  it("缺 confirm 或 confirm=false 被拒：文档保持原状", async () => {
    const { registry, documents } = await createHarness("delete-tool-confirm");
    const document = await seedDocument(documents, "doc-del-2");
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
    }, { agentSessionId: "s2", runId: "run-c1" }), "DOCUMENT_DELETE_CONFIRM_REQUIRED", {
      retryable: true,
      nextAction: "ask_user_for_confirmation",
    });
    await expectServiceError(registry.execute(TOOL, {
      documentId: document.id,
      confirm: false,
    }, { agentSessionId: "s2", runId: "run-c2" }), "DOCUMENT_DELETE_CONFIRM_REQUIRED");
    expect(documents.list().some((item) => item.id === document.id)).toBe(true);
  });

  it("回收站文档与不存在的文档被拒；Phase 2i 起 context.roomId 不再构成归属校验", async () => {
    const { registry, documents } = await createHarness("delete-tool-guard");
    const trashedDoc = await seedDocument(documents, "doc-del-3");
    await documents.delete(trashedDoc.id);
    await expectServiceError(registry.execute(TOOL, {
      documentId: trashedDoc.id,
      confirm: true,
    }, { agentSessionId: "s3", runId: "run-trash" }), "DOCUMENT_TRASHED");

    // Phase 2i 去 Room：不同 run 的调用（原跨 Room 场景）不再有归属校验，照常删除成功。
    const other = await seedDocument(documents, "doc-del-4");
    const otherRun = await registry.execute(TOOL, {
      documentId: other.id,
      confirm: true,
    }, { agentSessionId: "s3", runId: "run-room" });
    expect(otherRun.structuredContent).toMatchObject({ documentId: other.id, deleted: true });

    await expectServiceError(registry.execute(TOOL, {
      documentId: "doc-missing",
      confirm: true,
    }, { agentSessionId: "s3", runId: "run-missing" }), "NOT_FOUND");
  });

  it("P0-2d：工作区级文稿（roomId 为 null）也能删除", async () => {
    const { registry, documents } = await createHarness("delete-tool-workspace");
    const document = await seedDocument(documents, "doc-del-5", null);
    expect(documents.get(document.id)?.roomId).toBeNull();
    const result = await registry.execute(TOOL, {
      documentId: document.id,
      confirm: true,
    }, { agentSessionId: "s4", runId: "run-workspace" });
    expect(result.structuredContent).toMatchObject({ documentId: document.id });
    expect(documents.get(document.id)?.deletedAt).toBeTruthy();
    expect(documents.list().some((item) => item.id === document.id)).toBe(false);
  });
});
