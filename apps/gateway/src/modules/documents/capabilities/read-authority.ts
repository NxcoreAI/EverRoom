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

export class DocumentReadAuthority {
  private readonly receipts = new Map<string, DocumentReadReceipt>();

  issue(
    context: DocumentExecutionContext,
    documentId: string,
    version: number,
    blockIds: Iterable<string>,
  ): { readReceipt: string; expiresAt: string } {
    if (!context.roomId) {
      throw new DocumentServiceError("ROOM_SELECTION_REQUIRED", "Select a Context Room first", 409);
    }
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
}
