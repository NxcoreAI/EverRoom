import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { filesRoutes } from "../src/modules/files/routes.js";
import { fileEntries } from "../src/infrastructure/database/schema.js";

const temporaryDirectories: string[] = [];
const databases: ReturnType<typeof createDatabase>[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-files-purge-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const service = new FilesService(database.db, dataDir);
  const insert = (values: {
    id: string;
    sourceKind: "local-folder" | "connector";
    sourceKey: string;
    localSourceId?: string;
    connectionId?: string;
  }) =>
    database.db.insert(fileEntries).values({
      id: values.id,
      sourceKind: values.sourceKind,
      sourceKey: values.sourceKey,
      originalName: "a.md",
      displayName: null,
      extension: ".md",
      ...(values.localSourceId ? { localSourceId: values.localSourceId, localItemId: `${values.id}-item` } : {}),
      ...(values.connectionId ? { connectionId: values.connectionId } : {}),
      state: "ready",
    }).run();
  return { database, service, insert };
}

describe("FilesService.purgeLocalSource", () => {
  it("双锚点命中该源全部条目（localSourceId + connector connectionId），他源不受影响", async () => {
    const s = await setup();
    s.insert({ id: "f1", sourceKind: "local-folder", sourceKey: "local:srcA:i1", localSourceId: "srcA" });
    s.insert({ id: "f2", sourceKind: "connector", sourceKey: "connector:github:srcA:r1", connectionId: "srcA" });
    s.insert({ id: "f3", sourceKind: "local-folder", sourceKey: "local:srcB:i1", localSourceId: "srcB" });
    s.insert({ id: "f4", sourceKind: "connector", sourceKey: "connector:github:srcB:r1", connectionId: "srcB" });
    const result = await s.service.purgeLocalSource("srcA");
    expect(result).toEqual({ entries: 2 });
    const remaining = s.database.db.select({ id: fileEntries.id }).from(fileEntries).all().map((row) => row.id).sort();
    expect(remaining).toEqual(["f3", "f4"]);
  });

  it("未知源为 no-op", async () => {
    const s = await setup();
    await expect(s.service.purgeLocalSource("nope")).resolves.toEqual({ entries: 0 });
  });

  it("DELETE /v1/local-file-references 返回清掉的条目数", async () => {
    const s = await setup();
    s.insert({ id: "f1", sourceKind: "local-folder", sourceKey: "local:srcA:i1", localSourceId: "srcA" });
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(filesRoutes(s.service));
    const response = await app.inject({ method: "DELETE", url: "/v1/local-file-references?localSourceId=srcA" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ entries: 1 });
    const missing = await app.inject({ method: "DELETE", url: "/v1/local-file-references" });
    expect(missing.statusCode).toBe(400);
  });
});
