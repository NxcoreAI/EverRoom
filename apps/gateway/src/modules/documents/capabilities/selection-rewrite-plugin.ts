import { DocumentServiceError } from "../errors.js";
import { contentHash, manifest, type CapabilityBackend } from "./shared.js";
import type { DocumentCapabilityPlugin } from "./types.js";

export function selectionRewritePlugin(backend: CapabilityBackend): DocumentCapabilityPlugin {
  return {
    manifest: manifest(
      "document.selection-rewrite",
      "mutation",
      "preview_replace",
      "selection-rewrite",
      true,
      true,
    ),
    promptGuidelines: ["局部选区重写只返回替换文本，用户接受并持久化后才能记录为文档改动。"],
    tools: [],
    start: (request) => {
      const documentId = request.context.documentId;
      const document = documentId ? backend.get(documentId) : null;
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.roomId !== request.context.roomId) {
        throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
      }
      const baseVersion = request.input.baseVersion;
      const proposedContent = request.input.proposedContentJson;
      if (!Number.isSafeInteger(baseVersion) || baseVersion !== document.version) {
        throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
          currentDocument: document,
        });
      }
      if (!proposedContent || typeof proposedContent !== "object"
        || (proposedContent as { type?: unknown }).type !== "doc") {
        throw new DocumentServiceError("INVALID_CONTENT", "Selection rewrite requires a complete document body");
      }
      const originalText = typeof request.input.originalText === "string" ? request.input.originalText : "";
      const replacementText = typeof request.input.replacementText === "string" ? request.input.replacementText : "";
      const instruction = typeof request.input.instruction === "string" ? request.input.instruction : "";
      return {
        operation: {
          capabilityId: "document.selection-rewrite",
          capabilityVersion: 1,
          interactionMode: "preview_replace",
          presenterKey: "selection-rewrite",
          roomId: document.roomId,
          documentId: document.id,
          documentTitle: document.title,
          sessionId: request.context.sessionId,
          runId: request.context.runId,
          baseVersion: document.version,
          status: "running",
          summary: instruction.trim() || "重写选区",
          input: {
            proposedContentJson: proposedContent,
            originalText,
            replacementText,
            instruction,
          },
        },
        items: [{
          sequence: 1,
          operation: "replace_selection",
          before: [document.contentJson],
          after: [proposedContent as typeof document.contentJson],
          markdown: replacementText,
          contentHash: contentHash({ documentId: document.id, baseVersion, proposedContent }),
        }],
      };
    },
    command: async (operation, command) => {
      if (command.type === "review.reject" || command.type === "operation.cancel") {
        return {
          status: command.type === "review.reject" ? "rejected" : "cancelled",
          updateItems: operation.items.map((item) => ({ id: item.id, status: "rejected" as const })),
          complete: true,
        };
      }
      if (command.type !== "review.apply" || !operation.documentId) {
        throw new DocumentServiceError(
          "UNSUPPORTED_OPERATION_COMMAND",
          `Command ${command.type} is not allowed for document.selection-rewrite`,
          409,
        );
      }
      const content = operation.input.proposedContentJson;
      if (!content || typeof content !== "object" || (content as { type?: unknown }).type !== "doc") {
        throw new DocumentServiceError("INVALID_CONTENT", "Selection rewrite content is missing");
      }
      const commit = backend.prepareOperationCommit(operation.documentId, {
        baseVersion: operation.baseVersion ?? 0,
        contentJson: content as typeof operation.items[number]["after"][number],
      });
      return {
        status: "completed",
        result: { version: commit.version },
        updateItems: operation.items.map((item) => ({
          id: item.id,
          status: "applied" as const,
          appliedVersion: commit.version,
        })),
        commit,
        complete: true,
        afterCommit: (document) => document && backend.notifyDocumentRewriteApplied({
          sessionId: operation.sessionId,
          roomId: operation.roomId,
          runId: operation.runId,
          operationId: operation.id,
          documentId: document.id,
          title: document.title,
          instruction: typeof operation.input.instruction === "string"
            ? operation.input.instruction
            : operation.summary,
          originalText: typeof operation.input.originalText === "string" ? operation.input.originalText : "",
          replacementText: typeof operation.input.replacementText === "string" ? operation.input.replacementText : "",
        }),
      };
    },
  };
}
