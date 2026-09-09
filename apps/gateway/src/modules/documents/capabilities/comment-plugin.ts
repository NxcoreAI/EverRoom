import { randomUUID } from "node:crypto";
import type { DocumentEvent } from "@nxcore/agent-contract";

import type { DocumentCommentService } from "../comments.js";
import { tiptapText, findBlockPath } from "../content-model.js";
import { DocumentServiceError } from "../errors.js";
import { annotations, manifest, type CapabilityBackend } from "./shared.js";
import { stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool } from "./types.js";

/**
 * 文档审阅评论（AI 审阅）：无状态 mutation 插件，向主 agent 暴露
 * context_room_document_comment_add。锚定约束在服务端强校验——
 * quotedText 必须是正文纯文本的逐字摘录（面板锚定只做空白归一化，
 * Markdown 标记永远匹配不上），blockId 必须存在；校验失败返回可重试
 * 错误引导 agent 重新读取文档摘录。
 */

const AI_AUTHOR_NAME = "AI 审阅";
/** 单 run 评论上限：防 agent 循环刷评论；进程内存态，重启即清。 */
const AI_COMMENT_RUN_LIMIT = 8;
const AI_COMMENT_RUN_MAP_LIMIT = 500;

const runsByDocument = new Map<string, number>();

function commentsKernel(comments: DocumentCommentService | undefined): DocumentCommentService {
  if (!comments) {
    throw new DocumentServiceError("COMMENT_SERVICE_UNAVAILABLE", "Comment service is not configured", 503);
  }
  return comments;
}

const normalizeWhitespace = (value: string): string => value.replace(/[\s　]+/g, "");

export function commentPlugin(
  backend: CapabilityBackend,
  comments?: DocumentCommentService,
  publishDocumentEvent?: (event: DocumentEvent) => void,
): DocumentCapabilityPlugin {
  const commentAdd: DocumentCapabilityTool = {
    name: "context_room_document_comment_add",
    title: "添加文档审阅评论",
    description: "对当前 Room 文档添加一条审阅评论。必须先在当前 run 调用 context_room_document_read 读取全文；"
      + "每条评论聚焦一处具体问题：body 用一两句话说明问题与改进建议；"
      + "quotedText 必须从正文逐字摘录一段纯文本原文（不带 Markdown 标记，建议 20-80 字）用于正文锚定；"
      + "能确定所在块时同时传 blockId（照抄 document_read 返回的 blocks）。一次审阅最多添加 5 条评论。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string", minLength: 1, maxLength: 128 },
        body: { type: "string", minLength: 1, maxLength: 2000 },
        blockId: { type: "string", minLength: 1, maxLength: 128 },
        quotedText: { type: "string", minLength: 1, maxLength: 500 },
        parentId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["documentId", "body"],
    },
    annotations: annotations(false),
    execute: (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const documentId = stringArg(args, "documentId");
      const document = backend.get(documentId);
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.roomId !== context.roomId) throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);

      const blockId = typeof args.blockId === "string" && args.blockId.trim() ? args.blockId.trim() : null;
      const quotedText = typeof args.quotedText === "string" && args.quotedText.trim() ? args.quotedText.trim() : null;

      if (blockId && !findBlockPath(document.contentJson, blockId)) {
        throw new DocumentServiceError("BLOCK_NOT_FOUND", "blockId 不在当前文档中，请重新读取文档获取有效块 id", 409, {
          retryable: true,
          nextAction: "context_room_document_read",
        });
      }
      // 锚定校验：面板按去空白纯文本匹配 quotedText；带 Markdown 标记或改写的引用必然落"未定位评论"。
      if (quotedText) {
        const plain = normalizeWhitespace(tiptapText(document.contentJson));
        if (!plain.includes(normalizeWhitespace(quotedText))) {
          throw new DocumentServiceError("COMMENT_QUOTE_NOT_FOUND",
            "quotedText 必须从正文逐字摘录纯文本（不要带 Markdown 标记、不要改写），且必须出现在当前文档中", 409, {
              retryable: true,
              nextAction: "context_room_document_read",
            });
        }
      }

      // 单 run 上限（防刷）。
      const runKey = `${context.runId}:${documentId}`;
      const used = runsByDocument.get(runKey) ?? 0;
      if (used >= AI_COMMENT_RUN_LIMIT) {
        throw new DocumentServiceError("COMMENT_RUN_LIMIT", "本次审阅的评论数量已达上限，请停止添加并在回复中汇总", 409, {
          retryable: false,
          nextAction: "stop_adding_comments",
        });
      }

      const comment = commentsKernel(comments).create({
        documentId,
        body: stringArg(args, "body"),
        parentId: typeof args.parentId === "string" && args.parentId.trim() ? args.parentId.trim() : null,
        blockId,
        quotedText,
        authorName: AI_AUTHOR_NAME,
      });
      runsByDocument.set(runKey, used + 1);
      if (runsByDocument.size > AI_COMMENT_RUN_MAP_LIMIT) {
        const oldest = runsByDocument.keys().next().value;
        if (oldest !== undefined) runsByDocument.delete(oldest);
      }

      // 广播给桌面评论面板实时刷新；事件失败不影响工具结果。
      try {
        publishDocumentEvent?.({
          id: randomUUID(),
          roomId: document.roomId,
          documentId: document.id,
          operationId: null,
          type: "document.comments.changed",
          occurredAt: new Date().toISOString(),
          payload: comment,
        });
      } catch {
        // 事件广播失败静默：面板展开时还有兜底 reload。
      }

      return success({
        comment,
        commentId: comment.id,
        documentId,
        authorName: comment.authorName,
        anchored: Boolean(blockId || quotedText),
        nextAction: "continue_or_summarize",
      });
    },
  };

  return {
    manifest: manifest("document.comment", "mutation", null, null, true, true),
    promptGuidelines: [
      "用户要求审阅、评审、给文档提意见或找问题时：先调用 context_room_document_read 读取当前权威版本，"
      + "再挑出 3-5 处最有价值的具体改进点（结构缺口、论证漏洞、缺少反例或数据支撑、事实性风险、表达歧义），"
      + "对每一处调用 context_room_document_comment_add 添加一条评论。"
      + "quotedText 必须从正文逐字摘录纯文本原文（不带 Markdown 标记）用于锚定，能确定块时同时传 blockId；"
      + "body 简明指出问题并给出可执行的改进建议，每条评论只讲一处。"
      + "审阅要结合已召回的 Room 记忆与用户背景：优先贴合用户目标、偏好与项目语境的建议，"
      + "发现正文与记忆中的新事实或决定冲突时作为重点问题指出。"
      + "单次审阅不超过 5 条，优先质量而非数量。全部添加完成后，在回复中用简短列表汇总审阅结论，不要把评论内容重复粘贴到回复正文。",
    ],
    tools: [commentAdd],
  };
}
