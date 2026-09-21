/**
 * 写作路线导图拍板（聚焦改版 2026-09）：用户在对话里对新文档的写作路线
 * 表示认可（「就按这样做吧」）时，主 agent 调 route_mindmap_finalize 锁定
 * 已选路线并触发正文写作。服务本体在 knowledge/route-mindmap-service；
 * 模块边界照 selection-rewrite 惯例——这里只依赖结构化接口，装配在
 * create-server（服务晚于能力注册表构造，经 getter 惰性取用）。
 */

import { DocumentServiceError } from "../errors.js";
import { annotations, manifest, type CapabilityBackend } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool } from "./types.js";

/** 结构化最小接口（RouteMindmapService.finalize 的形），免跨模块 import。 */
interface RouteFinalizeService {
  finalize(roomId: string, input: { documentId: string; requestVersion: number }): Promise<{
    status: string;
    writing: boolean;
    error: string | null;
  }>;
}

export function routeMindmapPlugin(
  backend: CapabilityBackend,
  getService: () => RouteFinalizeService | null,
): DocumentCapabilityPlugin {
  const finalizeTool: DocumentCapabilityTool = {
    name: "route_mindmap_finalize",
    title: "拍板写作路线",
    description: "当用户对某份新文档在思路板块选定的写作路线表示认可（如「就按这条路写」「就按这样做吧」）时调用："
      + "锁定该文档已选的路线并开始照路线撰写正文。documentId 传这份新文档的 id；"
      + "若路线尚未选定或生成中，返回错误并在回复中请用户先在思路板块完成选路。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["documentId"],
    },
    annotations: annotations(false),
    execute: async (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const service = getService();
      if (!service) {
        throw new DocumentServiceError("ROUTE_MINDMAP_UNAVAILABLE", "Route mindmap service is not ready", 503);
      }
      const documentId = stringArg(args, "documentId");
      const document = backend.get(documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      try {
        const view = await service.finalize(context.roomId, { documentId, requestVersion: 0 });
        return success({
          documentId,
          status: view.status,
          writing: view.writing,
          message: view.writing
            ? "已拍板：路线已锁定，正文正在按路线撰写，完成后会写入文档。"
            : `路线已锁定${view.error ? `（正文写入异常：${view.error}，可重试）` : ""}。`,
        });
      } catch (error) {
        if (error instanceof Error && /^(route_|document_room_mismatch)/.test(error.message)) {
          throw new DocumentServiceError("ROUTE_FINALIZE_REJECTED", error.message, 409, {
            retryable: false,
            nextAction: "请用户在思路板块完成选路后重试",
          });
        }
        throw error;
      }
    },
  };

  return {
    manifest: manifest("document.route-mindmap", "mutation", null, null, true, false),
    promptGuidelines: [
      "新建文档后若用户进入写作路线选择流程，用户口头认可选定路线时调用 route_mindmap_finalize 拍板，不要另行起草正文。",
    ],
    tools: [finalizeTool],
  };
}
