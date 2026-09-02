import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentInvocation, TiptapJsonContent } from "@nxcore/agent-contract";
import type { DocumentCapabilityPlugin } from "../src/modules/documents/capabilities/types.js";
import { createBuiltinDocumentCapabilityRegistry } from "../src/modules/documents/capabilities/builtins.js";
import { DocumentReadAuthority } from "../src/modules/documents/capabilities/read-authority.js";
import {
  buildSelectionRewriteProposedContent,
  createSelectionRewriteContentResolver,
  sanitizeSelectionRewriteReplacement,
} from "../src/modules/documents/capabilities/selection-rewrite-content.js";
import { DocumentCapabilityRegistry } from "../src/modules/documents/capabilities/registry.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { documentOperationItems, documentOperations, documentVersions } from "../src/infrastructure/database/schema.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentOperationService } from "../src/modules/documents/operations/service.js";
import { DocumentService } from "../src/modules/documents/service.js";
import { createDocumentPiTools } from "../src/modules/documents/pi-tools.js";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function plugin(id: string, toolName: string): DocumentCapabilityPlugin {
  return {
    manifest: {
      id,
      version: 1,
      type: "query",
      interactionMode: null,
      presenterKey: null,
      permissions: ["document:read"],
      requiresRoom: false,
      requiresDocument: false,
    },
    promptGuidelines: [`guideline:${id}`],
    tools: [{
      name: toolName,
      title: `Tool ${toolName}`,
      description: `Description ${toolName}`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      execute: () => ({ content: [{ type: "text", text: "{}" }], structuredContent: {} }),
    }],
  };
}

async function createReviewHarness(name: string) {
  const dataDir = await mkdtemp(join(tmpdir(), `nxcore-${name}-`));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const broker = new DocumentEventBroker();
  const documents = new DocumentService(database.db, broker);
  const operations = new DocumentOperationService(database.db, broker);
  const registry = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations);
  disposables.push(() => database.sqlite.close());
  return { database, documents, operations, registry };
}

