import { randomUUID } from "node:crypto";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import type { DocumentOperation, DocumentOperationCommandInput, DocumentOperationItem, DocumentMutationTarget, TiptapJsonContent } from "@nxcore/agent-contract";
import { applyDocumentMutation, findBlockPath, mutationTargetBlockIds, targetsOverlap, tiptapText } from "../content-model.js";
import { DocumentContentEngine } from "../core/index.js";
import { DocumentServiceError } from "../errors.js";
import type { DocumentOperationCommandMutation, DocumentOperationService } from "../operations/service.js";
import type { DocumentReadAuthority } from "./read-authority.js";
import { PATCH_TARGET_SCHEMA } from "./schemas.js";
import { annotations, contentHash, manifest, normalizePatchTarget, type CapabilityBackend } from "./shared.js";
import { integerArg, record, stringArg, success, type DocumentCapabilityPlugin, type DocumentCapabilityTool } from "./types.js";

const CHUNK_MAX_BYTES = 64 * 1024;
const OPERATION_MAX_BYTES = 2 * 1024 * 1024;
const OPERATION_TTL_MS = 10 * 60 * 1000;
const markdown = new MarkdownManager({ extensions: [StarterKit, TaskList, TaskItem] });

function kernel(value?: DocumentOperationService): DocumentOperationService {
  if (!value) throw new Error("DOCUMENT_OPERATION_KERNEL_REQUIRED: mutation tools require the Operation Kernel");
  return value;
}

interface ResolvedRunningOperation {
  operation: DocumentOperation;
  operationIdCorrected: boolean;
}

function suppliedOperationIds(args: Record<string, unknown>): string[] {
  return [...new Set([args.operationId, args.patchId]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim()))];
}

function resolveRunningOperation(
  value: DocumentOperationService,
  args: Record<string, unknown>,
  sessionId: string,
  runId: string,
): ResolvedRunningOperation {
  const suppliedIds = suppliedOperationIds(args);
  for (const id of suppliedIds) {
    const operation = value.get(id);
    if (!operation) continue;
    if (operation.sessionId !== sessionId) {
      throw new DocumentServiceError("OPERATION_SESSION_MISMATCH", "Operation belongs to another session", 403);
    }
    if (operation.runId !== runId) continue;
    if (operation.status !== "running") {
      throw new DocumentServiceError("OPERATION_FINALIZED", `Operation cannot be built from ${operation.status}`, 409);
    }
    if (operation.capabilityId !== "document.edit" && operation.capabilityId !== "document.continue") {
      throw new DocumentServiceError("OPERATION_CAPABILITY_MISMATCH", "Operation is not a document patch", 409);
    }
    return {
      operation,
      operationIdCorrected: suppliedIds.length !== 1 || suppliedIds[0] !== operation.id,
    };
  }

  const candidates = value.list({ sessionId, runId, statuses: ["running"] })
    .filter((operation) => operation.capabilityId === "document.edit"
      || operation.capabilityId === "document.continue");
  if (candidates.length === 1) {
    return { operation: value.get(candidates[0]!.id)!, operationIdCorrected: true };
  }
  if (candidates.length > 1) {
    throw new DocumentServiceError(
      "OPERATION_ID_AMBIGUOUS",
      "More than one document patch is active in this Agent run",
      409,
      { retryable: true, nextAction: "use_operation_id_from_patch_begin" },
    );
  }
  throw new DocumentServiceError(
    "OPERATION_NOT_FOUND",
    "No active document patch exists in this Agent run",
    404,
    { retryable: true, nextAction: "context_room_patch_begin" },
  );
}

function authoritativeDocument(backend: CapabilityBackend, operation: DocumentOperation) {
  const document = operation.documentId ? backend.get(operation.documentId) : null;
  if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
  if (document.roomId !== operation.roomId) throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
  if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
  if (document.activeTransactionId && document.activeTransactionId !== operation.id) {
    throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
  }
  if (document.version !== operation.baseVersion) {
    throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
      documentId: document.id,
      currentVersion: document.version,
      retryable: true,
      nextAction: "context_room_document_read",
    });
  }
  return document;
}

function parseFragment(backend: CapabilityBackend, documentId: string, roomId: string, source: string): TiptapJsonContent[] {
  const engine = new DocumentContentEngine({ findDocumentRoom: (id) => backend.get(id)?.roomId ?? null });
  try {
    return engine.normalizeFragment(markdown.parse(source) as TiptapJsonContent, documentId, roomId).content.content ?? [];
  } catch (error) {
    if (error instanceof DocumentServiceError) throw error;
    throw new DocumentServiceError(
      "INVALID_MARKDOWN",
      error instanceof Error ? error.message : "Replacement Markdown could not be parsed",
    );
  }
}

function replacementMarkdownMap(command: DocumentOperationCommandInput): Map<string, string> {
  const raw = command.payload?.replacementMarkdownByItemId;
  if (raw === undefined) return new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DocumentServiceError("INVALID_REPLACEMENT_MARKDOWN", "Replacement Markdown overrides must be keyed by item ID");
  }
  const result = new Map<string, string>();
  for (const [itemId, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new DocumentServiceError("INVALID_REPLACEMENT_MARKDOWN", "Each replacement Markdown override must be a string");
    }
    result.set(itemId, value);
  }
  return result;
}

