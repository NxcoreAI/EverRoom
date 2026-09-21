import { DocumentServiceError } from "../errors.js";
import { annotations, manifest, type CapabilityBackend } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool } from "./types.js";

/**
 * 文档删除（#242）：无状态 mutation 插件，向主 agent 暴露
 * context_room_document_delete。语义与桌面端手动删除一致——移入回收站
 * （trash，可恢复）；索引/记忆引用的物理清理仍由既有的 permanent 删除
 * outbox 通道负责，不在这里提前。防误删：必须显式传 confirm=true，
 * 且仅允许响应用户明确的删除请求。
 * 事件面：trash 落库时 lifecycle hooks 会发 document.changed（deletedAt 已置），
 * 桌面文档列表据此把文档从活动列表移入回收站列表；不要补发 document.deleted——
 * 那是「彻底删除」的语义（渲染端会连回收站列表一起清掉）。
 */

const MAX_REASON_LENGTH = 500;

export function deletePlugin(backend: CapabilityBackend): DocumentCapabilityPlugin {
  const documentDelete: DocumentCapabilityTool = {
    name: "context_room_document_delete",
    title: "删除 Room 文档（移入回收站）",
    description: "把当前 Room 的一篇文档移入回收站（可恢复）。只能在用户明确要求删除该文档时调用，"
      + "且必须传 confirm=true 表示已与用户确认目标文档；无法确定用户指哪篇时先用 "
      + "context_room_document_list 列出标题与用户核对。删除成功后在回复中明确告知用户"
      + "删除了哪篇文档、可从回收站恢复。不要批量删除，除非用户逐一点名。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string", minLength: 1, maxLength: 128 },
        confirm: { type: "boolean", description: "必须为 true：表示已与用户确认要删除这篇文档" },
        reason: { type: "string", minLength: 1, maxLength: MAX_REASON_LENGTH },
      },
      required: ["documentId", "confirm"],
    },
    annotations: annotations(false, true),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const documentId = stringArg(args, "documentId");
      const reason = typeof args.reason === "string" && args.reason.trim()
        ? args.reason.trim().slice(0, MAX_REASON_LENGTH)
        : null;
      // 防误删闸门：confirm 必须显式为 true；缺省/false 一律拒绝并引导与用户确认。
      if (args.confirm !== true) {
        throw new DocumentServiceError("DOCUMENT_DELETE_CONFIRM_REQUIRED",
          "删除文档需要先与用户确认：请向用户复述目标文档标题，确认后携带 confirm=true 重试", 409, {
            retryable: true,
            nextAction: "ask_user_for_confirmation",
          });
      }
      const document = backend.get(documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.roomId !== context.roomId) throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is already in trash", 409);

      await backend.delete(documentId);
      const trashed = backend.get(documentId);

      return success({
        documentId,
        roomId: document.roomId,
        title: document.title,
        deleted: true,
        mode: "trash",
        recoverable: true,
        deletedAt: trashed?.deletedAt ?? null,
        reason,
        nextAction: "report_result",
      });
    },
  };

  return {
    manifest: manifest("document.delete", "mutation", null, null, true, true),
    promptGuidelines: [
      "只有用户明确要求删除文档（如「删掉这篇」「把它移到回收站」）时才调用 context_room_document_delete："
      + "先用 context_room_document_list 或 document_read 确认目标文档，拿不准用户指哪篇时先向用户复述标题核对；"
      + "确认后必须传 confirm=true。删除是移入回收站（可恢复），完成后在回复中明确说明删除了哪篇文档、"
      + "以及可从回收站恢复。禁止顺手清理或批量删除；用户点名多篇时逐篇确认后删除，并在回复中汇总结果。",
    ],
    tools: [documentDelete],
  };
}
