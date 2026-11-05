import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentInvocation, TiptapJsonContent } from "@nxcore/agent-contract";
import type { DocumentCapabilityPlugin } from "../src/modules/documents/capabilities/types.js";
import { createBuiltinDocumentCapabilityRegistry } from "../src/modules/documents/capabilities/builtins.js";
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
import { DocumentMcpHost } from "../src/modules/documents/mcp-host.js";
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
  // 文稿工具链已下线：builtin registry 现只注册 office 插件；本套件的 registry 机制用例
  // 用自定义插件集合自测，不再依赖 documents backend。
  const registry = new DocumentCapabilityRegistry(operations);
  disposables.push(() => database.sqlite.close());
  return { database, documents, operations, registry };
}

describe("document capability registry", () => {
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
      agentSessionId: "session-1", runId: "run-1",
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
          roomId: null, documentId: request.context.documentId ?? null,
          documentTitle: "Target", sessionId: request.context.sessionId,
          runId: request.context.runId, baseVersion: 1, summary: "Forged",
        },
      }),
    };
    const registry = new DocumentCapabilityRegistry({ create } as never).register(forged);
    await expect(registry.start({
      capabilityId: "document.safe-edit",
      context: { roomId: null, documentId: "doc-1", sessionId: "session-1", runId: "run-1" },
      input: {},
    })).rejects.toMatchObject({ code: "OPERATION_PLAN_INVALID", statusCode: 500 });
    expect(create).not.toHaveBeenCalled();
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