function validatedReplacementMarkdown(
  backend: CapabilityBackend,
  document: { id: string; roomId: string },
  source: string,
): TiptapJsonContent[] {
  if (!source.trim()) {
    throw new DocumentServiceError("EMPTY_REPLACEMENT_MARKDOWN", "Replacement Markdown cannot be empty");
  }
  if (Buffer.byteLength(source, "utf8") > CHUNK_MAX_BYTES) {
    throw new DocumentServiceError("SIZE_LIMIT", "Replacement Markdown exceeds 64 KiB");
  }
  const content = parseFragment(backend, document.id, document.roomId, source);
  if (!content.length) {
    throw new DocumentServiceError("EMPTY_REPLACEMENT_MARKDOWN", "Replacement Markdown cannot be empty");
  }
  return content;
}

function replacementAuditFields(
  source: string,
  after: TiptapJsonContent[],
): Pick<NonNullable<DocumentOperationCommandMutation["updateItems"]>[number], "after" | "markdown" | "contentHash"> {
  return {
    after,
    markdown: source,
    contentHash: contentHash(after.length === 1 ? after[0] : after),
  };
}

function proposedContent(base: TiptapJsonContent, items: DocumentOperationItem[]): TiptapJsonContent {
  return items.reduce((content, item) => item.target && (item.operation === "insert" || item.operation === "replace" || item.operation === "delete")
    ? applyDocumentMutation(content, item.operation, item.target, item.after).content
    : content, base);
}

function normalizedBlockText(node: TiptapJsonContent): string {
  return tiptapText(node).replace(/\s+/g, " ").trim();
}

function repeatsExistingDocument(base: TiptapJsonContent, fragment: TiptapJsonContent[]): boolean {
  const existing = (base.content ?? []).map(normalizedBlockText).filter((text) => text.length >= 8);
  const proposed = fragment.map(normalizedBlockText).filter((text) => text.length >= 8);
  if (existing.length < 3 || proposed.length < 3) return false;

  const remaining = new Map<string, number>();
  for (const text of existing) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  let matchedBlocks = 0;
  let matchedCharacters = 0;
  for (const text of proposed) {
    const count = remaining.get(text) ?? 0;
    if (!count) continue;
    remaining.set(text, count - 1);
    matchedBlocks += 1;
    matchedCharacters += text.length;
  }
  const existingCharacters = existing.reduce((sum, text) => sum + text.length, 0);
  const proposedCharacters = proposed.reduce((sum, text) => sum + text.length, 0);
  return matchedBlocks >= 3
    && matchedCharacters >= 200
    && matchedCharacters / existingCharacters >= 0.4
    && matchedCharacters / proposedCharacters >= 0.4;
}

function comparableBlock(node: TiptapJsonContent): string {
  const headingLevel = node.type === "heading" ? Number(node.attrs?.level ?? 0) : 0;
  return `${node.type ?? ""}:${headingLevel}:${normalizedBlockText(node)}`;
}

function equivalentContextBlock(left: TiptapJsonContent, right: TiptapJsonContent): boolean {
  if (left.type === "heading" && right.type === "heading") {
    return normalizedBlockText(left) === normalizedBlockText(right);
  }
  return comparableBlock(left) === comparableBlock(right);
}

function topLevelTargetRange(
  base: TiptapJsonContent,
  target: DocumentMutationTarget,
): { from: number; to: number } | null {
  if ("at" in target || "fromOffset" in target || "toOffset" in target || "edge" in target) return null;
  const fromId = "fromBlockId" in target ? target.fromBlockId : target.blockId;
  const toId = "toBlockId" in target ? target.toBlockId : target.blockId;
  const from = findBlockPath(base, fromId)?.[0];
  const to = findBlockPath(base, toId)?.[0];
  if (from === undefined || to === undefined || from > to) return null;
  return { from, to };
}

function reduceRepeatedFullDocumentEdit(
  document: { title: string; contentJson: TiptapJsonContent },
  target: DocumentMutationTarget,
  proposed: TiptapJsonContent[],
): TiptapJsonContent[] | null {
  const base = document.contentJson.content ?? [];
  const targetRange = topLevelTargetRange(document.contentJson, target);
  if (!targetRange || !base.length || !proposed.length) return null;

  let prefix = 0;
  while (prefix < base.length && prefix < proposed.length
    && comparableBlock(base[prefix]!) === comparableBlock(proposed[prefix]!)) prefix += 1;

  let suffix = 0;
  while (suffix < base.length - prefix && suffix < proposed.length - prefix
    && comparableBlock(base[base.length - 1 - suffix]!)
      === comparableBlock(proposed[proposed.length - 1 - suffix]!)) suffix += 1;

  const changedBaseFrom = prefix;
  const changedBaseTo = base.length - suffix - 1;
  if (changedBaseFrom > changedBaseTo
    || targetRange.from !== changedBaseFrom
    || targetRange.to !== changedBaseTo) return null;

  const unchanged = [...base.slice(0, prefix), ...base.slice(base.length - suffix)];
  const unchangedCharacters = unchanged.reduce((sum, node) => sum + normalizedBlockText(node).length, 0);
  const baseCharacters = base.reduce((sum, node) => sum + normalizedBlockText(node).length, 0);
  if (unchanged.length < 3
    || unchangedCharacters < 120
    || unchangedCharacters / baseCharacters < 0.4) return null;

  const reduced = proposed.slice(prefix, proposed.length - suffix);
  if (changedBaseFrom === 0
    && reduced[0]?.type === "heading"
    && normalizedBlockText(reduced[0]) === document.title.trim()) reduced.shift();
  return reduced.length ? reduced : null;
}

