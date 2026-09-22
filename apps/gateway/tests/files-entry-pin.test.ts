import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { filesRoutes } from "../src/modules/files/routes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-files-entry-pin-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new FilesService(database.db, dataDir);
  service.initializeCatalog();
  return { ...database, service, dataDir };
}

describe("file imports pinned by fileEntryId", () => {
  it("appends a new version to the pinned entry regardless of sourceKey", async () => {
    const test = await serviceForTest();
    const created = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:gen:1", originalName: "draft.docx",
      buffer: Buffer.from("v1"),
    });
    // 换一个 sourceKey：钉住条目后仍必须落回同一条目，而不是开新条目。
    const edited = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:edit:file-x", originalName: "draft.docx",
      buffer: Buffer.from("v2"), fileEntryId: created.fileEntryId,
    });
    expect(edited.fileEntryId).toBe(created.fileEntryId);
    expect(edited.versionDeduped).toBe(false);
    const versions = test.sqlite
      .prepare("SELECT version_no FROM file_versions WHERE file_entry_id = ? ORDER BY version_no")
      .all(created.fileEntryId) as { version_no: number }[];
    expect(versions).toEqual([{ version_no: 1 }, { version_no: 2 }]);
    const entry = test.sqlite
      .prepare("SELECT current_version_id FROM file_entries WHERE id = ?")
      .get(created.fileEntryId) as { current_version_id: string };
    expect(entry.current_version_id).toBe(edited.fileVersionId);
    expect(test.service.listCatalog().total).toBe(1);
    test.sqlite.close();
  });

  it("dedupes identical content re-imported with the same pin", async () => {
    const test = await serviceForTest();
    const buffer = Buffer.from("same");
    const created = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:gen:2", originalName: "same.docx", buffer,
    });
    const again = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:edit:file-y", originalName: "same.docx",
      buffer, fileEntryId: created.fileEntryId,
    });
    expect(again.fileEntryId).toBe(created.fileEntryId);
    expect(again.fileVersionId).toBe(created.fileVersionId);
    expect(again.versionDeduped).toBe(true);
    test.sqlite.close();
  });

  it("rejects an unknown pin with the sentinel error", async () => {
    const test = await serviceForTest();
    await expect(test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:edit:missing", originalName: "x.docx",
      buffer: Buffer.from("x"), fileEntryId: "file-does-not-exist",
    })).rejects.toThrow("file_entry_not_found");
    test.sqlite.close();
  });

  it("keeps (sourceKind, sourceKey) grouping when no pin is provided", async () => {
    const test = await serviceForTest();
    const first = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:gen:3", originalName: "chain.docx",
      buffer: Buffer.from("a"),
    });
    const second = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:gen:3", originalName: "chain.docx",
      buffer: Buffer.from("b"),
    });
    expect(second.fileEntryId).toBe(first.fileEntryId);
    expect(second.versionDeduped).toBe(false);
    const stranger = await test.service.importFile({
      sourceKind: "agent-generated", sourceKey: "agent:word:gen:other", originalName: "chain.docx",
      buffer: Buffer.from("c"),
    });
    expect(stranger.fileEntryId).not.toBe(first.fileEntryId);
    test.sqlite.close();
  });

  it("maps the missing-pin sentinel to 422 at the route layer", async () => {
    const test = await serviceForTest();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(filesRoutes(test.service));
    const form = new FormData();
    form.append("metadata", JSON.stringify({
      sourceKind: "agent-generated", sourceKey: "agent:word:edit:route-miss",
      originalName: "route.docx", fileEntryId: "file-not-there",
    }));
    form.append("file", new Blob(["route"]), "route.docx");
    const response = await app.inject({ method: "POST", url: "/v1/file-imports", payload: form });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "file_entry_not_found" });
    await app.close();
    test.sqlite.close();
  });
});