describe("document capability registry", () => {
  it("blocks Agent reads, patches, and selection rewrites after a document enters trash", async () => {
    const { documents, registry } = await createReviewHarness("trashed-agent-document")
    const document = await documents.import({
      id: "doc-trashed-agent",
      roomId: "room-1",
      title: "Trashed document",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Private content" }] }],
      },
    })
    const context = { agentSessionId: "session-trash", runId: "run-trash", roomId: "room-1" }

    await documents.delete(document.id)

    await expect(registry.execute(
      "context_room_document_list",
      {},
      context,
    )).resolves.toMatchObject({ structuredContent: { documents: [] } })
    await expect(registry.execute(
      "context_room_document_read",
      { documentId: document.id },
      context,
    )).rejects.toMatchObject({ code: "DOCUMENT_TRASHED", statusCode: 409 })
    await expect(registry.execute(
      "context_room_patch_begin",
      { documentId: document.id, baseVersion: document.version, kind: "edit", summary: "rewrite" },
      context,
    )).rejects.toMatchObject({ code: "DOCUMENT_TRASHED", statusCode: 409 })
    await expect(registry.start({
      capabilityId: "document.selection-rewrite",
      context: { roomId: "room-1", documentId: document.id, sessionId: "session-trash", runId: "run-trash" },
      input: {
        baseVersion: document.version,
        proposedContentJson: document.contentJson,
        originalText: "Private content",
        replacementText: "Changed content",
        instruction: "rewrite",
      },
    })).rejects.toMatchObject({ code: "DOCUMENT_TRASHED", statusCode: 409 })
  })

  it("tells document agents the body comes from document_draft and keeps the page title out of the Markdown body", () => {
    const registry = createBuiltinDocumentCapabilityRegistry({} as never);

    // 写作规则已迁往 doc-writer（doc-writer-subagent-plan §6）：create/edit/continue
    // 指引只保留路由、审阅语义与“内容必须来自 document_draft 并逐字转发”的编排纪律。
    const guidelines = registry.promptGuidelines().join(" ");
    expect(guidelines).toMatch(/正文内容与标题必须来自 document_draft 的返回值并逐字转发.*write_append.*appendChunks/);
    expect(guidelines).toMatch(/document_draft\(task=draft-edit\).*hunks 与 baseVersion 逐字转发/);
    expect(guidelines).toMatch(/draft-continue.*appendChunks.*逐字转发/);
    // 标题/正文分离的机械底线保留在 append 工具 description（子 Agent 不可用时的降级护栏）。
    const appendDescription = registry.listTools()
      .find((tool) => tool.name === "context_room_write_append")?.description ?? "";
    expect(appendDescription).toMatch(/appendChunks.*逐字转发/);
    expect(appendDescription).toMatch(/不得包含标题或一级标题.*主章节从 ## 开始/);
  });

  it("rejects duplicate capability and tool registrations", () => {
    const registry = new DocumentCapabilityRegistry().register(plugin("document.read", "document_read"));
    expect(() => registry.register(plugin("document.read", "another_tool")))
      .toThrow("Duplicate document capability");
    expect(() => registry.register(plugin("document.other", "document_read")))
      .toThrow("Duplicate document tool");
  });

  it("builds MCP definitions and Pi tools from the same manifest directory", () => {
    const registry = new DocumentCapabilityRegistry()
      .register(plugin("document.read", "document_read"))
      .register(plugin("room.list", "room_list"));
    const host = {
      listTools: () => registry.listTools(),
      callTool: vi.fn(),
    };

    const mcpDefinitions = registry.listTools();
    const piTools = createDocumentPiTools(host as never);

    expect(piTools.map(({ name, description, parameters }) => ({ name, description, parameters })))
      .toEqual(mcpDefinitions.map(({ name, description, inputSchema }) => ({
        name,
        description,
        parameters: inputSchema,
      })));
  });

  it("does not allow a query-only plugin to start or mutate an operation", async () => {
    const registry = new DocumentCapabilityRegistry().register(plugin("document.read", "document_read"));
    await expect(registry.start({
      capabilityId: "document.read",
      context: { roomId: "room-1", sessionId: "session-1", runId: "run-1" },
      input: {},
    })).rejects.toMatchObject({ code: "UNSUPPORTED_DOCUMENT_CAPABILITY", statusCode: 409 });
  });

  it("enforces mutation permissions and rejects forged operation plans", async () => {
    const denied = plugin("document.denied", "document_denied");
    denied.manifest = {
      ...denied.manifest,
      type: "mutation",
      interactionMode: "atomic_review",
      presenterKey: "atomic-diff",
      permissions: ["document:read"],
      requiresRoom: true,
    };
    const deniedRegistry = new DocumentCapabilityRegistry().register(denied);
    await expect(deniedRegistry.execute("document_denied", {}, {
      agentSessionId: "session-1", runId: "run-1", roomId: "room-1",
    })).rejects.toMatchObject({ code: "CAPABILITY_PERMISSION_DENIED", statusCode: 403 });

    const create = vi.fn();
    const forged: DocumentCapabilityPlugin = {
      manifest: {
        id: "document.safe-edit", version: 1, type: "mutation",
        interactionMode: "atomic_review", presenterKey: "atomic-diff",
        permissions: ["room:read", "document:read", "document:write"],
        requiresRoom: true, requiresDocument: true,
      },
      promptGuidelines: [],
      tools: [],
      start: (request) => ({
        operation: {
          capabilityId: "document.forged", capabilityVersion: 1,
          interactionMode: "atomic_review", presenterKey: "atomic-diff",
          roomId: request.context.roomId, documentId: request.context.documentId ?? null,
          documentTitle: "Target", sessionId: request.context.sessionId,
          runId: request.context.runId, baseVersion: 1, summary: "Forged",
        },
      }),
    };
    const registry = new DocumentCapabilityRegistry({ create } as never).register(forged);
    await expect(registry.start({
      capabilityId: "document.safe-edit",
      context: { roomId: "room-1", documentId: "doc-1", sessionId: "session-1", runId: "run-1" },
      input: {},
    })).rejects.toMatchObject({ code: "OPERATION_PLAN_INVALID", statusCode: 500 });
    expect(create).not.toHaveBeenCalled();
  });

  it("commits selection rewrites through the document core before recording acceptance", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-selection-operation-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const applied = vi.fn();
    const broker = new DocumentEventBroker();
    const documents = new DocumentService(database.db, broker, undefined, applied);
    const operations = new DocumentOperationService(database.db, broker);
    disposables.push(() => {
      database.sqlite.close();
    });
    const registry = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations);
    const original = await documents.import({
      id: "doc-1",
      roomId: "room-1",
      title: "Rewrite target",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Before" }] }],
      },
    });
    const proposed = {
      type: "doc" as const,
      content: [{ type: "paragraph", attrs: original.contentJson.content?.[0]?.attrs, content: [{
        type: "text",
        text: "After",
      }] }],
    };
    const operation = await registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-1",
        documentId: "doc-1",
        sessionId: "session-1",
        runId: "run-1",
      },
      input: {
        baseVersion: original.version,
        proposedContentJson: proposed,
        originalText: "Before",
        replacementText: "After",
        instruction: "Make it clearer",
      },
    });

    expect(operation).toMatchObject({
      capabilityId: "document.selection-rewrite",
      interactionMode: "preview_replace",
      status: "awaiting_review",
      revision: 2,
    });
    expect(documents.get("doc-1")?.version).toBe(1);
    expect(applied).not.toHaveBeenCalled();

    const command = {
      commandId: "selection-accept-1",
      expectedRevision: operation.revision,
      type: "review.apply",
    };
    const accepted = await operations.execute(
      operation.id,
      command,
      (current, input) => registry.command(current, input),
    );
    const duplicate = await operations.execute(
      operation.id,
      command,
      (current, input) => registry.command(current, input),
    );

    expect(accepted).toMatchObject({
      duplicate: false,
      operation: { status: "completed", revision: 4 },
      document: { id: "doc-1", version: 2, contentJson: proposed },
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      document: { id: "doc-1", version: 2 },
    });
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      operationId: operation.id,
      originalText: "Before",
      replacementText: "After",
    }));
  });

  it("applies edited review Markdown and persists the accepted audit content", async () => {
    const { documents, operations, registry } = await createReviewHarness("edited-review-markdown-test");
    const document = await documents.import({
      id: "doc-edited-review",
      roomId: "room-1",
      title: "Editable review",
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "First original" }] },
          { type: "paragraph", content: [{ type: "text", text: "Second original" }] },
        ],
      },
    });
    const [firstBlock, secondBlock] = documents.listBlocks(document.id);
    const created = operations.create({
      capabilityId: "document.edit",
      capabilityVersion: 1,
      interactionMode: "atomic_review",
      presenterKey: "atomic-diff",
      roomId: document.roomId,
      documentId: document.id,
      documentTitle: document.title,
      sessionId: "session-review",
      runId: "run-review",
      baseVersion: document.version,
      status: "running",
      summary: "Edit the first paragraph and remove the second",
      acquireDocumentLease: true,
    });
    const prepared = await operations.execute(created.id, {
      commandId: "prepare-edited-review",
      expectedRevision: created.revision,
      type: "operation.prepare",
    }, () => ({
      status: "awaiting_review",
      addItems: [
        {
          id: "edit-item",
          sequence: 1,
          operation: "replace",
          target: { blockId: firstBlock!.blockId },
          before: document.contentJson.content!.slice(0, 1),
          after: [{ type: "paragraph", content: [{ type: "text", text: "Agent replacement" }] }],
          markdown: "Agent replacement",
          contentHash: "agent-replacement-hash",
        },
        {
          id: "delete-item",
          sequence: 2,
          operation: "delete",
          target: { blockId: secondBlock!.blockId },
          before: document.contentJson.content!.slice(1, 2),
          after: [],
          markdown: "",
          contentHash: "delete-hash",
        },
      ],
    }));

    await expect(operations.execute(prepared.operation.id, {
      commandId: "reject-delete-override",
      expectedRevision: prepared.operation.revision,
      type: "review.apply",
      payload: {
        acceptedItemIds: ["edit-item", "delete-item"],
        replacementMarkdownByItemId: { "delete-item": "Do not delete this" },
      },
    }, (operation, command) => registry.command(operation, command))).rejects.toMatchObject({
      code: "DELETE_OVERRIDE_NOT_ALLOWED",
    });
    await expect(operations.execute(prepared.operation.id, {
      commandId: "reject-oversized-override",
      expectedRevision: prepared.operation.revision,
      type: "review.apply",
      payload: {
        acceptedItemIds: ["edit-item"],
        replacementMarkdownByItemId: { "edit-item": "x".repeat(64 * 1024 + 1) },
      },
    }, (operation, command) => registry.command(operation, command))).rejects.toMatchObject({
      code: "SIZE_LIMIT",
    });

    const replacementMarkdown = "## User heading\n\nUser-edited paragraph.";
    const accepted = await operations.execute(prepared.operation.id, {
      commandId: "accept-edited-review",
      expectedRevision: prepared.operation.revision,
      type: "review.apply",
      payload: {
        acceptedItemIds: ["edit-item"],
        replacementMarkdownByItemId: { "edit-item": replacementMarkdown },
      },
    }, (operation, command) => registry.command(operation, command));

    expect(accepted.document?.contentJson.content).toEqual([
      expect.objectContaining({
        type: "heading",
        attrs: expect.objectContaining({ level: 2 }),
        content: [{ type: "text", text: "User heading" }],
      }),
      expect.objectContaining({
        type: "paragraph",
        content: [{ type: "text", text: "User-edited paragraph." }],
      }),
      expect.objectContaining({
        type: "paragraph",
        content: [{ type: "text", text: "Second original" }],
      }),
    ]);
    expect(operations.get(created.id)?.items).toEqual([
      expect.objectContaining({
        id: "edit-item",
        status: "applied",
        markdown: replacementMarkdown,
        after: [
          expect.objectContaining({ type: "heading", attrs: expect.objectContaining({ level: 2 }) }),
          expect.objectContaining({ type: "paragraph" }),
        ],
        contentHash: expect.not.stringMatching("agent-replacement-hash"),
      }),
      expect.objectContaining({ id: "delete-item", status: "rejected" }),
    ]);
  });

  it("persists a Markdown table accepted from an Agent edit proposal", async () => {
    const { documents, operations, registry } = await createReviewHarness("edit-table-markdown-test");
    const document = await documents.import({
      id: "doc-edit-table",
      roomId: "room-1",
      title: "Editable table",
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Replace this summary." }] },
          { type: "paragraph", content: [{ type: "text", text: "Keep this detailed context unchanged. ".repeat(8) }] },
        ],
      },
    });
    const targetId = documents.listBlocks(document.id)[0]!.blockId;
    const context = { agentSessionId: "session-edit-table", runId: "run-edit-table", roomId: "room-1" };
    await registry.execute("context_room_document_read", { documentId: document.id }, context);
    const begun = await registry.execute("context_room_patch_begin", {
      documentId: document.id,
      baseVersion: document.version,
      kind: "edit",
      summary: "Replace the summary with a comparison table",
    }, context);
    const operationId = String(begun.structuredContent.operationId);
    await registry.execute("context_room_patch_hunk", {
      operationId,
      sequence: 1,
      operation: "replace",
      target: { blockId: targetId },
      markdown: [
        "| Option | Status |",
        "| --- | --- |",
        "| Alpha | Ready |",
        "|   |   |",
        "| Beta | Planned |",
        "",
        "|   |   |",
        "| --- | --- |",
      ].join("\n"),
    }, context);
    await registry.execute("context_room_patch_commit", { operationId, finalSequence: 1 }, context);

    const prepared = operations.get(operationId)!;
    expect(prepared.items[0]?.after[0]).toMatchObject({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader" }, { type: "tableHeader" }] },
        { type: "tableRow", content: [{ type: "tableCell" }, { type: "tableCell" }] },
        { type: "tableRow", content: [{ type: "tableCell" }, { type: "tableCell" }] },
      ],
    });
    const accepted = await operations.execute(operationId, {
      commandId: "accept-edit-table",
      expectedRevision: prepared.revision,
      type: "review.apply",
      payload: { acceptedItemIds: [prepared.items[0]!.id] },
    }, (operation, command) => registry.command(operation, command));
    expect(accepted.document?.contentJson.content?.[0]).toMatchObject({ type: "table" });
    expect(documents.get(document.id)).toMatchObject({ version: 2 });
  });

  it("applies an edited continuation block without breaking the next item anchor", async () => {
    const { documents, operations, registry } = await createReviewHarness("edited-continuation-markdown-test");
    const document = await documents.import({
      id: "doc-edited-continuation",
      roomId: "room-1",
      title: "Editable continuation",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Base" }] }] },
    });
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const created = operations.create({
      capabilityId: "document.continue",
      capabilityVersion: 1,
      interactionMode: "incremental_review",
      presenterKey: "continuation",
      roomId: document.roomId,
      documentId: document.id,
      documentTitle: document.title,
      sessionId: "session-continuation",
      runId: "run-continuation",
      baseVersion: document.version,
      status: "running",
      summary: "Continue the document",
      acquireDocumentLease: true,
    });
    const prepared = await operations.execute(created.id, {
      commandId: "prepare-edited-continuation",
      expectedRevision: created.revision,
      type: "operation.prepare",
    }, () => ({
      status: "awaiting_review",
      addItems: [
        {
          id: firstId,
          sequence: 1,
          operation: "insert",
          target: { at: "end" },
          before: [],
          after: [{ type: "paragraph", attrs: { id: firstId }, content: [{ type: "text", text: "Agent first" }] }],
          markdown: "Agent first",
          contentHash: "agent-first-hash",
        },
        {
          id: secondId,
          sequence: 2,
          operation: "insert",
          target: { blockId: firstId, edge: "after" },
          before: [],
          after: [{ type: "paragraph", attrs: { id: secondId }, content: [{ type: "text", text: "Agent second" }] }],
          markdown: "Agent second",
          contentHash: "agent-second-hash",
        },
      ],
    }));

    await expect(operations.execute(created.id, {
      commandId: "reject-empty-continuation-override",
      expectedRevision: prepared.operation.revision,
      type: "item.accept",
      payload: { itemId: firstId, replacementMarkdown: "   " },
    }, (operation, command) => registry.command(operation, command))).rejects.toMatchObject({
      code: "EMPTY_REPLACEMENT_MARKDOWN",
    });
    const replacementMarkdown = "## User-edited first\n\nSecond edited block";
    const firstAccepted = await operations.execute(created.id, {
      commandId: "accept-edited-continuation-first",
      expectedRevision: prepared.operation.revision,
      type: "item.accept",
      payload: { itemId: firstId, replacementMarkdown },
    }, (operation, command) => registry.command(operation, command));
    expect(firstAccepted.operation).toMatchObject({ status: "awaiting_review", baseVersion: 2 });
    expect(firstAccepted.document?.contentJson.content?.slice(-2)).toEqual([
      expect.objectContaining({
        type: "heading",
        attrs: expect.objectContaining({ level: 2 }),
        content: [{ type: "text", text: "User-edited first" }],
      }),
      expect.objectContaining({
        type: "paragraph",
        attrs: { id: firstId },
        content: [{ type: "text", text: "Second edited block" }],
      }),
    ]);

    const secondAccepted = await operations.execute(created.id, {
      commandId: "accept-edited-continuation-second",
      expectedRevision: firstAccepted.operation.revision,
      type: "item.accept",
      payload: { itemId: secondId },
    }, (operation, command) => registry.command(operation, command));
    expect(secondAccepted.operation).toMatchObject({ status: "completed", baseVersion: 3 });
    expect(secondAccepted.document?.contentJson.content?.slice(-3)).toEqual([
      expect.objectContaining({ type: "heading", attrs: expect.objectContaining({ level: 2 }) }),
      expect.objectContaining({ type: "paragraph", attrs: expect.objectContaining({ id: firstId }) }),
      expect.objectContaining({ type: "paragraph", attrs: expect.objectContaining({ id: secondId }) }),
    ]);
    expect(operations.get(created.id)?.items).toEqual([
      expect.objectContaining({
        id: firstId,
        status: "applied",
        markdown: replacementMarkdown,
        after: [
          expect.objectContaining({ type: "heading" }),
          expect.objectContaining({ attrs: expect.objectContaining({ id: firstId }) }),
        ],
        contentHash: expect.not.stringMatching("agent-first-hash"),
      }),
      expect.objectContaining({ id: secondId, status: "applied", markdown: "Agent second" }),
    ]);
  });

  it("persists a Markdown table accepted from an Agent continuation", async () => {
    const { documents, operations, registry } = await createReviewHarness("continuation-table-markdown-test");
    const document = await documents.import({
      id: "doc-continuation-table",
      roomId: "room-1",
      title: "Continuation table",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Base text" }] }] },
    });
    const context = {
      agentSessionId: "session-continuation-table",
      runId: "run-continuation-table",
      roomId: "room-1",
    };
    await registry.execute("context_room_document_read", { documentId: document.id }, context);
    const begun = await registry.execute("context_room_patch_begin", {
      documentId: document.id,
      baseVersion: document.version,
      kind: "continue",
      summary: "Append a rollout table",
    }, context);
    const operationId = String(begun.structuredContent.operationId);
    await registry.execute("context_room_patch_hunk", {
      operationId,
      sequence: 1,
      operation: "insert",
      target: { at: "end" },
      markdown: "| Phase | Owner |\n| --- | --- |\n| Build | Team A |\n| Ship | Team B |",
    }, context);
    await registry.execute("context_room_patch_commit", { operationId, finalSequence: 1 }, context);

    const prepared = operations.get(operationId)!;
    expect(prepared.items).toHaveLength(1);
    expect(prepared.items[0]?.after[0]).toMatchObject({ type: "table" });
    const accepted = await operations.execute(operationId, {
      commandId: "accept-continuation-table",
      expectedRevision: prepared.revision,
      type: "item.accept",
      payload: { itemId: prepared.items[0]!.id },
    }, (operation, command) => registry.command(operation, command));
    expect(accepted.document?.contentJson.content?.at(-1)).toMatchObject({ type: "table" });
    expect(documents.get(document.id)).toMatchObject({ version: 2 });
  });

  it("creates documents from the operation kernel without legacy transactions and keeps commit idempotent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-create-operation-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const broker = new DocumentEventBroker();
    const captured = vi.fn();
    const documents = new DocumentService(database.db, broker, captured);
    const operations = new DocumentOperationService(database.db, broker);
    const registry = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations);
    disposables.push(() => {
      database.sqlite.close();
    });
    const context = { agentSessionId: "session-create", runId: "run-create", roomId: "room-create" };

    const started = await registry.execute("context_room_write_begin", {
      mode: "create", title: "Operation 创建", format: "markdown",
    }, context);
    const operationId = String(started.structuredContent.operationId);
    const draftDocumentId = String(started.structuredContent.docId);
    expect(database.db.select().from(documentOperations).all()).toHaveLength(1);
    expect(documents.get(draftDocumentId)).toMatchObject({
      id: draftDocumentId,
      status: "draft",
      version: 0,
      activeTransactionId: operationId,
    });
    expect(database.db.select().from(documentVersions).all()).toEqual([]);

    const first = await registry.execute("context_room_write_append", {
      operationId,
      sequence: 1,
      text: "## Operation 创建\n\n### 1. 第一章\n\n#### 1.1 小节\n\n第一段",
    }, context);
    const second = await registry.execute("context_room_write_append", {
      operationId, sequence: 2, text: "\n\n#### 1.2 后续小节\n\n第二段",
    }, context);
    expect(first.structuredContent).toMatchObject({ nextSequence: 2, totalBytes: expect.any(Number) });
    expect(second.structuredContent).toMatchObject({ nextSequence: 3, totalBytes: expect.any(Number) });
    const streamedItems = database.db.select().from(documentOperationItems).all();
    expect(streamedItems).toHaveLength(2);
    expect(streamedItems[0]?.markdown).not.toContain("Operation 创建");
    expect(streamedItems[0]?.markdown).toContain("## 1. 第一章");
    expect(streamedItems[0]?.markdown).toContain("### 1.1 小节");
    expect(streamedItems[0]?.markdown).not.toContain("#### 1.1 小节");
    expect(streamedItems[1]?.markdown).toContain("#### 1.2 后续小节");
    expect(documents.get(draftDocumentId)).toMatchObject({
      status: "draft",
      version: 0,
      contentJson: { type: "doc", content: expect.any(Array) },
    });
    expect(documents.get(draftDocumentId)?.contentJson.content).toEqual([
      expect.objectContaining({ type: "heading", attrs: expect.objectContaining({ level: 2 }) }),
      expect.objectContaining({ type: "heading", attrs: expect.objectContaining({ level: 3 }) }),
      expect.objectContaining({ type: "paragraph", content: [{ type: "text", text: "第一段" }] }),
      expect.objectContaining({ type: "heading", attrs: expect.objectContaining({ level: 4 }) }),
      expect.objectContaining({ type: "paragraph", content: [{ type: "text", text: "第二段" }] }),
    ]);

    const committed = await registry.execute("context_room_write_commit", {
      operationId, finalSequence: 2,
    }, context);
    const documentId = String(committed.structuredContent.docId);
    expect(committed.structuredContent).toMatchObject({ state: "completed", docId: documentId });
    expect(documents.get(documentId)).toMatchObject({
      id: documentId, roomId: "room-create", title: "Operation 创建", version: 1, status: "active",
    });
    expect(documents.get(documentId)?.contentJson.content?.some((node) =>
      node.type === "heading" && node.attrs?.level === 1)).toBe(false);
    expect(database.db.select().from(documentVersions).all()).toEqual([
      expect.objectContaining({ documentId, version: 1, sourceTransactionId: operationId }),
    ]);
    expect(captured).toHaveBeenCalledTimes(1);

    const duplicate = await registry.execute("context_room_write_commit", {
      operationId, finalSequence: 2,
    }, context);
    expect(duplicate.structuredContent).toMatchObject({ state: "completed", docId: documentId });
    expect(captured).toHaveBeenCalledTimes(1);
    expect(database.db.select().from(documentVersions).all()).toHaveLength(1);
  });

  it("reassembles a table split across Agent document chunks before persisting it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-create-table-operation-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const documents = new DocumentService(database.db, new DocumentEventBroker());
    const operations = new DocumentOperationService(database.db, documents.broker);
    const registry = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations);
    disposables.push(() => database.sqlite.close());
    const context = { agentSessionId: "session-create-table", runId: "run-create-table", roomId: "room-create" };
    const started = await registry.execute("context_room_write_begin", {
      mode: "create",
      title: "Table document",
      format: "markdown",
    }, context);
    const operationId = String(started.structuredContent.operationId);
    const documentId = String(started.structuredContent.docId);

    await registry.execute("context_room_write_append", {
      operationId,
      sequence: 1,
      text: "| Name | Value |\n| ---",
    }, context);
    await registry.execute("context_room_write_append", {
      operationId,
      sequence: 2,
      text: " | --- |\n| Alpha | 1 |\n| Beta | 2 |",
    }, context);
    expect(documents.get(documentId)?.contentJson.content?.[0]).toMatchObject({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader" }, { type: "tableHeader" }] },
        { type: "tableRow", content: [{ type: "tableCell" }, { type: "tableCell" }] },
        { type: "tableRow", content: [{ type: "tableCell" }, { type: "tableCell" }] },
      ],
    });

    await registry.execute("context_room_write_commit", { operationId, finalSequence: 2 }, context);
    expect(documents.get(documentId)).toMatchObject({ version: 1, status: "active" });
    expect(documents.get(documentId)?.contentJson.content?.[0]).toMatchObject({ type: "table" });
  });

  it("removes empty tables and rows from Agent-created documents", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-create-empty-table-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const documents = new DocumentService(database.db, new DocumentEventBroker());
    disposables.push(() => database.sqlite.close());

    const markdown = [
      "| Item | Result |",
      "| --- | --- |",
      "| Alpha | Pass |",
      "|   |   |",
      "| Beta | Pass |",
      "",
      "|   |   |   |",
      "| --- | --- | --- |",
      "|   |   |   |",
    ].join("\n");
    const normalizedChunk = documents.normalizeAgentDocumentChunk("Comparison", markdown);
    expect(normalizedChunk).not.toMatch(/\|\s*\|\s*\|\s*\|/);

    const prepared = documents.prepareAgentDocumentDraft({
      documentId: "doc-empty-tables",
      roomId: "room-1",
      title: "Comparison",
      markdown,
    });
    const tables = prepared.content.content?.filter((node) => node.type === "table") ?? [];
    expect(tables).toHaveLength(1);
    expect(tables[0]?.content).toHaveLength(3);
    expect(tables[0]?.content?.map((row) => row.content?.map((cell) => (
      cell.content?.[0]?.content?.[0]?.text ?? ""
    )))).toEqual([
      ["Item", "Result"],
      ["Alpha", "Pass"],
      ["Beta", "Pass"],
    ]);
  });

  it("enforces the authoritative title and heading hierarchy for Agent-created bodies", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-create-body-normalization-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const documents = new DocumentService(database.db, new DocumentEventBroker());
    disposables.push(() => {
      database.sqlite.close();
    });

    const duplicateTitle = documents.prepareAgentDocumentDraft({
      documentId: "doc-title-normalized",
      roomId: "room-1",
      title: "Java 学习指南",
      markdown: "# Java学习指南！\n\n开场说明\n\n## 第一章",
    });
    expect(duplicateTitle.content.content).toEqual([
      expect.objectContaining({ type: "paragraph", content: [{ type: "text", text: "开场说明" }] }),
      expect.objectContaining({ type: "heading", attrs: expect.objectContaining({ level: 2 }) }),
    ]);

    const nestedUnderDuplicateTitle = documents.prepareAgentDocumentDraft({
      documentId: "doc-nested-title-normalized",
      roomId: "room-1",
      title: "TypeScript 入门指南",
      markdown: "## TypeScript 入门指南\n\n### 2. 基本语法\n\n#### 2.1 类型注解",
    });
    expect(nestedUnderDuplicateTitle.content.content?.filter((node) => node.type === "heading")
      .map((node) => [node.attrs?.level, node.content?.[0]?.text])).toEqual([
        [2, "2. 基本语法"],
        [3, "2.1 类型注解"],
      ]);

    const shiftedOutline = documents.prepareAgentDocumentDraft({
      documentId: "doc-heading-normalized",
      roomId: "room-1",
      title: "另一篇文档",
      markdown: "# 第一章\n\n## 1.1 子章节\n\n正文",
    });
    expect(shiftedOutline.content.content?.filter((node) => node.type === "heading")
      .map((node) => node.attrs?.level)).toEqual([2, 3]);
  });

  it("parses rich GFM tables without turning ordinary pipe text into a table", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-table-markdown-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const documents = new DocumentService(database.db, new DocumentEventBroker());
    disposables.push(() => database.sqlite.close());

    const tableDraft = documents.prepareAgentDocumentDraft({
      documentId: "doc-rich-table",
      roomId: "room-1",
      title: "Rich table",
      markdown: [
        "| Key | Details |",
        "| --- | --- |",
        "| A \\| B | **Bold** and [Docs](https://example.com) |",
      ].join("\n"),
    });
    expect(tableDraft.content.content?.[0]).toMatchObject({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader" }, { type: "tableHeader" }] },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "A | B" }] }],
            },
            {
              type: "tableCell",
              content: [{
                type: "paragraph",
                content: [
                  { type: "text", text: "Bold", marks: [{ type: "bold" }] },
                  { type: "text", text: " and " },
                  {
                    type: "text",
                    text: "Docs",
                    marks: [{ type: "link", attrs: { href: "https://example.com", title: null } }],
                  },
                ],
              }],
            },
          ],
        },
      ],
    });

    const pipeTextDraft = documents.prepareAgentDocumentDraft({
      documentId: "doc-pipe-text",
      roomId: "room-1",
      title: "Pipe text",
      markdown: "A | B",
    });
    expect(pipeTextDraft.content.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "A | B" }] },
    ]);
  });

  it("cancels a create operation and removes its draft", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-create-abort-operation-test-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const broker = new DocumentEventBroker();
    const documents = new DocumentService(database.db, broker);
    const operations = new DocumentOperationService(database.db, broker);
    const registry = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations);
    disposables.push(() => {
      database.sqlite.close();
    });
    const context = { agentSessionId: "session-abort", runId: "run-abort", roomId: "room-abort" };
    const started = await registry.execute("context_room_write_begin", {
      mode: "create", title: "待取消", format: "markdown",
    }, context);
    const operationId = String(started.structuredContent.operationId);
    const draftDocumentId = String(started.structuredContent.docId);
    expect(documents.get(draftDocumentId)).toMatchObject({ status: "draft", version: 0 });
    await registry.execute("context_room_write_abort", { operationId, reason: "test" }, context);
    expect(documents.list("room-abort")).toEqual([]);
    expect(documents.get(draftDocumentId)).toBeNull();
    expect(operations.get(operationId)).toMatchObject({ status: "cancelled", result: { reason: "test" } });
  });
});

