import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentServiceError } from "../src/modules/documents/errors.js";
import { collectDocumentReferences } from "../src/modules/documents/content-model.js";
import { documentRoutes } from "../src/modules/documents/routes.js";
import { DocumentService } from "../src/modules/documents/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-block-references-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new DocumentService(db, new DocumentEventBroker());
  return { db, sqlite, service };
}

function blockReferenceNode(attrs: Record<string, unknown>) {
  return { type: "documentBlockReference", attrs };
}

describe("collectDocumentReferences（Room 已删除）", () => {
  it("缺 targetRoomId 不再抛 INVALID_BLOCK_REFERENCE，默认写工作区频道 sentinel", () => {
    const content = {
      type: "doc",
      content: [blockReferenceNode({ targetDocumentId: "doc-2", targetBlockId: "block-7" })],
    };
    expect(collectDocumentReferences(content as never)).toEqual([
      { roomId: WORKSPACE_DOCUMENT_CHANNEL, documentId: "doc-2", blockId: "block-7" },
    ]);
  });

  it("旧数据里带 targetRoomId 的引用原样保留", () => {
    const content = {
      type: "doc",
      content: [blockReferenceNode({ targetRoomId: "room-1", targetDocumentId: "doc-2", targetBlockId: "block-7" })],
    };
    expect(collectDocumentReferences(content as never)).toEqual([
      { roomId: "room-1", documentId: "doc-2", blockId: "block-7" },
    ]);
  });

  it("targetDocumentId / targetBlockId 仍然必填", () => {
    for (const attrs of [
      { targetBlockId: "block-7" },
      { targetDocumentId: "doc-2" },
    ]) {
      const content = { type: "doc", content: [blockReferenceNode(attrs)] };
      expect(() => collectDocumentReferences(content as never)).toThrow(DocumentServiceError);
      try {
        collectDocumentReferences(content as never);
      } catch (error) {
        expect((error as DocumentServiceError).code).toBe("INVALID_BLOCK_REFERENCE");
      }
    }
  });
});

describe("POST /v1/document-blocks/resolve（roomId 可省略）", () => {
  it("省略 sourceRoomId / references[].roomId 时按工作区 scope 归一，返回仍是旧形状", async () => {
    const { sqlite, service } = await harness();
    const document = await service.import({
      id: "doc-workspace",
      roomId: null,
      title: "工作区文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }] },
    });
    const blockId = service.listBlocks(document.id)[0]!.blockId;
    const app = Fastify();
    await app.register(documentRoutes(service));

    const response = await app.inject({
      method: "POST",
      url: "/v1/document-blocks/resolve",
      payload: { references: [{ documentId: document.id, blockId }] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { resolutions: Array<Record<string, unknown>> };
    expect(body.resolutions).toHaveLength(1);
    expect(body.resolutions[0]).toMatchObject({
      roomId: WORKSPACE_DOCUMENT_CHANNEL,
      documentId: document.id,
      blockId,
      status: "available",
    });
    expect(body.resolutions[0]).toHaveProperty("title");
    expect(body.resolutions[0]).toHaveProperty("version");
    await app.close();
    sqlite.close();
  });

  it("旧桌面携带 sourceRoomId + references[].roomId 仍按原值返回；引用缺 documentId 时 400", async () => {
    const { sqlite, service } = await harness();
    const document = await service.import({
      id: "doc-legacy",
      roomId: "room-1",
      title: "旧房文档",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "旧正文" }] }] },
    });
    const blockId = service.listBlocks(document.id)[0]!.blockId;
    const app = Fastify();
    await app.register(documentRoutes(service));

    const legacy = await app.inject({
      method: "POST",
      url: "/v1/document-blocks/resolve",
      payload: {
        sourceRoomId: "room-1",
        references: [{ roomId: "room-1", documentId: document.id, blockId }],
      },
    });
    expect(legacy.statusCode).toBe(200);
    const legacyBody = legacy.json() as { resolutions: Array<Record<string, unknown>> };
    expect(legacyBody.resolutions[0]?.roomId).toBe("room-1");

    // references[].roomId 显式 null 也归一为工作区 sentinel。
    const nullable = await app.inject({
      method: "POST",
      url: "/v1/document-blocks/resolve",
      payload: { references: [{ roomId: null, documentId: document.id, blockId }] },
    });
    expect(nullable.statusCode).toBe(200);
    expect((nullable.json() as { resolutions: Array<Record<string, unknown>> }).resolutions[0]?.roomId)
      .toBe(WORKSPACE_DOCUMENT_CHANNEL);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/document-blocks/resolve",
      payload: { references: [{ blockId }] },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
    sqlite.close();
  });
});
