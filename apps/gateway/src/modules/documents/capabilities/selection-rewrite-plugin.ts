import { DocumentServiceError } from "../errors.js";
import { contentHash, manifest, type CapabilityBackend } from "./shared.js";
import type { DocumentCapabilityPlugin } from "./types.js";

/** input.invocationId 缺失、未完成、未授权或输出不可用于本文档时的统一错误。 */
function invocationUnauthorized(): DocumentServiceError {
  return new DocumentServiceError(
    "SELECTION_REWRITE_INVOCATION_UNAUTHORIZED",
    "Selection rewrite invocation is missing, unfinished, or not authorized for this document",
    409,
    { retryable: false, nextAction: "rewrite_selection_again" },
  );
}

function resolverUnavailable(): DocumentServiceError {
  return new DocumentServiceError(
    "SELECTION_REWRITE_RESOLVER_UNAVAILABLE",
    "Selection rewrite content resolver is not configured",
    500,
  );
}

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
      if (document.deletedAt) {
        throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
      }
      const baseVersion = request.input.baseVersion;
      if (!Number.isSafeInteger(baseVersion) || baseVersion !== document.version) {
        throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
          currentDocument: document,
        });
      }
      // 改写信任收口（方案 §3.2）：携带 invocationId 时不信任客户端回传的全文，
      // 内容与归因字段改由注入的 resolver 从 invocation 完成态解析；
      // proposedContentJson 保留为迁移兼容路径（存量 in-flight 操作必须能完成）。
      const invocationId = typeof request.input.invocationId === "string"
        ? request.input.invocationId.trim()
        : "";
      // 出路二（预览编辑诚实记账）：用户编辑过预览文本时按用户文本重建内容，
      // 归因记"Agent 提案 + 用户修改"；该覆盖只允许伴随 invocationId 溯源路径，
      // 防止旧路径静默丢弃编辑。
      const userEditedReplacementText = typeof request.input.userEditedReplacementText === "string"
        ? request.input.userEditedReplacementText
        : undefined;
      if (userEditedReplacementText !== undefined && !invocationId) {
        throw new DocumentServiceError(
          "SELECTION_REWRITE_USER_EDIT_REQUIRES_INVOCATION",
          "userEditedReplacementText requires the invocationId provenance path",
          409,
          { retryable: false },
        );
      }
      let proposedContent: unknown;
      let originalText: string;
      let replacementText: string;
      let instruction: string;
      let userModified = false;
      if (invocationId) {
        const resolve = backend.resolveSelectionRewriteContent;
        if (!resolve) throw resolverUnavailable();
        const resolved = resolve({
          invocationId,
          documentId: document.id,
          roomId: document.roomId,
          ...(userEditedReplacementText !== undefined ? { userEditedReplacementText } : {}),
        });
        if (!resolved) throw invocationUnauthorized();
        proposedContent = resolved.contentJson;
        originalText = resolved.originalText;
        replacementText = resolved.replacementText;
        instruction = resolved.instruction;
        userModified = resolved.userModified === true;
      } else {
        proposedContent = request.input.proposedContentJson;
        originalText = typeof request.input.originalText === "string" ? request.input.originalText : "";
        replacementText = typeof request.input.replacementText === "string" ? request.input.replacementText : "";
        instruction = typeof request.input.instruction === "string" ? request.input.instruction : "";
      }
      if (!proposedContent || typeof proposedContent !== "object"
        || (proposedContent as { type?: unknown }).type !== "doc") {
        throw new DocumentServiceError("INVALID_CONTENT", "Selection rewrite requires a complete document body");
      }
      const operationInput: Record<string, unknown> = invocationId
        ? { invocationId, originalText, replacementText, instruction }
        : { proposedContentJson: proposedContent, originalText, replacementText, instruction };
      if (invocationId && userModified && typeof userEditedReplacementText === "string") {
        operationInput.userModified = true;
        operationInput.userEditedReplacementText = userEditedReplacementText;
      }
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
          input: operationInput,
        },
        items: [{
          sequence: 1,
          operation: "replace_selection",
          before: [document.contentJson],
          after: [proposedContent as typeof document.contentJson],
          markdown: replacementText,
          contentHash: contentHash(invocationId
            ? { documentId: document.id, baseVersion, invocationId, proposedContent }
            : { documentId: document.id, baseVersion, proposedContent }),
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
      // 迁移双态：invocationId 操作在 apply 时再次解析并复核授权（防 invocation 被删或状态变化），
      // 存量 in-flight 操作仍使用 start 时记录的 proposedContentJson。
      // 用户编辑过的操作（userModified）用持久化的 userEditedReplacementText 重放，
      // 保证跨重启内容稳定。
      const invocationId = typeof operation.input.invocationId === "string"
        ? operation.input.invocationId.trim()
        : "";
      const userEditedReplacementText = typeof operation.input.userEditedReplacementText === "string"
        ? operation.input.userEditedReplacementText
        : undefined;
      let content: unknown;
      if (invocationId) {
        const resolve = backend.resolveSelectionRewriteContent;
        if (!resolve) throw resolverUnavailable();
        const resolved = resolve({
          invocationId,
          documentId: operation.documentId,
          roomId: operation.roomId,
          ...(userEditedReplacementText !== undefined ? { userEditedReplacementText } : {}),
        });
        if (!resolved) throw invocationUnauthorized();
        content = resolved.contentJson;
      } else {
        content = operation.input.proposedContentJson;
      }
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