/** 改写信任收口（agent-architecture-optimization-plan §3）：invocation 绑定测试的公共装置。 */
async function createInvocationRewriteHarness(name: string) {
  const dataDir = await mkdtemp(join(tmpdir(), `nxcore-${name}-`));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const applied = vi.fn();
  const broker = new DocumentEventBroker();
  const documents = new DocumentService(database.db, broker, undefined, applied);
  const operations = new DocumentOperationService(database.db, broker);
  const invocations = new Map<string, SubagentInvocation>();
  // 以假 invocation 表装配真 resolver：授权判定对齐 isSelectionRewriteInvocationAuthorized
  // 的核心规则（M2 后内容生产者为 doc-writer）。
  documents.resolveSelectionRewriteContent = createSelectionRewriteContentResolver({
    getInvocation: (invocationId) => invocations.get(invocationId) ?? null,
    isInvocationAuthorized: (invocation, roomId) => Boolean(invocation
      && invocation.agentDefinitionId === "doc-writer"
      && invocation.source === "internal_workflow"
      && invocation.status === "completed"
      && (invocation.input as { roomId?: unknown }).roomId === roomId),
    getDocument: (documentId) => documents.get(documentId) ?? null,
  });
  const registry = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations);
  disposables.push(() => database.sqlite.close());
  return { database, documents, operations, registry, invocations, applied };
}

