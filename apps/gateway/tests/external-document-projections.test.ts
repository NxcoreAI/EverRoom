import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { createBuiltinDocumentCapabilityRegistry } from "../src/modules/documents/capabilities/builtins.js";
import { ExternalDocumentProjectionService } from "../src/modules/documents/external-projections/service.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentOperationService } from "../src/modules/documents/operations/service.js";
import { DocumentService } from "../src/modules/documents/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "everroom-external-projection-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const broker = new DocumentEventBroker();
  const documents = new DocumentService(database.db, broker);
  const operations = new DocumentOperationService(database.db, broker);
  const capabilities = createBuiltinDocumentCapabilityRegistry(documents, undefined, operations);
  const projections = new ExternalDocumentProjectionService(database.db, documents, operations, capabilities);
  return { database, documents, operations, capabilities, projections };
}

describe("external document projections", () => {
  it("keeps stable document identity across path changes and removes the projection", async () => {
    const { database, projections } = await harness();
    const first = await projections.sync({
      sourceKind: "obsidian-vault",
      sourceId: "vault-1",
      resourceId: "note-1",
      roomId: "room-1",
      relativePath: "Notes/Idea.md",
      sourceHash: "a".repeat(64),
      title: "Idea",
      markdown: "# Idea\n\nFirst",
    });
    const moved = await projections.sync({
      sourceKind: "obsidian-vault",
      sourceId: "vault-1",
      resourceId: "note-1",
      roomId: "room-1",
      relativePath: "Archive/Idea.md",
      sourceHash: "a".repeat(64),
      title: "Idea",
      markdown: "# Idea\n\nFirst",
    });

    expect(moved.documentId).toBe(first.documentId);
    expect(moved.relativePath).toBe("Archive/Idea.md");
    await expect(projections.remove("obsidian-vault", "vault-1", "note-1")).resolves.toBe(1);
    expect(projections.getByDocument(first.documentId)).toBeNull();
    database.sqlite.close();
  });

  it("prepares a raw Markdown patch and completes the operation only after source confirmation", async () => {
    const { database, documents, capabilities, projections } = await harness();
    const sourceHash = "b".repeat(64);
    const binding = await projections.sync({
      sourceKind: "obsidian-vault",
      sourceId: "vault-1",
      resourceId: "note-1",
      roomId: "room-1",
      relativePath: "Idea.md",
      sourceHash,
      title: "Idea",
      markdown: "---\nplugin: keep-me\n---\n\n# Idea\n\nBefore\n",
    });
    const current = documents.get(binding.documentId)!;
    const proposed = structuredClone(current.contentJson);
    const text = proposed.content?.flatMap((node) => node.content ?? [])
      .find((node) => node.type === "text" && node.text === "Before");
    if (!text) throw new Error("fixture text not found");
    text.text = "After";
    const operation = await capabilities.start({
      capabilityId: "document.selection-rewrite",
      context: {
        roomId: "room-1",
        documentId: binding.documentId,
        sessionId: "session-1",
        runId: "run-1",
      },
      input: {
        baseVersion: current.version,
        proposedContentJson: proposed,
        originalText: "Before",
        replacementText: "After",
        instruction: "Rewrite",
      },
    });
    const command = {
      commandId: "accept-vault-1",
      expectedRevision: operation.revision,
      type: "review.apply",
      context: { roomId: "room-1", sessionId: "session-1", runId: "run-1" },
    };

    const prepared = await projections.prepare({ operationId: operation.id, command });

    expect(prepared.markdown).toContain("plugin: keep-me");
    expect(prepared.markdown).toContain("After");
    expect(documents.get(binding.documentId)?.version).toBe(current.version);
    expect(projections.getOperation(operation.id)?.status).toBe("awaiting_review");

    const completed = await projections.complete({
      preparationId: prepared.preparationId,
      resultingSourceHash: "c".repeat(64),
      context: command.context,
    });

    expect(completed.operation.status).toBe("completed");
    expect(documents.get(binding.documentId)?.version).toBe(current.version + 1);
    expect(projections.getByDocument(binding.documentId)?.sourceHash).toBe("c".repeat(64));
    database.sqlite.close();
  });
});
