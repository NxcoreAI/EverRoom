import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { parseImportedMarkdown } from "../src/modules/documents/agent-markdown.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { documentRoutes } from "../src/modules/documents/routes.js";
import { DocumentService } from "../src/modules/documents/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GET /v1/documents/:id/markdown", () => {
  it("serializes the document body with the canonical markdown serializer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "everroom-document-markdown-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const documents = new DocumentService(database.db, new DocumentEventBroker());
    const app = Fastify();
    await app.register(documentRoutes(documents));
    const imported = await documents.import({
      id: "doc-markdown-1",
      roomId: "room-1",
      title: "Idea",
      contentJson: parseImportedMarkdown("# Idea\n\nFirst paragraph\n\n- a\n- b\n"),
    });

    const response = await app.inject({ method: "GET", url: `/v1/documents/${imported.id}/markdown` });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.documentId).toBe(imported.id);
    // H1 被导入路径收编成文档标题，正文序列化不再重复输出标题。
    expect(payload.markdown).toBe("First paragraph\n\n- a\n- b");
    database.sqlite.close();
    await app.close();
  });

  it("returns 404 for unknown documents", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "everroom-document-markdown-"));
    temporaryDirectories.push(dataDir);
    const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    const documents = new DocumentService(database.db, new DocumentEventBroker());
    const app = Fastify();
    await app.register(documentRoutes(documents));

    const response = await app.inject({ method: "GET", url: "/v1/documents/missing-doc/markdown" });
    expect(response.statusCode).toBe(404);
    database.sqlite.close();
    await app.close();
  });
});