function seedSelectionRewriteInvocation(
  invocations: Map<string, SubagentInvocation>,
  input: {
    roomId: string;
    selectedText: string;
    text: string;
    instruction?: string;
  },
  overrides: Partial<SubagentInvocation> = {},
): SubagentInvocation {
  const invocation: SubagentInvocation = {
    id: randomUUID(),
    agentDefinitionId: "doc-writer",
    agentRevisionId: "doc-writer-rev-1",
    source: "internal_workflow",
    parentSessionId: null,
    parentRunId: null,
    task: "改写选中文本",
    input: {
      task: "rewrite",
      roomId: input.roomId,
      documentName: "Rewrite target",
      selectedText: input.selectedText,
      instruction: input.instruction ?? "更简洁",
    },
    status: "completed",
    result: { text: input.text },
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
  invocations.set(invocation.id, invocation);
  return invocation;
}

async function importRewriteTargetDocument(documents: DocumentService) {
  return await documents.import({
    id: "doc-invocation-rewrite",
    roomId: "room-invocation",
    title: "Invocation rewrite target",
    contentJson: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "开头段。" }] },
        { type: "paragraph", content: [{ type: "text", text: "中间段落的开头，被选中的文本，中间段落的结尾。" }] },
        { type: "paragraph", content: [{ type: "text", text: "结尾段。" }] },
      ],
    },
  });
}

