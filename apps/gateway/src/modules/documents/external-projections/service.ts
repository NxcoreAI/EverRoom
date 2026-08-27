import { createHash, randomUUID } from "node:crypto";
import type {
  CompleteExternalDocumentPatchInput,
  DocumentOperationCommandResult,
  ExternalDocumentProjectionBinding,
  PreparedExternalDocumentPatch,
  PrepareExternalDocumentPatchInput,
  SyncExternalDocumentProjectionInput,
} from "@nxcore/agent-contract";
import { and, eq, lt } from "drizzle-orm";
import { applyPatch, createTwoFilesPatch } from "diff";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  externalDocumentBindings,
  externalDocumentPatchPreparations,
} from "../../../infrastructure/database/schema.js";
import { agentDocumentMarkdown } from "../agent-markdown.js";
import { documentBodyContent } from "../content-model.js";
import type { DocumentCapabilityRegistry } from "../capabilities/registry.js";
import type { DocumentOperationService } from "../operations/service.js";
import { DocumentServiceError, type DocumentService } from "../service.js";

const PREPARATION_TTL_MS = 5 * 60_000;

type BindingRow = typeof externalDocumentBindings.$inferSelect;

function binding(row: BindingRow): ExternalDocumentProjectionBinding {
  return {
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    resourceId: row.resourceId,
    roomId: row.roomId,
    documentId: row.documentId,
    relativePath: row.relativePath,
    sourceHash: row.sourceHash,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stableDocumentId(input: Pick<SyncExternalDocumentProjectionInput, "sourceKind" | "sourceId" | "resourceId">): string {
  const digest = createHash("sha256")
    .update(`${input.sourceKind}\0${input.sourceId}\0${input.resourceId}`)
    .digest("hex")
    .slice(0, 40);
  return `external-document-${digest}`;
}

export class ExternalDocumentProjectionService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly documents: DocumentService,
    private readonly operations: DocumentOperationService,
    private readonly capabilities: DocumentCapabilityRegistry,
  ) {}

  async sync(input: SyncExternalDocumentProjectionInput): Promise<ExternalDocumentProjectionBinding> {
    const existing = this.findSource(input.sourceKind, input.sourceId, input.resourceId);
    const documentId = existing?.documentId ?? stableDocumentId(input);
    if (existing && existing.roomId !== input.roomId) {
      throw new DocumentServiceError("ROOM_MISMATCH", "External document belongs to another Room", 409);
    }
    if (existing && existing.sourceHash !== input.sourceHash) {
      const current = this.documents.get(documentId);
      if (current) this.operations.conflictOtherActive(documentId, current.version + 1);
    }
    await this.documents.syncExternalMarkdown({
      documentId,
      roomId: input.roomId,
      title: input.title,
      markdown: input.markdown,
    });
    const now = new Date();
    this.db.insert(externalDocumentBindings).values({
      documentId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      resourceId: input.resourceId,
      roomId: input.roomId,
      relativePath: input.relativePath,
      sourceHash: input.sourceHash,
      projectedMarkdown: input.markdown,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: externalDocumentBindings.documentId,
      set: {
        relativePath: input.relativePath,
        sourceHash: input.sourceHash,
        projectedMarkdown: input.markdown,
        updatedAt: now,
      },
    }).run();
    return binding(this.requireDocument(documentId));
  }

  getByDocument(documentId: string): ExternalDocumentProjectionBinding | null {
    const row = this.db.select().from(externalDocumentBindings)
      .where(eq(externalDocumentBindings.documentId, documentId)).get();
    return row ? binding(row) : null;
  }

  getOperation(operationId: string) {
    return this.operations.get(operationId);
  }

  getOperationForPreparation(preparationId: string) {
    const preparation = this.db.select({ operationId: externalDocumentPatchPreparations.operationId })
      .from(externalDocumentPatchPreparations)
      .where(eq(externalDocumentPatchPreparations.id, preparationId)).get();
    return preparation ? this.operations.get(preparation.operationId) : null;
  }

  async remove(sourceKind: "obsidian-vault", sourceId: string, resourceId?: string): Promise<number> {
    const rows = this.db.select().from(externalDocumentBindings).where(and(
      eq(externalDocumentBindings.sourceKind, sourceKind),
      eq(externalDocumentBindings.sourceId, sourceId),
      ...(resourceId ? [eq(externalDocumentBindings.resourceId, resourceId)] : []),
    )).all();
    for (const row of rows) await this.removeDocument(row.documentId);
    return rows.length;
  }

  async removeDocument(documentId: string): Promise<void> {
    this.requireDocument(documentId);
    const document = this.documents.get(documentId);
    if (!document) return;
    if (!document.deletedAt) await this.documents.delete(documentId);
    await this.documents.deletePermanently(documentId);
  }

  async prepare(input: PrepareExternalDocumentPatchInput): Promise<PreparedExternalDocumentPatch> {
    this.expirePreparations();
    const operation = this.operations.get(input.operationId);
    if (!operation) throw new DocumentServiceError("OPERATION_NOT_FOUND", "Document operation not found", 404);
    if (operation.status !== "awaiting_review" || !operation.documentId) {
      throw new DocumentServiceError("OPERATION_NOT_REVIEWABLE", "Document operation is not awaiting review", 409);
    }
    if (operation.revision !== input.command.expectedRevision) {
      throw new DocumentServiceError("OPERATION_REVISION_CONFLICT", "Document operation has changed", 409, {
        currentOperation: operation,
      });
    }
    if (input.command.type !== "review.apply" && input.command.type !== "item.accept") {
      throw new DocumentServiceError("UNSUPPORTED_OPERATION_COMMAND", "Only accepted Vault patches can be prepared", 409);
    }
    const existingPreparation = this.db.select().from(externalDocumentPatchPreparations).where(and(
      eq(externalDocumentPatchPreparations.operationId, operation.id),
      eq(externalDocumentPatchPreparations.commandId, input.command.commandId),
    )).get();
    if (existingPreparation) return this.preparedResult(existingPreparation);

    const source = this.requireDocument(operation.documentId);
    const mutation = await this.capabilities.command(operation, input.command);
    if (!mutation.commit) {
      throw new DocumentServiceError("VAULT_PATCH_REQUIRED", "The accepted operation does not produce a Vault document patch", 409);
    }
    const current = this.documents.get(operation.documentId);
    if (!current) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
    const before = agentDocumentMarkdown.serialize(documentBodyContent(current.contentJson));
    const after = agentDocumentMarkdown.serialize(documentBodyContent(mutation.commit.content));
    const patch = createTwoFilesPatch(source.relativePath, source.relativePath, before, after, "projected", "prepared", {
      context: 4,
    });
    const preparedMarkdown = before === after
      ? source.projectedMarkdown
      : applyPatch(source.projectedMarkdown, patch, { fuzzFactor: 3 });
    if (preparedMarkdown === false) {
      throw new DocumentServiceError(
        "VAULT_PATCH_UNSAFE",
        "The reviewed patch could not be applied to the original Markdown without reserializing it",
        409,
        { retryable: false, nextAction: "review_in_obsidian" },
      );
    }
    const now = new Date();
    const preparation = {
      id: `external-patch-${randomUUID()}`,
      operationId: operation.id,
      commandId: input.command.commandId,
      expectedRevision: input.command.expectedRevision,
      command: input.command,
      expectedSourceHash: source.sourceHash,
      patch,
      preparedMarkdown,
      status: "pending" as const,
      resultingSourceHash: null,
      expiresAt: new Date(now.getTime() + PREPARATION_TTL_MS),
      createdAt: now,
      completedAt: null,
    };
    this.db.insert(externalDocumentPatchPreparations).values(preparation).run();
    return this.preparedResult(preparation);
  }

  async complete(input: CompleteExternalDocumentPatchInput): Promise<DocumentOperationCommandResult> {
    const preparation = this.db.select().from(externalDocumentPatchPreparations)
      .where(eq(externalDocumentPatchPreparations.id, input.preparationId)).get();
    if (!preparation) throw new DocumentServiceError("VAULT_PATCH_PREPARATION_NOT_FOUND", "Vault patch preparation not found", 404);
    if (preparation.status === "completed"
      && preparation.resultingSourceHash
      && preparation.resultingSourceHash !== input.resultingSourceHash) {
      throw new DocumentServiceError("VAULT_PATCH_ALREADY_COMPLETED", "Vault patch was completed with another source hash", 409);
    }
    if (preparation.status === "pending" && preparation.expiresAt.getTime() <= Date.now()) {
      throw new DocumentServiceError("VAULT_PATCH_PREPARATION_EXPIRED", "Vault patch preparation expired", 409);
    }
    const operation = this.operations.get(preparation.operationId);
    if (!operation
      || operation.roomId !== input.context.roomId
      || operation.sessionId !== input.context.sessionId
      || operation.runId !== input.context.runId) {
      throw new DocumentServiceError("OPERATION_FORBIDDEN", "Operation belongs to another Agent run", 403);
    }
    const result = await this.operations.execute(
      preparation.operationId,
      preparation.command,
      (operation, command) => this.capabilities.command(operation, command),
    );
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(externalDocumentPatchPreparations).set({
        status: "completed",
        resultingSourceHash: input.resultingSourceHash,
        completedAt: now,
      }).where(eq(externalDocumentPatchPreparations.id, preparation.id)).run();
      const operation = result.operation;
      if (operation.documentId) {
        tx.update(externalDocumentBindings).set({
          sourceHash: input.resultingSourceHash,
          projectedMarkdown: preparation.preparedMarkdown,
          updatedAt: now,
        }).where(eq(externalDocumentBindings.documentId, operation.documentId)).run();
      }
    });
    return result;
  }

  private findSource(sourceKind: "obsidian-vault", sourceId: string, resourceId: string): BindingRow | undefined {
    return this.db.select().from(externalDocumentBindings).where(and(
      eq(externalDocumentBindings.sourceKind, sourceKind),
      eq(externalDocumentBindings.sourceId, sourceId),
      eq(externalDocumentBindings.resourceId, resourceId),
    )).get();
  }

  private requireDocument(documentId: string): BindingRow {
    const row = this.db.select().from(externalDocumentBindings)
      .where(eq(externalDocumentBindings.documentId, documentId)).get();
    if (!row) throw new DocumentServiceError("EXTERNAL_DOCUMENT_NOT_FOUND", "External document binding not found", 404);
    return row;
  }

  private preparedResult(row: typeof externalDocumentPatchPreparations.$inferSelect | {
    id: string;
    operationId: string;
    expectedSourceHash: string;
    patch: string;
    preparedMarkdown: string;
    expiresAt: Date;
  }): PreparedExternalDocumentPatch {
    const operation = this.operations.get(row.operationId);
    if (!operation?.documentId) throw new DocumentServiceError("OPERATION_NOT_FOUND", "Document operation not found", 404);
    const source = this.requireDocument(operation.documentId);
    return {
      preparationId: row.id,
      operationId: operation.id,
      documentId: operation.documentId,
      sourceId: source.sourceId,
      resourceId: source.resourceId,
      relativePath: source.relativePath,
      expectedSourceHash: row.expectedSourceHash,
      markdown: row.preparedMarkdown,
      patch: row.patch,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  private expirePreparations(): void {
    this.db.delete(externalDocumentPatchPreparations).where(and(
      eq(externalDocumentPatchPreparations.status, "pending"),
      lt(externalDocumentPatchPreparations.expiresAt, new Date()),
    )).run();
  }
}
