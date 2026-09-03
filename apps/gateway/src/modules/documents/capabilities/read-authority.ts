import { randomUUID } from "node:crypto";
import { DocumentServiceError } from "../errors.js";
import type { DocumentExecutionContext } from "./types.js";

const READ_RECEIPT_TTL_MS = 10 * 60 * 1000;

interface DocumentReadReceipt {
  token: string;
  sessionId: string;
  runId: string;
  roomId: string;
  documentId: string;
  version: number;
  blockIds: ReadonlySet<string>;
  expiresAt: Date;
}

type ReadableDocument = { deletedAt?: string | null };

export class DocumentReadAuthority {
  private readonly receipts = new Map<string, DocumentReadReceipt>();

  constructor(
    private readonly findDocument?: (documentId: string) => ReadableDocument | null,
  ) {}

  issue(
    context: DocumentExecutionContext,
    documentId: string,
    version: number,
    blockIds: Iterable<string>,
  ): { readReceipt: string; expiresAt: string } {
    if (!context.roomId) {
      throw new DocumentServiceError("ROOM_SELECTION_REQUIRED", "Select a Context Room first", 409);
    }
    this.assertReadable(documentId);
    this.prune();
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + READ_RECEIPT_TTL_MS);
    this.receipts.set(token, {
      token,
      sessionId: context.agentSessionId,
      runId: context.runId,
      roomId: context.roomId,
      documentId,
      version,
      blockIds: new Set(blockIds),
      expiresAt,
    });
    return { readReceipt: token, expiresAt: expiresAt.toISOString() };
  }

  require(
    token: string,
    context: DocumentExecutionContext,
    documentId: string,
    version: number,
  ): DocumentReadReceipt {
    this.prune();
    this.assertReadable(documentId);
    const receipt = this.receipts.get(token);
    if (!receipt
      || receipt.sessionId !== context.agentSessionId
      || receipt.runId !== context.runId
      || receipt.roomId !== context.roomId
      || receipt.documentId !== documentId
      || receipt.version !== version) {
      throw new DocumentServiceError(
        "DOCUMENT_READ_REQUIRED",
        "Read the current document in this Agent run before starting or continuing a patch",
        409,
        {
          documentId,
          currentVersion: version,
          retryable: true,
          nextAction: "context_room_document_read",
        },
      );
    }
    return receipt;
  }

  requireLatest(
    context: DocumentExecutionContext,
    documentId: string,
    version: number,
  ): DocumentReadReceipt {
    this.prune();
    this.assertReadable(documentId);
    const receipt = [...this.receipts.values()].reverse().find((candidate) =>
      candidate.sessionId === context.agentSessionId
      && candidate.runId === context.runId
      && candidate.roomId === context.roomId
      && candidate.documentId === documentId
      && candidate.version === version);
    if (!receipt) {
      throw new DocumentServiceError(
        "DOCUMENT_READ_REQUIRED",
        "Read the current document in this Agent run before starting or continuing a patch",
        409,
        {
          documentId,
          currentVersion: version,
          retryable: true,
          nextAction: "context_room_document_read",
        },
      );
    }
    return receipt;
  }

  /** 本 run 读过的文档（按 documentId 去重，保留最新版本）——供 document_draft 兜底推断素材来源。 */
  documentsReadByRun(runId: string): Array<{ roomId: string; documentId: string; version: number }> {
    this.prune();
    const seen = new Map<string, { roomId: string; documentId: string; version: number }>();
    for (const receipt of this.receipts.values()) {
      if (receipt.runId !== runId) continue;
      const existing = seen.get(receipt.documentId);
      if (!existing || existing.version < receipt.version) {
        seen.set(receipt.documentId, {
          roomId: receipt.roomId,
          documentId: receipt.documentId,
          version: receipt.version,
        });
      }
    }
    return [...seen.values()];
  }

  assertTargets(receipt: DocumentReadReceipt, blockIds: Iterable<string>): void {
    const invalidBlockIds = [...blockIds].filter((blockId) => !receipt.blockIds.has(blockId));
    if (!invalidBlockIds.length) return;
    throw new DocumentServiceError(
      "PATCH_TARGET_NOT_IN_READ_SNAPSHOT",
      "Patch target was not returned by the current run's document read",
      409,
      {
        documentId: receipt.documentId,
        currentVersion: receipt.version,
        invalidBlockIds,
        retryable: true,
        nextAction: "context_room_document_read",
      },
    );
  }

  private prune(now = Date.now()): void {
    for (const [token, receipt] of this.receipts) {
      if (receipt.expiresAt.getTime() <= now) this.receipts.delete(token);
    }
  }

  private assertReadable(documentId: string): void {
    const document = this.findDocument?.(documentId);
    if (!this.findDocument || document) {
      if (document?.deletedAt) {
        throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409, {
          documentId,
          retryable: false,
        });
      }
      return;
    }
    throw new DocumentServiceError("NOT_FOUND", "Document not found", 404, { documentId });
  }
}