describe("selection-rewrite invocation 绑定（改写信任收口）", () => {
  it("携带 invocationId 时由 resolver 解析内容，start/apply 落库且不采信客户端全文", async () => {
    const { documents, operations, registry, invocations, applied } = await createInvocationRewriteHarness("selection-invocation-ok");
    const document = await importRewriteTargetDocument(documents);
    const invocation = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-invocation",
      selectedText: "被选中的文本",
      text: "改写内容如下：**全新改写**",
      instruction: "更简洁一点",
    });

    const operation = await registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-invocation",
        documentId: document.id,
        sessionId: invocation.id,
        runId: invocation.id,
      },
      input: {
        baseVersion: document.version,
        invocationId: invocation.id,
        // 伪造的全文必须被忽略
        proposedContentJson: { type: "doc", content: [] },
        originalText: "伪造原文",
        replacementText: "伪造替换",
        instruction: "伪造指令",
      },
    });

    expect(operation).toMatchObject({
      capabilityId: "document.selection-rewrite",
      status: "awaiting_review",
      summary: "更简洁一点",
    });
    expect(operation.input).toMatchObject({
      invocationId: invocation.id,
      originalText: "被选中的文本",
      replacementText: "**全新改写**",
      instruction: "更简洁一点",
    });
    // 预览 after：权威文档 + 行内替换（选区在块内部且替换解析为单段）
    const proposed = operation.items[0]!.after[0]!;
    expect(proposed.content?.[0]).toMatchObject({ type: "paragraph" });
    expect(proposed.content?.[1]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "中间段落的开头，" },
        { type: "text", text: "全新改写", marks: [{ type: "bold" }] },
        { type: "text", text: "，中间段落的结尾。" },
      ],
    });
    expect(proposed.content?.[2]).toMatchObject({ type: "paragraph" });
    expect(operation.items[0]!.markdown).toBe("**全新改写**");
    expect(documents.get(document.id)?.version).toBe(1);
    expect(applied).not.toHaveBeenCalled();

    const accepted = await operations.execute(operation.id, {
      commandId: "accept-invocation-rewrite",
      expectedRevision: operation.revision,
      type: "review.apply",
    }, (current, command) => registry.command(current, command));

    expect(accepted).toMatchObject({
      duplicate: false,
      operation: { status: "completed" },
      document: { id: document.id, version: 2 },
    });
    const middle = JSON.stringify(accepted.document!.contentJson.content?.[1]);
    expect(middle).toContain("中间段落的开头，");
    expect(middle).toContain("全新改写");
    expect(middle).toContain("bold");
    expect(middle).toContain("，中间段落的结尾。");
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      operationId: operation.id,
      instruction: "更简洁一点",
      originalText: "被选中的文本",
      replacementText: "**全新改写**",
    }));
  });

  it("doc-writer invocation 优先读 structuredOutput.replacementText，text 仅作迁移期回退", async () => {
    const { documents, operations, registry, invocations } = await createInvocationRewriteHarness("selection-structured-output");
    const document = await importRewriteTargetDocument(documents);
    const invocation = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-invocation",
      selectedText: "被选中的文本",
      text: "doc-writer 的最终文本不再是替换片段",
      instruction: "更简洁一点",
    }, {
      result: {
        text: "doc-writer 的最终文本不再是替换片段",
        structuredOutput: { kind: "rewrite", replacementText: "**结构化替换**", digest: { summary: "s" } },
      },
    });

    const operation = await registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-invocation",
        documentId: document.id,
        sessionId: invocation.id,
        runId: invocation.id,
      },
      input: { baseVersion: document.version, invocationId: invocation.id },
    });

    expect(operation.input).toMatchObject({
      invocationId: invocation.id,
      originalText: "被选中的文本",
      replacementText: "**结构化替换**",
    });
    expect(operation.items[0]!.markdown).toBe("**结构化替换**");
  });

  it("用户编辑过替换文本时按用户文本重建并记 userModified（Agent 提案 + 用户修改）", async () => {
    const { documents, operations, registry, invocations, applied } = await createInvocationRewriteHarness("selection-user-edit-ok");
    const document = await importRewriteTargetDocument(documents);
    const invocation = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-invocation",
      selectedText: "被选中的文本",
      text: "改写内容如下：**全新改写**",
      instruction: "更简洁一点",
    });

    const operation = await registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-invocation",
        documentId: document.id,
        sessionId: invocation.id,
        runId: invocation.id,
      },
      input: {
        baseVersion: document.version,
        invocationId: invocation.id,
        userEditedReplacementText: "用户亲自改定的文本",
      },
    });

    expect(operation.input).toMatchObject({
      invocationId: invocation.id,
      userModified: true,
      userEditedReplacementText: "用户亲自改定的文本",
      replacementText: "用户亲自改定的文本",
    });
    // 预览 after：用户文本行内替换进选区，invocation 输出不得出现
    const proposed = operation.items[0]!.after[0]!;
    expect(proposed.content?.[1]).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "中间段落的开头，" },
        { type: "text", text: "用户亲自改定的文本" },
        { type: "text", text: "，中间段落的结尾。" },
      ],
    });
    expect(JSON.stringify(proposed)).not.toContain("全新改写");

    const accepted = await operations.execute(operation.id, {
      commandId: "accept-user-edit",
      expectedRevision: operation.revision,
      type: "review.apply",
    }, (current, command) => registry.command(current, command));

    expect(accepted).toMatchObject({
      duplicate: false,
      operation: { status: "completed" },
      document: { id: document.id, version: 2 },
    });
    expect(JSON.stringify(accepted.document!.contentJson)).toContain("用户亲自改定的文本");
    expect(JSON.stringify(accepted.document!.contentJson)).not.toContain("全新改写");
    // 记忆沉淀用用户实际应用的文本
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({
      replacementText: "用户亲自改定的文本",
      originalText: "被选中的文本",
    }));
  });

  it("userEditedReplacementText 必须伴随 invocationId（防旧路径静默丢编辑）", async () => {
    const { documents, registry } = await createInvocationRewriteHarness("selection-user-edit-requires-invocation");
    const document = await importRewriteTargetDocument(documents);
    await expect(registry.start({
      capabilityId: "document.selection-rewrite",
      context: { roomId: "room-invocation", documentId: document.id, sessionId: "session-legacy", runId: "run-legacy" },
      input: {
        baseVersion: document.version,
        proposedContentJson: { type: "doc", content: [] },
        userEditedReplacementText: "编辑文本",
      },
    })).rejects.toMatchObject({
      code: "SELECTION_REWRITE_USER_EDIT_REQUIRES_INVOCATION",
      statusCode: 409,
    });
  });

  it("invocationId 不存在或未授权时给出明确错误", async () => {
    const { documents, registry, invocations } = await createInvocationRewriteHarness("selection-invocation-denied");
    const document = await importRewriteTargetDocument(documents);
    const start = (invocationId: string) => registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-invocation",
        documentId: document.id,
        sessionId: invocationId,
        runId: invocationId,
      },
      input: { baseVersion: document.version, invocationId },
    });

    await expect(start("missing-invocation")).rejects.toMatchObject({
      code: "SELECTION_REWRITE_INVOCATION_UNAUTHORIZED",
      statusCode: 409,
    });

    const failed = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-invocation",
      selectedText: "被选中的文本",
      text: "x",
    }, { status: "failed" });
    await expect(start(failed.id)).rejects.toMatchObject({
      code: "SELECTION_REWRITE_INVOCATION_UNAUTHORIZED",
    });

    const otherRoom = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-other",
      selectedText: "被选中的文本",
      text: "x",
    });
    await expect(start(otherRoom.id)).rejects.toMatchObject({
      code: "SELECTION_REWRITE_INVOCATION_UNAUTHORIZED",
    });

    const noOutput = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-invocation",
      selectedText: "被选中的文本",
      text: "x",
    }, { result: null });
    await expect(start(noOutput.id)).rejects.toMatchObject({
      code: "SELECTION_REWRITE_INVOCATION_UNAUTHORIZED",
    });
  });

  it("携带 invocationId 时 baseVersion 漂移仍然 409", async () => {
    const { documents, registry, invocations } = await createInvocationRewriteHarness("selection-invocation-conflict");
    const document = await importRewriteTargetDocument(documents);
    const invocation = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-invocation",
      selectedText: "被选中的文本",
      text: "全新改写",
    });

    await expect(registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-invocation",
        documentId: document.id,
        sessionId: invocation.id,
        runId: invocation.id,
      },
      input: { baseVersion: document.version + 1, invocationId: invocation.id },
    })).rejects.toMatchObject({ code: "DOCUMENT_CONFLICT", statusCode: 409 });
  });

  it("迁移双态：无 invocationId、仅 proposedContentJson 的旧输入仍可完成", async () => {
    const { documents, operations, registry } = await createInvocationRewriteHarness("selection-legacy-input");
    const document = await importRewriteTargetDocument(documents);
    const proposed = structuredClone(document.contentJson);
    const middle = proposed.content?.[1];
    if (!middle) throw new Error("fixture paragraph missing");
    middle.content = [{ type: "text", text: "旧路径替换" }];

    const operation = await registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-invocation",
        documentId: document.id,
        sessionId: "legacy-session",
        runId: "legacy-run",
      },
      input: {
        baseVersion: document.version,
        proposedContentJson: proposed,
        originalText: "被选中的文本",
        replacementText: "旧路径替换",
        instruction: "旧客户端",
      },
    });
    expect(operation.input).toMatchObject({ proposedContentJson: proposed });
    const accepted = await operations.execute(operation.id, {
      commandId: "accept-legacy-rewrite",
      expectedRevision: operation.revision,
      type: "review.apply",
    }, (current, command) => registry.command(current, command));
    expect(accepted).toMatchObject({
      operation: { status: "completed" },
      document: { id: document.id, version: 2 },
    });
  });

  it("apply 时 invocation 已失效：报错且不落库", async () => {
    const { documents, operations, registry, invocations, applied } = await createInvocationRewriteHarness("selection-invocation-apply-failed");
    const document = await importRewriteTargetDocument(documents);
    const invocation = seedSelectionRewriteInvocation(invocations, {
      roomId: "room-invocation",
      selectedText: "被选中的文本",
      text: "全新改写",
    });
    const operation = await registry.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-invocation",
        documentId: document.id,
        sessionId: invocation.id,
        runId: invocation.id,
      },
      input: { baseVersion: document.version, invocationId: invocation.id },
    });
    expect(operation.status).toBe("awaiting_review");

    // invocation 被删（或状态变化）：apply 复核失败
    invocations.delete(invocation.id);
    await expect(operations.execute(operation.id, {
      commandId: "accept-stale-invocation",
      expectedRevision: operation.revision,
      type: "review.apply",
    }, (current, command) => registry.command(current, command))).rejects.toMatchObject({
      code: "SELECTION_REWRITE_INVOCATION_UNAUTHORIZED",
    });
    expect(documents.get(document.id)?.version).toBe(1);
    expect(operations.get(operation.id)?.status).toBe("awaiting_review");
    expect(applied).not.toHaveBeenCalled();
  });
});