function stripAdjacentTargetContext(
  document: { contentJson: TiptapJsonContent },
  target: DocumentMutationTarget,
  proposed: TiptapJsonContent[],
): { content: TiptapJsonContent[]; stripped: boolean } {
  const base = document.contentJson.content ?? [];
  const targetRange = topLevelTargetRange(document.contentJson, target);
  if (!targetRange || !proposed.length) return { content: proposed, stripped: false };

  let leading = 0;
  for (let count = Math.min(targetRange.from, proposed.length); count >= 1; count -= 1) {
    const context = base.slice(targetRange.from - count, targetRange.from);
    if (context.every((node, index) => equivalentContextBlock(node, proposed[index]!))) {
      leading = count;
      break;
    }
  }

  let trailing = 0;
  const remaining = proposed.length - leading;
  const availableAfter = base.length - targetRange.to - 1;
  for (let count = Math.min(availableAfter, remaining); count >= 1; count -= 1) {
    const context = base.slice(targetRange.to + 1, targetRange.to + 1 + count);
    const offset = proposed.length - count;
    if (context.every((node, index) => equivalentContextBlock(node, proposed[offset + index]!))) {
      trailing = count;
      break;
    }
  }

  return {
    content: proposed.slice(leading, proposed.length - trailing),
    stripped: leading > 0 || trailing > 0,
  };
}

function equivalentContent(left: TiptapJsonContent[], right: TiptapJsonContent[]): boolean {
  const serialize = (content: TiptapJsonContent[]) => markdown.serialize({ type: "doc", content }).trim();
  return serialize(left) === serialize(right)
    || (left.length === right.length
      && left.every((node, index) => comparableBlock(node) === comparableBlock(right[index]!)));
}

function requestsShorterReplacement(summary: string): boolean {
  return /(?:写短|缩短|精简|简短|简洁|压缩|shorter|shorten|condense|concise|brief)/iu.test(summary);
}

const pendingItems = (operation: DocumentOperation) => operation.items
  .filter((item) => item.status === "pending").sort((left, right) => left.sequence - right.sequence);

function beginTool(
  backend: CapabilityBackend,
  operations: DocumentOperationService | undefined,
  reads: DocumentReadAuthority,
): DocumentCapabilityTool {
  return {
    name: "context_room_patch_begin", title: "开始准备文档修改建议",
    description: "必须先在当前 run 调用 context_room_document_read；Gateway 会自动使用本轮读取凭证。重写、润色、扩写、替换或删除已有段落必须使用 kind=edit，并只覆盖用户要求修改的最小正文范围；kind=continue 只用于在原文后新增全新内容，不能用于改写已有内容。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      documentId: { type: "string" }, baseVersion: { type: "integer", minimum: 0 },
      readReceipt: { type: "string", minLength: 1, description: "兼容字段；Gateway 默认使用当前 run 最近一次有效的文档读取。" },
      kind: { type: "string", enum: ["continue", "edit"] }, summary: { type: "string", minLength: 1, maxLength: 500 },
    }, required: ["documentId", "baseVersion", "kind", "summary"] },
    annotations: annotations(false),
    execute: (args, context) => {
      if (!context.roomId) throw new Error("ROOM_SELECTION_REQUIRED: Select a Context Room first");
      const kind = stringArg(args, "kind");
      if (kind !== "continue" && kind !== "edit") throw new Error("INVALID_REQUEST: kind must be continue or edit");
      const document = backend.get(stringArg(args, "documentId"));
      if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
      if (document.roomId !== context.roomId) throw new DocumentServiceError("ROOM_MISMATCH", "Document belongs to another Room", 409);
      if (document.deletedAt) throw new DocumentServiceError("DOCUMENT_TRASHED", "Document is in trash", 409);
      if (document.activeTransactionId) throw new DocumentServiceError("DOCUMENT_BUSY", "Document is busy", 409);
      const baseVersion = integerArg(args, "baseVersion");
      if (document.version !== baseVersion) throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, {
        documentId: document.id,
        currentVersion: document.version,
        retryable: true,
        nextAction: "context_room_document_read",
      });
      const readReceipt = typeof args.readReceipt === "string" ? args.readReceipt.trim() : "";
      const receipt = readReceipt
        ? reads.require(readReceipt, context, document.id, baseVersion)
        : reads.requireLatest(context, document.id, baseVersion);
      const expiresAt = new Date(Date.now() + OPERATION_TTL_MS);
      const operation = kernel(operations).create({
        capabilityId: kind === "continue" ? "document.continue" : "document.edit", capabilityVersion: 1,
        interactionMode: kind === "continue" ? "incremental_review" : "atomic_review",
        presenterKey: kind === "continue" ? "continuation" : "atomic-diff",
        roomId: document.roomId, documentId: document.id, documentTitle: document.title,
        sessionId: context.agentSessionId, runId: context.runId, baseVersion, status: "running",
        summary: stringArg(args, "summary"),
        input: { kind, readReceipt: receipt.token, nextSequence: 1, totalBytes: 0, batchHashes: {} },
        expiresAt,
        acquireDocumentLease: true,
      });
      return success({ operationId: operation.id, patchId: operation.id, state: operation.status, documentId: document.id,
        readReceiptResolved: !readReceipt, baseVersion, nextSequence: 1,
        nextAction: "context_room_patch_hunk", expiresAt: expiresAt.toISOString() });
    },
  };
}

