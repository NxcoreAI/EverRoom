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
    description: "仅当用户已经明确要求在工作区创建、保存或写入文档时调用。正文内容与标题必须来自 document_draft 的返回值（title 与 appendChunks 逐字转发），不得自行撰写。当前视口已绑定 Room 时省略 roomId；未绑定时，必须先根据文档标题、主题、拟写内容与可用 Room 的标题、类型、背景、目标和状态判断，只有存在明确唯一匹配时才填写该 Room 的 ID。无法可靠确定唯一 Room 时不得调用本工具，应调用 context_room_list 并提供最可能相关的 candidateRoomIds，等待用户选择。若句子的创建对象是 Room、Context Room 或房间，不得调用本工具；即使用途说明中出现“文档/文件/项目”，也应调用 context_room_create。工具可用、当前位于文档页面，或用户只要求分析、总结、整理、写方案、起草、润色，都不代表要创建文档。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["create"] },
        title: { type: "string", minLength: 1, maxLength: 120 },
        format: { type: "string", enum: ["markdown"] },
        roomId: { type: "string", minLength: 1, maxLength: 128 },
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
    description: "按严格连续 sequence 追加本次新增的 Markdown 正文，不得重发累计全文。优先以引用方式转交：传 document_draft 返回的 invocationId 与 chunkIndex（0 起，按顺序逐块），正文由服务端从 doc-writer 结果转交，参数中不携带正文；text 仅供无法引用 invocation 的调用方直写。正文不得包含标题或一级标题（#）：context_room_write_begin.title 由界面单独渲染为页面顶部 H1；主章节从 ## 开始，子章节依次递进。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        operationId: { type: "string" }, sequence: { type: "integer", minimum: 1 },
        text: { type: "string", description: "直写模式：本批 markdown。与 invocationId 互斥。" },
        invocationId: { type: "string", maxLength: 64, description: "引用模式：document_draft 返回的 invocation 引用，服务端转交正文。" },
        chunkIndex: { type: "integer", minimum: 0, description: "引用模式：appendChunks 的下标（0 起）。" },
      },
      required: ["operationId", "sequence"],
    },
    annotations: annotations(false),
    execute: async (args, context) => {
      const operationId = stringArg(args, "operationId");
      const sequence = integerArg(args, "sequence");
      const invocationId = typeof args.invocationId === "string" ? args.invocationId.trim() : "";
      let suppliedText: string;
      if (invocationId) {
        if (typeof args.text === "string") {
          throw new DocumentServiceError("INVALID_REQUEST", "Pass either invocationId or text, not both", 400);
        }
        const draft = backend.resolveDocWriterDraft?.(invocationId, { runId: context.runId }) ?? null;
        if (!draft) {
          throw new DocumentServiceError("DOC_WRITER_DRAFT_UNAVAILABLE", "No completed doc-writer draft bound to this run", 409, {
            invocationId,
            retryable: false,
            nextAction: "document_draft",
          });
        }
        if (draft.kind !== "draft-create") {
          throw new DocumentServiceError("DOC_WRITER_DRAFT_KIND_MISMATCH", "write_append consumes a draft-create invocation", 409, {
            invocationId,
            kind: draft.kind,
            retryable: false,
          });
        }
        const chunkIndex = integerArg(args, "chunkIndex");
        const chunk = draft.chunks[chunkIndex];
        if (chunk === undefined) {
          throw new DocumentServiceError("DOC_WRITER_CHUNK_INDEX_OUT_OF_RANGE", "chunkIndex is outside the draft chunks", 409, {
            invocationId,
            chunkIndex,
            chunkCount: draft.chunks.length,
            retryable: true,
          });
        }
        suppliedText = chunk;
      } else {
        if (typeof args.text !== "string") throw new Error("INVALID_REQUEST: text is required without invocationId");
        suppliedText = args.text;
      }
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
      "当前视口没有绑定 Room 时，先使用文档标题、主题和拟写内容，对照可用 Room 的标题、类型、背景、目标、状态及内容摘要判断归属。存在明确唯一匹配时，在 context_room_write_begin.roomId 中填写其 ID 并直接创建；无法可靠确定唯一目标时，调用 context_room_list，仅提交最可能相关的 2 至 5 个 candidateRoomIds，然后停止创建并等待用户选择。不得仅凭列表顺序、最近使用或宽泛词语猜测 Room。",
      "若被创建的对象是 Room、Context Room 或房间，不得使用文档创建工具；用途从句中出现文档、文件或项目不代表创建文档。“创建一个管理项目文档的 Context Room”应调用 context_room_create，“在 Context Room 里创建一份项目文档”才使用文档创建工具。",
      "正文内容与标题必须来自 document_draft：write_begin 使用其返回的 title，write_append 凭返回的 invocationId 与 chunkIndex（0 起，按顺序逐块）引用转交，正文由服务端从 doc-writer 结果取用，不得在工具参数中复写正文。",
    ],
    tools: [begin, append, commit, abort],
  };
}