describe("selection-rewrite 内容重建（服务端）", () => {
  it("sanitizeSelectionRewriteReplacement 剥离围栏与前缀", () => {
    expect(sanitizeSelectionRewriteReplacement("```\n纯文本\n```")).toBe("纯文本");
    expect(sanitizeSelectionRewriteReplacement("```markdown\n带语言\n```")).toBe("带语言");
    expect(sanitizeSelectionRewriteReplacement("改写内容如下：正文")).toBe("正文");
    expect(sanitizeSelectionRewriteReplacement("replacement: body")).toBe("body");
    expect(sanitizeSelectionRewriteReplacement("  保留  ")).toBe("保留");
    // preserveWhitespace（代码块）与渲染端一致：剥围栏但保留行尾换行
    expect(sanitizeSelectionRewriteReplacement("```js\n  code  \n```", { preserveWhitespace: true })).toBe("  code  \n");
  });

  it("整块选区替换为多块 Markdown，未选中的块保持原样", () => {
    const source: TiptapJsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "甲" }] },
        { type: "paragraph", content: [{ type: "text", text: "乙" }] },
        { type: "paragraph", content: [{ type: "text", text: "丙" }] },
      ],
    };
    const built = buildSelectionRewriteProposedContent(source, {
      selectedText: "甲\n乙",
      replacementText: "## 新标题\n\n新正文",
    });
    expect(built.replacementText).toBe("## 新标题\n\n新正文");
    expect(built.content.content?.map((node) => node.type)).toEqual(["heading", "paragraph", "paragraph"]);
    expect(built.content.content?.[0]).toMatchObject({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "新标题" }],
    });
    expect(built.content.content?.[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "新正文" }],
    });
    expect(built.content.content?.[2]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "丙" }],
    });
  });

  it("跨块选区保留首尾未选中的残段", () => {
    const source: TiptapJsonContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "甲前半末尾" }] },
        { type: "paragraph", content: [{ type: "text", text: "乙后半开头" }] },
      ],
    };
    const built = buildSelectionRewriteProposedContent(source, {
      selectedText: "前半末尾\n乙后半",
      replacementText: "新段落",
    });
    expect(built.content.content?.map((node) => node.content?.[0]?.text)).toEqual(["甲", "新段落", "开头"]);
  });

  it("代码块选区按原文替换并剥离包裹围栏", () => {
    const source: TiptapJsonContent = {
      type: "doc",
      content: [{
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "line1\nline2\nline3" }],
      }],
    };
    const built = buildSelectionRewriteProposedContent(source, {
      selectedText: "line2",
      replacementText: "```ts\nreplaced\n```",
    });
    expect(built.replacementText).toBe("replaced\n");
    expect(built.content.content?.[0]).toMatchObject({
      type: "codeBlock",
      content: [{ type: "text", text: "line1\nreplaced\n\nline3" }],
    });
  });

  it("选区文本在文档中定位失败时报 SELECTION_NOT_FOUND", () => {
    const source: TiptapJsonContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "唯一段落" }] }],
    };
    let caught: unknown;
    try {
      buildSelectionRewriteProposedContent(source, { selectedText: "不存在的文本", replacementText: "替换" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "SELECTION_NOT_FOUND" });
  });
});