function hunkTool(
  backend: CapabilityBackend,
  operations: DocumentOperationService | undefined,
  reads: DocumentReadAuthority,
): DocumentCapabilityTool {
  return {
    name: "context_room_patch_hunk", title: "追加可审阅的文档修改项",
    description: "按严格连续 sequence 追加修改项。edit 必须使用能表达用户改动的最小 target；replace 的 markdown 只能是该 target 的新内容，绝不能复制 document_read 返回的完整 markdown、文档标题或未修改的后续章节。continue 仅能 insert 全新内容；每批 markdown 只能包含本批新增片段，禁止发送累计内容、原文或全文。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      operationId: { type: "string", description: "兼容字段；省略时 Gateway 使用当前 run 唯一运行中的 Patch。" },
      patchId: { type: "string", description: "兼容旧 Agent 会话的别名；通常无需传入。" },
      sequence: { type: "integer", minimum: 1 },
      operation: { type: "string", enum: ["insert", "replace", "delete"], description: "可省略；Gateway 会根据当前 Patch 推断。" },
      target: { ...PATCH_TARGET_SCHEMA, description: "只定位用户要求修改的最小块或块范围；replace/delete 不需要 edge。" },
      markdown: {
        type: "string",
        maxLength: 65536,
        description: "replace 时只传 target 的替换片段，不得传完整文档、文档标题或任何未修改章节；insert 时只传本批新增片段；delete 时省略。",
      },
    }, required: ["sequence", "target"] },
    annotations: annotations(false),
    execute: async (args, context) => {
      const service = kernel(operations);
      const resolvedOperation = resolveRunningOperation(service, args, context.agentSessionId, context.runId);
      const current = resolvedOperation.operation;
      const id = current.id;
      const rawTarget = record(args.target);
      if (!Object.keys(rawTarget).length) throw new Error("INVALID_REQUEST: target is required");
      const source = typeof args.markdown === "string" ? args.markdown : "";
      const suppliedKind = typeof args.operation === "string" ? args.operation : "";
      const kind = suppliedKind || (current.capabilityId === "document.continue"
        ? "insert"
        : "at" in rawTarget && source.trim() ? "insert"
          : source.trim() ? "replace" : "");
      const operationInferred = !suppliedKind;
      if (kind !== "insert" && kind !== "replace" && kind !== "delete") throw new Error("INVALID_REQUEST: unsupported patch operation");
      const normalized = normalizePatchTarget(kind, rawTarget);
      const sequence = integerArg(args, "sequence");
      const batchHash = contentHash({ kind, target: normalized.target, source });
      if (Buffer.byteLength(source, "utf8") > CHUNK_MAX_BYTES) throw new DocumentServiceError("SIZE_LIMIT", "Operation item exceeds 64 KiB");
      if (kind === "delete" && source.trim()) throw new DocumentServiceError("INVALID_PATCH", "Delete items cannot contain replacement Markdown");
      if (kind !== "delete" && !source.trim()) throw new DocumentServiceError("INVALID_PATCH", "Insert and replace items require Markdown");
      const continuation = current.capabilityId === "document.continue";
      const nextSequence = Number(current.input.nextSequence ?? (current.items.length ? 2 : 1));
      const duplicateEditSequence = current.capabilityId === "document.edit"
        && current.items.some((item) => item.sequence === sequence && item.contentHash === batchHash);
      const batchHashes = current.input.batchHashes && typeof current.input.batchHashes === "object"
        ? current.input.batchHashes as Record<string, unknown>
        : {};
      if (continuation && kind !== "insert") {
        throw new DocumentServiceError("INVALID_CONTINUATION", "Continuation batches must be Markdown inserts");
      }
      if (continuation) {
        if (sequence < nextSequence) {
          if (batchHashes[String(sequence)] !== batchHash) {
            throw new DocumentServiceError("SEQUENCE_CONFLICT", "Continuation sequence already contains different content", 409);
          }
        } else if (sequence !== nextSequence) {
          throw new DocumentServiceError("SEQUENCE_GAP", "Continuation batches must be strictly consecutive", 409, {
            nextSequence,
          });
        }
      }
      if (current.capabilityId === "document.edit") {
        const existing = current.items.find((item) => item.sequence === sequence);
        if (existing) {
          if (existing.contentHash !== batchHash) {
            throw new DocumentServiceError("SEQUENCE_CONFLICT", "Operation sequence already contains different content", 409);
          }
        } else if (sequence !== current.items.length + 1) {
          throw new DocumentServiceError("SEQUENCE_GAP", "Operation items must be strictly consecutive", 409);
        }
      }
      const commandId = `${id}:item:${sequence}:${batchHash}`;
      const duplicateContinuationBatch = continuation
        && sequence < nextSequence
        && batchHashes[String(sequence)] === batchHash;
      if (duplicateEditSequence || duplicateContinuationBatch) {
        const duplicate = await service.execute(id, {
          commandId,
          expectedRevision: current.revision,
          type: "item.append",
          payload: { sequence, operation: kind },
        }, () => {
          throw new DocumentServiceError("COMMAND_REPLAY_UNAVAILABLE", "The repeated operation item command is not available", 409);
        });
        return success({ operationId: id, patchId: id,
          operationIdCorrected: resolvedOperation.operationIdCorrected,
          operationInferred,
          acceptedSequence: sequence, duplicate: duplicate.duplicate,
          nextSequence: Math.max(nextSequence, sequence + 1), commitRequired: true,
          target: normalized.target, targetCorrected: normalized.corrected });
      }
      const sourceBytes = Buffer.byteLength(source, "utf8");
      const bytes = continuation
        ? Number(current.input.totalBytes ?? current.items.reduce(
            (sum, item) => sum + Buffer.byteLength(item.markdown, "utf8"),
            0,
          )) + sourceBytes
        : current.items.reduce((sum, item) => sum + Buffer.byteLength(item.markdown, "utf8"), 0) + sourceBytes;
      if (bytes > OPERATION_MAX_BYTES) throw new DocumentServiceError("SIZE_LIMIT", "Document operation exceeds 2 MiB");
      const document = authoritativeDocument(backend, current);
      const targetBlockIds = mutationTargetBlockIds(normalized.target);
      const readReceipt = typeof current.input.readReceipt === "string" ? current.input.readReceipt : "";
      const receipt = reads.require(readReceipt, context, document.id, document.version);
      reads.assertTargets(receipt, targetBlockIds);
      for (const blockId of targetBlockIds) {
        if (!findBlockPath(document.contentJson, blockId)) {
          throw new DocumentServiceError("BLOCK_NOT_FOUND", "Operation target is not in the base version", 409, {
            documentId: document.id,
            currentVersion: document.version,
            invalidBlockIds: [blockId],
            retryable: true,
            nextAction: "context_room_document_read",
          });
        }
      }
      if (!continuation && !duplicateEditSequence
        && current.items.some((item) => item.target && targetsOverlap(document.contentJson, item.target, normalized.target))) {
        throw new DocumentServiceError("PATCH_HUNK_OVERLAP", "Operation items must be independently applicable", 409);
      }
      let after = kind === "delete" ? [] : parseFragment(backend, document.id, document.roomId, source);
      const continuationProposal = continuation
        ? [...current.items.flatMap((item) => item.after), ...after]
        : after;
      if (continuation && repeatsExistingDocument(document.contentJson, continuationProposal)) {
        throw new DocumentServiceError(
          "CONTINUATION_REPEATS_DOCUMENT",
          "Continuation content substantially repeats the existing document. Use kind=edit with the smallest replace target and send only the replacement fragment.",
          409,
        );
      }
      let fragmentReduced = false;
      let adjacentContextStripped = false;
      let acceptedMarkdown = source;
      const oversizedEditReplacement = !continuation && kind === "replace"
        && (repeatsExistingDocument(document.contentJson, after)
          || tiptapText({ type: "doc", content: after }).length
            >= tiptapText(document.contentJson).length * 0.7);
      if (oversizedEditReplacement) {
        const reduced = reduceRepeatedFullDocumentEdit(document, normalized.target, after);
        if (reduced) {
          after = reduced;
          acceptedMarkdown = markdown.serialize({ type: "doc", content: after });
          fragmentReduced = true;
        }
      }
      if (!continuation && kind === "replace" && (!oversizedEditReplacement || fragmentReduced)) {
        const stripped = stripAdjacentTargetContext(document, normalized.target, after);
        after = stripped.content;
        adjacentContextStripped = stripped.stripped;
        if (stripped.stripped) {
          acceptedMarkdown = markdown.serialize({ type: "doc", content: after });
          fragmentReduced = true;
        }
      }
      if (!continuation && kind === "replace" && !after.length) {
        throw new DocumentServiceError(
          "EDIT_EMPTY_REPLACEMENT",
          "Replacement contains only context outside the selected target. Send the target's new content only.",
          409,
          { operationId: id, patchId: id, retryable: true, nextAction: "context_room_patch_hunk",
            expectedSequence: sequence, doNotRepeatPreviousArguments: true },
        );
      }
      const applied = applyDocumentMutation(proposedContent(document.contentJson, current.items), kind, normalized.target, after);
      if (!continuation && kind === "replace" && equivalentContent(applied.before, after)) {
        throw new DocumentServiceError(
          "EDIT_NO_CHANGE",
          "Replacement is identical to the selected target after removing adjacent context. Send content that actually changes only the target.",
          409,
          { operationId: id, patchId: id, retryable: true, nextAction: "context_room_patch_hunk",
            expectedSequence: sequence, doNotRepeatPreviousArguments: true },
        );
      }
      if (!continuation && kind === "replace" && requestsShorterReplacement(current.summary)) {
        const beforeCharacters = tiptapText({ type: "doc", content: applied.before }).trim().length;
        const afterCharacters = tiptapText({ type: "doc", content: after }).trim().length;
        const requiredReduction = Math.max(5, Math.ceil(beforeCharacters * 0.05));
        if (beforeCharacters >= 20 && afterCharacters > beforeCharacters - requiredReduction) {
          throw new DocumentServiceError(
            "EDIT_NOT_SHORTER",
            `Replacement must be meaningfully shorter than the selected target (before=${beforeCharacters}, after=${afterCharacters}).`,
            409,
            { operationId: id, patchId: id, retryable: true, nextAction: "context_room_patch_hunk",
              expectedSequence: sequence, doNotRepeatPreviousArguments: true,
              requiredMaximumCharacters: beforeCharacters - requiredReduction,
              beforeCharacters, afterCharacters, fragmentReduced, adjacentContextStripped },
          );
        }
      }
      if (!continuation
        && kind === "replace"
        && (repeatsExistingDocument(document.contentJson, after)
          || tiptapText({ type: "doc", content: after }).length
            >= tiptapText(document.contentJson).length * 0.7)) {
        const documentCharacters = tiptapText(document.contentJson).length;
        const targetCharacters = tiptapText({ type: "doc", content: applied.before }).length;
        if (targetCharacters < documentCharacters * 0.6) {
          throw new DocumentServiceError(
            "EDIT_REPEATS_DOCUMENT",
            "拒绝本次参数：markdown 几乎包含整篇文档或目标之外的未修改章节。不要重复本次参数；使用相同 operation/sequence/target 重试，但 markdown 只能包含目标块的新正文，不得包含文档标题和后续未修改章节。",
            409,
            {
              operationId: id,
              patchId: id,
              retryable: true,
              nextAction: "context_room_patch_hunk",
              expectedSequence: sequence,
              rejectedMarkdownBytes: sourceBytes,
              doNotRepeatPreviousArguments: true,
              retryWith: {
                operationId: id,
                sequence,
                operation: kind,
                target: normalized.target,
                markdown: "<只填写 target 的新正文片段，不含文档标题和未修改章节>",
              },
            },
          );
        }
      }
      let previousContinuationId = current.items.slice().sort((left, right) => left.sequence - right.sequence).at(-1)?.id;
      const additions = continuation ? after.map((node, index) => {
        const id = typeof node.attrs?.id === "string" ? node.attrs.id : randomUUID();
        const contentJson = { ...node, attrs: { ...node.attrs, id } };
        const target: DocumentMutationTarget = previousContinuationId
          ? { blockId: previousContinuationId, edge: "after" }
          : normalized.target;
        previousContinuationId = id;
        return { id, sequence: current.items.length + index + 1, operation: "insert" as const,
          target,
          before: [], after: [contentJson], markdown: markdown.serialize({ type: "doc", content: [contentJson] }),
          contentHash: contentHash(contentJson) };
      }) : [{ sequence, operation: kind as "insert" | "replace" | "delete", target: normalized.target, before: applied.before, after, markdown: acceptedMarkdown,
        contentHash: contentHash({ kind, target: normalized.target, source }) }];
      if (!additions.length) throw new DocumentServiceError("EMPTY_CONTINUATION", "Continuation has no content blocks");
      const result = await service.execute(id, {
        commandId,
        expectedRevision: current.revision, type: "item.append", payload: { sequence, operation: kind },
      }, () => ({
        addItems: additions,
        ...(continuation ? {
          input: {
            ...current.input,
            nextSequence: Math.max(nextSequence, sequence + 1),
            totalBytes: sequence === nextSequence ? bytes : current.input.totalBytes,
            batchHashes: sequence === nextSequence
              ? { ...batchHashes, [sequence]: batchHash }
              : batchHashes,
          },
        } : {}),
      }));
      return success({ operationId: id, patchId: id,
        operationIdCorrected: resolvedOperation.operationIdCorrected,
        operationInferred,
        acceptedSequence: sequence, duplicate: result.duplicate,
        nextSequence: sequence + 1, commitRequired: true, target: normalized.target,
        targetCorrected: normalized.corrected, fragmentReduced, adjacentContextStripped });
    },
  };
}

