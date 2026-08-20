import { randomUUID } from "node:crypto";
import type { DocumentOperation } from "@nxcore/agent-contract";
import { DocumentServiceError } from "../errors.js";
import type { DocumentOperationService } from "../operations/service.js";
import { annotations, contentHash, manifest, type CapabilityBackend } from "./shared.js";
import {
  integerArg,
  stringArg,
  success,
  type DocumentCapabilityPlugin,
  type DocumentCapabilityTool,
} from "./types.js";

export function createPlugin(
  backend: CapabilityBackend,
  operations?: DocumentOperationService,
): DocumentCapabilityPlugin {
  const operationService = (): DocumentOperationService => {
    if (!operations) {
      throw new DocumentServiceError(
        "OPERATION_KERNEL_REQUIRED",
        "document.create requires the Document Operation Kernel",
        503,
      );
    }
    return operations;
  };
  const requireOperation = (
    operationId: string,
    context: { agentSessionId: string; runId: string; roomId: string | null },
  ): DocumentOperation => {
    const operation = operationService().get(operationId);
    if (!operation || operation.capabilityId !== "document.create") {
      throw new DocumentServiceError("OPERATION_NOT_FOUND", "Document create operation not found", 404);
    }
    if (
      operation.sessionId !== context.agentSessionId
      || operation.runId !== context.runId
      || operation.roomId !== context.roomId
    ) {
      throw new DocumentServiceError("OPERATION_FORBIDDEN", "Operation belongs to another Agent run", 403);
    }
    if (operation.expiresAt && Date.parse(operation.expiresAt) <= Date.now()) {
      throw new DocumentServiceError("OPERATION_EXPIRED", "Document create operation expired", 410);
    }
    return operation;
  };
  const begin: DocumentCapabilityTool = {
    name: "context_room_write_begin",
    title: "开始创建 Room 文档",
    description: "仅当用户已经明确要求在工作区创建、保存或写入文档且 Room 已确认后调用。若句子的创建对象是 Room、Context Room 或房间，不得调用本工具；即使用途说明中出现“文档/文件/项目”，也应调用 context_room_create。工具可用、当前位于文档页面，或用户只要求分析、总结、整理、写方案、起草、润色，都不代表要创建文档。调用前根据上下文确定文档类型、目标读者、期望结果和格式约束，明确准备写入正文的核心内容、重点或结论，形成连贯提纲，并拟定能够准确概括正文的具体标题；上下文足够时不要机械追问。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["create"] },
        title: { type: "string", minLength: 1, maxLength: 120 },
        format: { type: "string", enum: ["markdown"] },
      },
      required: ["mode", "title", "format"],
    },
    annotations: annotations(false),
    execute: async (args, context) => {
      if (!context.roomId) {
        throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room before creating a document");
      }
      if (stringArg(args, "mode") !== "create" || stringArg(args, "format") !== "markdown") {
        throw new Error("INVALID_REQUEST: only create/markdown is supported");
      }
      const title = stringArg(args, "title").trim();
      const operationId = randomUUID();
      const documentId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const operation = operationService().create({
        id: operationId,
        capabilityId: "document.create",
        capabilityVersion: 1,
        interactionMode: "streaming_commit",
        presenterKey: "streaming-document",
        roomId: context.roomId,
        // The draft id is persisted in operation.input until Commit Core creates
        // the real document; document_operations.document_id is a foreign key.
        documentId: null,
        documentTitle: title,
        sessionId: context.agentSessionId,
        runId: context.runId,
        status: "running",
        summary: `创建文档：${title}`,
        input: {
          draftDocumentId: documentId,
          format: "markdown",
          nextSequence: 1,
          totalBytes: 0,
        },
        expiresAt,
      });
      await operationService().execute(operationId, {
        commandId: `${operationId}:begin`,
        expectedRevision: operation.revision,
        type: "stream.begin",
      }, () => ({
        status: "running",
        draftCreate: backend.prepareAgentDocumentDraft({
          documentId,
          roomId: context.roomId!,
          title,
          markdown: "",
        }),
      }));
      return success({
        operationId,
        roomId: context.roomId, docId: documentId,
        state: "running", nextSequence: 1, nextAction: "context_room_write_append",
        expiresAt: expiresAt.toISOString(),
        navigation: {
          pageId: "rooms", title, action: "created",
          roomId: context.roomId, objectId: documentId, objectType: "document",
        },
      });
    },
  };
  const append: DocumentCapabilityTool = {
    name: "context_room_write_append",
    title: "流式追加 Room 文档正文",
    description: "按严格连续 sequence 追加本次新增的 Markdown 正文，不得重发累计全文。context_room_write_begin.title 会由文档界面单独渲染为页面顶部 H1，不属于 Markdown 正文；正文不得再次输出同名标题、等价标题或任何一级标题（#）。正文通常先写一小段引言，再进入 ## 主章节；子章节使用 ###，更深层级依次使用 ####。编号章节例如“2. xxx”必须写成“## 2. xxx”，“2.1 xxx”必须写成“### 2.1 xxx”，不要把主章节写成普通数字列表而让子章节变成更大的标题。标题必须唯一且能准确描述本节。使用标准 Markdown：围栏代码块标注语言，链接使用有意义的说明文字，表格只用于真正的行列数据。除非用户明确要求简短版本，否则正文应为充实、完整的长篇内容。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        operationId: { type: "string" }, sequence: { type: "integer", minimum: 1 },
        text: { type: "string" },
      },
      required: ["operationId", "sequence", "text"],
    },
    annotations: annotations(false),
    execute: async (args, context) => {
      const operationId = stringArg(args, "operationId");
      const sequence = integerArg(args, "sequence");
      const suppliedText = stringArg(args, "text", true);
      const operation = requireOperation(operationId, context);
      if (Buffer.byteLength(suppliedText, "utf8") > 64 * 1024) {
        throw new DocumentServiceError("SIZE_LIMIT", "Document chunk exceeds 64 KiB");
      }
      const text = backend.normalizeAgentDocumentChunk(operation.documentTitle, suppliedText);
      const bytes = Buffer.byteLength(text, "utf8");
      const command = await operationService().execute(operationId, {
          commandId: `${operationId}:append:${sequence}:${contentHash(text)}`,
          expectedRevision: operation.revision,
          type: "stream.append",
          payload: { sequence, bytes },
        }, (current) => {
          const existing = current.items.find((item) => item.sequence === sequence);
          if (existing) {
            if (existing.contentHash !== contentHash(text) || existing.markdown !== text) {
              throw new DocumentServiceError(
                "SEQUENCE_CONFLICT",
                "Sequence already contains different content",
                409,
              );
            }
            return {};
          }
          const nextSequence = Number(current.input.nextSequence ?? 1);
          const totalBytes = Number(current.input.totalBytes ?? 0);
          if (!Number.isSafeInteger(sequence) || sequence !== nextSequence) {
            throw new DocumentServiceError("SEQUENCE_GAP", "Document chunks must be strictly consecutive", 409);
          }
          if (totalBytes + bytes > 2 * 1024 * 1024) {
            throw new DocumentServiceError("SIZE_LIMIT", "Document operation exceeds 2 MiB");
          }
          const markdown = [
            ...current.items.slice().sort((left, right) => left.sequence - right.sequence)
              .map((item) => item.markdown),
            text,
          ].join("");
          const documentId = typeof current.input.draftDocumentId === "string"
            ? current.input.draftDocumentId
            : null;
          if (!documentId) {
            throw new DocumentServiceError("INVALID_OPERATION", "Draft document id is missing", 409);
          }
          return {
            input: {
              ...current.input,
              nextSequence: sequence + 1,
              totalBytes: totalBytes + bytes,
            },
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            addItems: [{ sequence, operation: "stream_chunk", markdown: text, contentHash: contentHash(text) }],
            draftUpdate: backend.prepareAgentDocumentDraft({
              documentId,
              roomId: current.roomId,
              title: current.documentTitle,
              markdown,
            }),
          };
        });
      const refreshed = command.operation;
      return success({
        operationId: args.operationId,
        acceptedSequence: args.sequence,
        duplicate: command.duplicate,
        nextSequence: refreshed.input.nextSequence,
        totalBytes: refreshed.input.totalBytes,
        commitRequired: true,
      });
    },
  };
  const commit: DocumentCapabilityTool = {
    name: "context_room_write_commit",
    title: "提交 Room 文档",
    description: "正文完成后提交并生成不可变版本。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { operationId: { type: "string" }, finalSequence: { type: "integer", minimum: 0 } },
      required: ["operationId", "finalSequence"],
    },
    annotations: annotations(false),
    execute: async (args, context) => {
      const operationId = stringArg(args, "operationId");
      const finalSequence = integerArg(args, "finalSequence");
      const operation = requireOperation(operationId, context);
      const committed = await operationService().execute(operationId, {
          commandId: `${operationId}:commit:${integerArg(args, "finalSequence")}`,
          expectedRevision: operation.revision,
          type: "stream.commit",
          payload: { finalSequence },
        }, async (current) => {
          const nextSequence = Number(current.input.nextSequence ?? 1);
          if (finalSequence !== nextSequence - 1) {
            throw new DocumentServiceError(
              "SEQUENCE_GAP",
              "Final sequence does not match received chunks",
              409,
            );
          }
          const documentId = typeof current.input.draftDocumentId === "string"
            ? current.input.draftDocumentId
            : current.documentId;
          if (!documentId) {
            throw new DocumentServiceError("INVALID_OPERATION", "Draft document id is missing", 409);
          }
          const markdown = current.items
            .slice()
            .sort((left, right) => left.sequence - right.sequence)
            .map((item) => item.markdown)
            .join("");
          const prepared = backend.prepareAgentDocumentFinalize({
            operationId: current.id,
            documentId,
            roomId: current.roomId,
            title: current.documentTitle,
            markdown,
            sessionId: current.sessionId,
            runId: current.runId,
          });
          return {
            status: "completed",
            result: { documentId, version: 1 },
            updateItems: current.items.map((item) => ({
              id: item.id,
              status: "applied" as const,
              appliedVersion: 1,
            })),
            commit: prepared.commit,
            complete: true,
            afterCommit: prepared.afterCommit,
          };
        });
      const document = committed.document;
      if (!document) throw new DocumentServiceError("COMMIT_FAILED", "Document commit returned no document", 500);
      return success({
        operationId, state: "completed",
        roomId: document.roomId, docId: document.id,
        navigation: {
          pageId: "rooms", title: document.title, action: "created",
          roomId: document.roomId, objectId: document.id, objectType: "document",
        },
      });
    },
  };
  const abort: DocumentCapabilityTool = {
    name: "context_room_write_abort",
    title: "中止 Room 文档事务",
    description: "中止创建操作并删除临时文档。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { operationId: { type: "string" }, reason: { type: "string", maxLength: 1000 } },
      required: ["operationId"],
    },
    annotations: annotations(false, true),
    execute: async (args, context) => {
      const operationId = stringArg(args, "operationId");
      const operation = requireOperation(operationId, context);
      const reason = typeof args.reason === "string" ? args.reason : "agent-aborted";
      await operationService().execute(operationId, {
          commandId: `${operationId}:cancel`,
          expectedRevision: operation.revision,
          type: "operation.cancel",
          payload: { reason },
        }, () => ({
          status: "cancelled",
          result: { reason },
          complete: true,
          ...(typeof operation.input.draftDocumentId === "string"
            ? { draftDeleteDocumentId: operation.input.draftDocumentId }
            : {}),
        }));
      return success({ operationId, state: "cancelled" });
    },
  };
  return {
    manifest: manifest("document.create", "mutation", "streaming_commit", "streaming-document", true, false),
    promptGuidelines: [
      "只在用户明确要求创建、保存或写入工作区文档时使用创建工具。",
      "若被创建的对象是 Room、Context Room 或房间，不得使用文档创建工具；用途从句中出现文档、文件或项目不代表创建文档。“创建一个管理项目文档的 Context Room”应调用 context_room_create，“在 Context Room 里创建一份项目文档”才使用文档创建工具。",
      "写作前根据已有上下文确定文档类型、目标读者、期望结果与约束，并在内部形成连贯提纲；上下文足够时直接写，不要为了流程机械追问。",
      "文档标题与正文严格分离：context_room_write_begin.title 是唯一页面标题，并由界面以 H1 展示；后续 context_room_write_append 只能生成正文，不得再次写出标题、同义标题或任何 # 一级标题。正文主章节从 ## 开始，子章节从 ### 开始；编号章节必须保持对应层级，例如 2. 使用 ##、2.1 使用 ###。",
      "正文通常以简短引言开头；标题应唯一、完整且有描述性。使用标准 Markdown，代码围栏标注语言，链接文字说明目标内容，表格只用于真正的行列数据。",
      "除非用户明确要求简短版本，正文应充分展开。提交前通读全文，修正层级、衔接、重复、矛盾、缺失上下文、无依据断言、套话和低质量链接，再调用提交工具。",
    ],
    tools: [begin, append, commit, abort],
  };
}
