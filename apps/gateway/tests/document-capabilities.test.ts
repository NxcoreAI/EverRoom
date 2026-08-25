import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentCapabilityPlugin } from "../src/modules/documents/capabilities/types.js";
import { createBuiltinDocumentCapabilityRegistry } from "../src/modules/documents/capabilities/builtins.js";
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

  it("tells document creation agents to keep the page title out of the Markdown body", () => {
    const registry = createBuiltinDocumentCapabilityRegistry({} as never);

    expect(registry.promptGuidelines().join(" ")).toMatch(
      /title 是唯一页面标题.*append 只能生成正文.*正文主章节从 ## 开始.*2\.1 使用 ###/,
    );
    expect(registry.promptGuidelines().join(" ")).toMatch(
      /目标读者.*连贯提纲.*简短引言.*围栏标注语言.*提交前通读全文.*重复.*矛盾/,
    );
    expect(registry.promptGuidelines().join(" ")).toMatch(
      /Markdown 表格.*连续.*完整.*列数一致.*禁止输出空表.*全空行.*重复分隔线/,
    );
    expect(registry.listTools().find((tool) => tool.name === "context_room_write_append")?.description)
      .toMatch(/title.*页面顶部 H1.*不属于 Markdown 正文.*任何一级标题.*2\.1.*###/);
    expect(registry.listTools().find((tool) => tool.name === "context_room_write_append")?.description)
      .toMatch(/一小段引言.*标题必须唯一.*代码块标注语言.*链接.*表格/);
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