function commitTool(operations?: DocumentOperationService): DocumentCapabilityTool {
  return {
    name: "context_room_patch_commit", title: "提交文档修改建议供用户审阅",
    description: "完成所有修改项后仅转为待用户审阅，不会写入正文。工具成功只代表提案已准备好；Agent 的最终回复必须以本工具返回的 state/applied/documentChanged 为准。state=awaiting_review 时必须说明仍需用户接受，不能声称文档已修改。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      operationId: { type: "string", description: "兼容字段；省略时 Gateway 使用当前 run 唯一运行中的 Patch。" },
      patchId: { type: "string", description: "兼容旧 Agent 会话的别名；通常无需传入。" },
      finalSequence: { type: "integer", minimum: 1, description: "可省略；Gateway 以已接受的修改项数量为准。" },
    }, required: [] }, annotations: annotations(false),
    execute: async (args, context) => {
      const service = kernel(operations);
      const resolvedOperation = resolveRunningOperation(service, args, context.agentSessionId, context.runId);
      const operation = resolvedOperation.operation;
      const expected = operation.capabilityId === "document.continue"
        ? Number(operation.input.nextSequence ?? (operation.items.length ? 2 : 1)) - 1
        : operation.items.length;
      const requestedFinalSequence = args.finalSequence === undefined ? null : integerArg(args, "finalSequence");
      if (expected < 1 || (requestedFinalSequence !== null && requestedFinalSequence < expected)) {
        throw new DocumentServiceError("SEQUENCE_GAP", "Final sequence does not match received items", 409, {
          expectedFinalSequence: expected,
        });
      }
      const finalSequence = expected;
      const finalSequenceCorrected = requestedFinalSequence !== null && requestedFinalSequence !== expected;
      const prepared = await service.execute(operation.id, {
        commandId: `${operation.id}:prepare:${finalSequence}`, expectedRevision: operation.revision,
        type: "operation.prepare", payload: { finalSequence },
      }, () => ({ status: "awaiting_review", expiresAt: null }));
      return success({ operationId: operation.id, patchId: operation.id,
        operationIdCorrected: resolvedOperation.operationIdCorrected,
        finalSequence, finalSequenceCorrected,
        state: "awaiting_review", applied: false, documentChanged: false,
        documentVersion: operation.baseVersion, nextAction: "user_review_required",
        message: "修改建议已准备好，尚未写入文档；需要用户审阅并接受后才会应用。", patch: {
        id: operation.id, roomId: operation.roomId, documentId: operation.documentId, documentTitle: operation.documentTitle,
        baseVersion: operation.baseVersion, kind: operation.capabilityId === "document.continue" ? "continue" : "edit",
        status: "pending", summary: operation.summary, hunkCount: prepared.operation.items.length,
        addedCharacters: prepared.operation.items.reduce((sum, item) => sum + tiptapText({ type: "doc", content: item.after }).length, 0),
        deletedCharacters: prepared.operation.items.reduce((sum, item) => sum + tiptapText({ type: "doc", content: item.before }).length, 0),
        createdAt: operation.createdAt, updatedAt: prepared.operation.updatedAt,
      }, navigation: { pageId: "rooms", title: operation.documentTitle, action: "opened", roomId: operation.roomId,
        objectId: operation.documentId, objectType: "document" } });
    },
  };
}