describe("共享读凭证与代发（doc-writer-subagent-plan §5.3）", () => {
  it("document_draft 代发的 receipt 与 document_read 签发的满足同一个 requireLatest；未签发仍被拒", async () => {
    const { documents, operations } = await createReviewHarness("shared-read-authority");
    const document = await documents.import({
      id: "doc-shared-reads",
      roomId: "room-1",
      title: "Shared reads target",
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Rewrite this summary." }] },
          { type: "paragraph", content: [{ type: "text", text: "Keep this detailed context unchanged. ".repeat(8) }] },
        ],
      },
    });
    // create-server 同款装配：registry 由共享 authority 构建（builtins 第 4 参）。
    const sharedReads = new DocumentReadAuthority((documentId) => documents.get(documentId) ?? null);
    const registry = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations, sharedReads);
    const targetId = documents.listBlocks(document.id).filter((block) => block.depth === 0)[0]!.blockId;
    const topLevelBlockIds = documents.listBlocks(document.id)
      .filter((block) => block.depth === 0)
      .map((block) => block.blockId);

    // 未签发：patch_begin 直接被 read-authority 拒绝。
    const bareContext = { agentSessionId: "session-proxy", runId: "run-proxy", roomId: "room-1" };
    await expect(registry.execute("context_room_patch_begin", {
      documentId: document.id,
      baseVersion: document.version,
      kind: "edit",
      summary: "should fail without read",
    }, bareContext)).rejects.toThrow(/DOCUMENT_READ_REQUIRED|Read the current document/);

    // document_draft 的代发路径：dispatch 返回后以主 run 名义签发（顶层块集）。
    sharedReads.issue(bareContext, document.id, document.version, topLevelBlockIds);
    const begun = await registry.execute("context_room_patch_begin", {
      documentId: document.id,
      baseVersion: document.version,
      kind: "edit",
      summary: "Replace the summary via proxy receipt",
    }, bareContext);
    const operationId = String(begun.structuredContent.operationId);
    await registry.execute("context_room_patch_hunk", {
      operationId,
      sequence: 1,
      operation: "replace",
      target: { blockId: targetId },
      markdown: "替换后的总结段落。",
    }, bareContext);
    await registry.execute("context_room_patch_commit", { operationId, finalSequence: 1 }, bareContext);
    expect(operations.get(operationId)?.status).toBe("awaiting_review");

    // 跨 run：另一 run 持有同 token 上下文也不满足（receipt 绑定 sessionId+runId）。
    const otherRun = { agentSessionId: "session-proxy", runId: "run-other", roomId: "room-1" };
    await expect(registry.execute("context_room_patch_begin", {
      documentId: document.id,
      baseVersion: document.version,
      kind: "edit",
      summary: "cross run",
    }, otherRun)).rejects.toThrow(/DOCUMENT_READ_REQUIRED|Read the current document/);
  });
});