function abortTool(operations?: DocumentOperationService): DocumentCapabilityTool {
  return {
    name: "context_room_patch_abort", title: "中止文档修改建议", description: "中止尚未提交审阅的文档修改操作。",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      operationId: { type: "string", description: "兼容字段；省略时 Gateway 使用当前 run 唯一运行中的 Patch。" },
      patchId: { type: "string", description: "兼容旧 Agent 会话的别名；通常无需传入。" },
      reason: { type: "string", maxLength: 1000 },
    }, required: [] }, annotations: annotations(false, true),
    execute: async (args, context) => {
      const service = kernel(operations);
      const resolvedOperation = resolveRunningOperation(service, args, context.agentSessionId, context.runId);
      const operation = resolvedOperation.operation;
      await service.execute(operation.id, { commandId: `${operation.id}:cancel`, expectedRevision: operation.revision,
        type: "operation.cancel", payload: { reason: typeof args.reason === "string" ? args.reason : "agent-aborted" } },
      () => ({ status: "cancelled", complete: true }));
      return success({ operationId: operation.id, patchId: operation.id,
        operationIdCorrected: resolvedOperation.operationIdCorrected, state: "cancelled" });
    },
  };
}

async function editCommand(backend: CapabilityBackend, operation: DocumentOperation, command: DocumentOperationCommandInput): Promise<DocumentOperationCommandMutation> {
  if (command.type === "review.reject") return { status: "rejected", updateItems: operation.items.map((item) => ({ id: item.id, status: "rejected" })), complete: true };
  if (command.type === "operation.cancel") return { status: "cancelled", complete: true };
  if (command.type !== "review.apply" || !operation.documentId) throw new DocumentServiceError("UNSUPPORTED_OPERATION_COMMAND", `Command ${command.type} is not allowed`, 409);
  const ids = Array.isArray(command.payload?.acceptedItemIds) ? command.payload.acceptedItemIds.filter((value): value is string => typeof value === "string") : [];
  if (!ids.length) throw new DocumentServiceError("EMPTY_PATCH_SELECTION", "Apply requires an accepted item");
  const accepted = new Set(ids);
  if (ids.some((id) => !operation.items.some((item) => item.id === id))) throw new DocumentServiceError("INVALID_HUNK_SELECTION", "Accepted item is invalid");
  const overrides = replacementMarkdownMap(command);
  for (const itemId of overrides.keys()) {
    const item = operation.items.find((candidate) => candidate.id === itemId);
    if (!item || !accepted.has(itemId)) {
      throw new DocumentServiceError("INVALID_HUNK_OVERRIDE", "Replacement Markdown may only override an accepted item");
    }
    if (item.operation === "delete") {
      throw new DocumentServiceError("DELETE_OVERRIDE_NOT_ALLOWED", "Delete items cannot contain replacement Markdown");
    }
  }
  const document = authoritativeDocument(backend, operation);
  const auditFields = new Map<string, ReturnType<typeof replacementAuditFields>>();
  let contentJson = document.contentJson;
  for (const item of [...operation.items].sort((left, right) => left.sequence - right.sequence)) {
    if (!accepted.has(item.id) || !item.target) continue;
    const source = overrides.get(item.id);
    const after = source === undefined
      ? item.after
      : validatedReplacementMarkdown(backend, document, source);
    if (source !== undefined) auditFields.set(item.id, replacementAuditFields(source, after));
    contentJson = applyDocumentMutation(contentJson, item.operation as "insert" | "replace" | "delete", item.target, after).content;
  }
  const commit = backend.prepareOperationCommit(document.id, {
    baseVersion: document.version,
    contentJson,
  });
  return { status: "completed", result: { acceptedItemIds: ids, version: commit.version },
    updateItems: operation.items.map((item) => ({ id: item.id, status: accepted.has(item.id) ? "applied" : "rejected",
      appliedVersion: accepted.has(item.id) ? commit.version : null,
      ...(auditFields.get(item.id) ?? {}) })),
    commit,
    complete: true,
    afterCommit: (saved) => saved && backend.notifyDocumentRewriteApplied({ sessionId: operation.sessionId, roomId: operation.roomId,
      runId: operation.runId, operationId: operation.id, documentId: saved.id, title: saved.title, instruction: operation.summary,
      originalText: tiptapText(document.contentJson), replacementText: tiptapText(saved.contentJson) }) };
}

async function continuationCommand(backend: CapabilityBackend, operation: DocumentOperation, command: DocumentOperationCommandInput): Promise<DocumentOperationCommandMutation> {
  if (command.type === "operation.cancel") return { status: "cancelled", complete: true };
  if (command.type === "review.close") {
    const applied = operation.items.some((item) => item.status === "applied");
    return { status: applied ? "completed" : "rejected", updateItems: pendingItems(operation).map((item) => ({ id: item.id, status: "rejected" })), complete: true };
  }
  if (command.type !== "item.accept" && command.type !== "item.reject") throw new DocumentServiceError("UNSUPPORTED_OPERATION_COMMAND", `Command ${command.type} is not allowed`, 409);
  const item = pendingItems(operation)[0];
  if (!item || item.id !== command.payload?.itemId) throw new DocumentServiceError("CONTINUATION_OUT_OF_ORDER", "Decide the current item first", 409);
  if (command.type === "item.reject") {
    const remaining = pendingItems(operation).slice(1);
    const applied = operation.items.some((candidate) => candidate.status === "applied");
    return { status: remaining.length ? "awaiting_review" : applied ? "completed" : "rejected",
      updateItems: [{ id: item.id, status: "rejected" }], complete: !remaining.length };
  }
  if (!operation.documentId) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
  const document = backend.get(operation.documentId);
  if (!document) throw new DocumentServiceError("NOT_FOUND", "Document not found", 404);
  if (document.version !== operation.baseVersion) throw new DocumentServiceError("DOCUMENT_CONFLICT", "Document version has changed", 409, { currentDocument: document });
  const rawReplacement = command.payload?.replacementMarkdown;
  if (rawReplacement !== undefined && typeof rawReplacement !== "string") {
    throw new DocumentServiceError("INVALID_REPLACEMENT_MARKDOWN", "Replacement Markdown must be a string");
  }
  let after = item.after;
  let auditFields: ReturnType<typeof replacementAuditFields> | undefined;
  if (typeof rawReplacement === "string") {
    const parsed = validatedReplacementMarkdown(backend, document, rawReplacement);
    if (parsed.length !== 1) {
      throw new DocumentServiceError("CONTINUATION_REPLACEMENT_BLOCK_COUNT", "Continuation replacement must contain exactly one top-level block");
    }
    const node = parsed[0]!;
    after = [{ ...node, attrs: { ...node.attrs, id: item.id } }];
    auditFields = replacementAuditFields(rawReplacement, after);
  }
  const ordered = [...operation.items].sort((left, right) => left.sequence - right.sequence);
  const lastApplied = ordered.filter((candidate) => candidate.status === "applied").at(-1);
  const target: DocumentMutationTarget = lastApplied ? { blockId: lastApplied.id, edge: "after" } : ordered[0]!.target!;
  const commit = backend.prepareOperationCommit(document.id, {
    baseVersion: document.version,
    contentJson: applyDocumentMutation(document.contentJson, "insert", target, after).content,
  });
  const remaining = pendingItems(operation).slice(1);
  return { status: remaining.length ? "awaiting_review" : "completed", baseVersion: commit.version,
    updateItems: [{ id: item.id, status: "applied", appliedVersion: commit.version, ...(auditFields ?? {}) }],
    result: remaining.length ? null : { version: commit.version }, commit, complete: !remaining.length };
}

export function reviewPlugins(
  backend: CapabilityBackend,
  operations: DocumentOperationService | undefined,
  reads: DocumentReadAuthority,
): DocumentCapabilityPlugin[] {
  const tools = [beginTool(backend, operations, reads), hunkTool(backend, operations, reads), commitTool(operations), abortTool(operations)];
  return [
    { manifest: manifest("document.edit", "mutation", "atomic_review", "atomic-diff", true, true),
      promptGuidelines: ["修改已有文档前必须先读取权威版本；Gateway 会在当前 run 内自动绑定读取凭证和唯一运行中的 Patch，后续工具无需搬运 readReceipt、operationId 或 patchId。重写、润色、扩写、替换或删除已有内容必须使用 kind=edit，kind=continue 只追加全新内容。Agent 只能生成提案，不能直接应用。edit 应选择用户要求修改的最小 target，replace Markdown 只包含该 target 的替换片段，不得重发未修改的全文。单次工具失败若返回 retryable=true，应修正参数并重试；最终回复以最后一次工具结果为准，不能把已恢复的失败说成整轮失败。patch_commit 后必须按返回的 state/applied/documentChanged 描述状态；awaiting_review 时只能说修改建议已准备好、等待用户审阅，不能声称正文已修改。"], tools,
      command: (operation, command) => editCommand(backend, operation, command) },
    { manifest: manifest("document.continue", "mutation", "incremental_review", "continuation", true, true),
      promptGuidelines: ["continue 只用于追加原文中不存在的全新内容，不能用于重写、润色、扩写或替换已有段落。普通续写默认插入文末；长篇内容可按连续 sequence 分批生成，每批只能发送该批新增片段，禁止发送累计内容、原文或全文，最终由用户逐块接受。"], tools: [],
      command: (operation, command) => continuationCommand(backend, operation, command) },
  ];
}
