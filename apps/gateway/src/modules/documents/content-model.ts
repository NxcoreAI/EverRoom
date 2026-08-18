import { randomUUID } from "node:crypto";
import type {
  DocumentBlockSummary,
  DocumentPatchOperation,
  DocumentPatchTarget,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { DocumentServiceError } from "./errors.js";

export const REFERENCABLE_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "listItem",
  "taskItem",
]);

const TEXT_PREVIEW_LIMIT = 240;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pathKey(path: number[]): string {
  return path.join(".");
}

export function tiptapText(node: TiptapJsonContent): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(tiptapText).join("");
}

function textPreview(node: TiptapJsonContent): string {
  let value = "";
  const visit = (candidate: TiptapJsonContent) => {
    if (value.length >= TEXT_PREVIEW_LIMIT * 2) return;
    if (typeof candidate.text === "string") {
      value += candidate.text.slice(0, TEXT_PREVIEW_LIMIT * 2 - value.length);
      return;
    }
    if (candidate.type === "hardBreak") value += "\n";
    candidate.content?.forEach(visit);
  };
  visit(node);
  return value.replace(/\s+/g, " ").trim().slice(0, TEXT_PREVIEW_LIMIT);
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function previousIds(content?: TiptapJsonContent): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (node: TiptapJsonContent, path: number[]) => {
    if (REFERENCABLE_BLOCK_TYPES.has(node.type) && validBlockId(node.attrs?.id)) {
      result.set(`${pathKey(path)}\0${node.type}`, node.attrs.id);
    }
    node.content?.forEach((child, index) => visit(child, [...path, index]));
  };
  if (content) visit(content, []);
  return result;
}

function explicitIds(content: TiptapJsonContent): Set<string> {
  const result = new Set<string>();
  const visit = (node: TiptapJsonContent) => {
    if (REFERENCABLE_BLOCK_TYPES.has(node.type) && validBlockId(node.attrs?.id)) {
      result.add(node.attrs.id);
    }
    node.content?.forEach(visit);
  };
  visit(content);
  return result;
}

export interface NormalizeDocumentOptions {
  previous?: TiptapJsonContent;
  owners?: Map<string, string>;
}

export function normalizeDocumentContent(
  content: TiptapJsonContent,
  documentId: string,
  roomId: string,
  options: NormalizeDocumentOptions = {},
): { content: TiptapJsonContent; blocks: DocumentBlockSummary[]; changed: boolean } {
  const seen = new Set<string>();
  const prior = previousIds(options.previous);
  const incomingIds = explicitIds(content);
  const blocks: DocumentBlockSummary[] = [];
  let ordinal = 0;
  let changed = false;

  const visit = (
    source: TiptapJsonContent,
    path: number[],
    parentBlockId: string | null,
  ): TiptapJsonContent => {
    let node: TiptapJsonContent = {
      ...source,
      ...(source.attrs ? { attrs: { ...source.attrs } } : {}),
      ...(source.marks ? { marks: source.marks.map((mark) => ({
        ...mark,
        ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}),
      })) } : {}),
    };
    let nextParent = parentBlockId;
    if (REFERENCABLE_BLOCK_TYPES.has(node.type)) {
      const explicit = node.attrs?.id;
      const fallback = prior.get(`${pathKey(path)}\0${node.type}`);
      const usable = (candidate: unknown): candidate is string => validBlockId(candidate)
        && !seen.has(candidate)
        && (!options.owners?.has(candidate) || options.owners.get(candidate) === documentId);
      // A supplied duplicate belongs to the original block encountered first;
      // copies always receive a fresh identity. Path fallback is only for old
      // clients that omitted IDs entirely, and must never steal an ID that is
      // still present elsewhere in the incoming document.
      const canRestoreFallback = explicit === undefined
        && !incomingIds.has(fallback ?? "")
        && usable(fallback);
      const id = usable(explicit) ? explicit : canRestoreFallback ? fallback : randomUUID();
      if (explicit !== id) changed = true;
      node.attrs = { ...node.attrs, id };
      seen.add(id);
      options.owners?.set(id, documentId);
      nextParent = id;
      blocks.push({
        id,
        documentId,
        roomId,
        parentBlockId,
        type: node.type,
        ordinal: ordinal++,
        path,
        textPreview: "",
      });
    }
    if (node.content) {
      node.content = node.content.map((child, index) => visit(child, [...path, index], nextParent));
    }
    if (nextParent && blocks.length > 0) {
      const block = blocks.find((candidate) => candidate.id === nextParent);
      if (block) block.textPreview = textPreview(node);
    }
    return node;
  };

  const normalized = visit(content, [], null);
  return { content: normalized, blocks, changed };
}

export function collectDocumentReferences(content: TiptapJsonContent): Array<{
  roomId: string;
  documentId: string;
  blockId: string;
}> {
  const references: Array<{ roomId: string; documentId: string; blockId: string }> = [];
  const visit = (node: TiptapJsonContent) => {
    if (node.type === "documentBlockReference") {
      const roomId = node.attrs?.targetRoomId;
      const documentId = node.attrs?.targetDocumentId;
      const blockId = node.attrs?.targetBlockId;
      if (typeof roomId !== "string" || !roomId.trim()
        || typeof documentId !== "string" || !documentId.trim()
        || typeof blockId !== "string" || !blockId.trim()) {
        throw new DocumentServiceError(
          "INVALID_BLOCK_REFERENCE",
          "Document block references require targetRoomId, targetDocumentId, and targetBlockId",
        );
      }
      references.push({ roomId, documentId, blockId });
    }
    node.content?.forEach(visit);
  };
  visit(content);
  return references;
}

export function findBlockPath(content: TiptapJsonContent, blockId: string): number[] | null {
  let result: number[] | null = null;
  const visit = (node: TiptapJsonContent, path: number[]) => {
    if (result) return;
    if (node.attrs?.id === blockId) {
      result = path;
      return;
    }
    node.content?.forEach((child, index) => visit(child, [...path, index]));
  };
  visit(content, []);
  return result;
}

export function nodeAtPath(content: TiptapJsonContent, path: number[]): TiptapJsonContent {
  let node = content;
  for (const index of path) {
    const child = node.content?.[index];
    if (!child) throw new DocumentServiceError("ANCHOR_INVALID", "Document block path is no longer valid", 409);
    node = child;
  }
  return node;
}

function parentAtPath(content: TiptapJsonContent, path: number[]) {
  if (path.length === 0) throw new DocumentServiceError("ANCHOR_INVALID", "The document root cannot be patched", 409);
  const parentPath = path.slice(0, -1);
  const parent = nodeAtPath(content, parentPath);
  if (!parent.content) parent.content = [];
  return { parent, parentPath, index: path[path.length - 1]! };
}

function nodesForParent(parent: TiptapJsonContent, after: TiptapJsonContent[]): TiptapJsonContent[] {
  if (["bulletList", "orderedList", "taskList"].includes(parent.type)
    && after.length === 1
    && after[0]?.type === parent.type) {
    return clone(after[0].content ?? []);
  }
  return clone(after);
}

function inlineLength(node: TiptapJsonContent): number {
  if (typeof node.text === "string") return node.text.length;
  if (node.type === "hardBreak") return 1;
  return (node.content ?? []).reduce((total, child) => total + inlineLength(child), 0);
}

function splitInlineChildren(
  children: TiptapJsonContent[],
  offset: number,
): [TiptapJsonContent[], TiptapJsonContent[]] {
  const before: TiptapJsonContent[] = [];
  const after: TiptapJsonContent[] = [];
  let remaining = offset;
  for (const child of children) {
    const length = inlineLength(child);
    if (remaining <= 0) {
      after.push(clone(child));
    } else if (remaining >= length) {
      before.push(clone(child));
      remaining -= length;
    } else if (typeof child.text === "string") {
      const left = child.text.slice(0, remaining);
      const right = child.text.slice(remaining);
      if (left) before.push({ ...clone(child), text: left });
      if (right) after.push({ ...clone(child), text: right });
      remaining = 0;
    } else {
      throw new DocumentServiceError("ANCHOR_INVALID", "Cursor offsets must fall inside a text node", 409);
    }
  }
  if (remaining !== 0) throw new DocumentServiceError("ANCHOR_INVALID", "Cursor offset exceeds block text", 409);
  return [before, after];
}

function inlineReplacement(
  source: TiptapJsonContent,
  fromOffset: number,
  toOffset: number,
  after: TiptapJsonContent[],
  insertion: boolean,
): TiptapJsonContent[] {
  if (!["paragraph", "heading", "codeBlock"].includes(source.type)) {
    throw new DocumentServiceError("ANCHOR_INVALID", "Inline patches require a text block", 409);
  }
  const length = inlineLength(source);
  if (!Number.isSafeInteger(fromOffset) || !Number.isSafeInteger(toOffset)
    || fromOffset < 0 || toOffset < fromOffset || toOffset > length) {
    throw new DocumentServiceError("ANCHOR_INVALID", "Patch offsets are outside the target block", 409);
  }
  const text = tiptapText(source);
  for (const offset of [fromOffset, toOffset]) {
    if (offset > 0 && offset < text.length) {
      const previous = text.charCodeAt(offset - 1);
      const next = text.charCodeAt(offset);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        throw new DocumentServiceError("ANCHOR_INVALID", "Patch offset splits a Unicode character", 409);
      }
    }
  }
  const [prefix] = splitInlineChildren(source.content ?? [], fromOffset);
  const [, suffix] = splitInlineChildren(source.content ?? [], toOffset);
  const result: TiptapJsonContent[] = [];
  if (prefix.length > 0) result.push({ ...clone(source), content: prefix });
  result.push(...clone(after));
  if (suffix.length > 0) {
    const attrs = { ...source.attrs };
    if (!insertion || prefix.length > 0) delete attrs.id;
    result.push({ ...clone(source), attrs, content: suffix });
  }
  if (result.length === 0) return [];
  if (!insertion && prefix.length === 0) {
    const first = result[0]!;
    result[0] = {
      ...first,
      attrs: {
        ...first.attrs,
        ...(validBlockId(source.attrs?.id) ? { id: source.attrs.id } : {}),
      },
    };
  }
  return result;
}

export function patchTargetBlockIds(target: DocumentPatchTarget): string[] {
  if ("at" in target) return [];
  if ("blockId" in target) return [target.blockId];
  return [target.fromBlockId, target.toBlockId];
}

export function applyDocumentPatchHunk(
  source: TiptapJsonContent,
  operation: DocumentPatchOperation,
  target: DocumentPatchTarget,
  after: TiptapJsonContent[],
): { content: TiptapJsonContent; before: TiptapJsonContent[] } {
  const content = clone(source);
  if ("at" in target) {
    if (operation !== "insert") throw new DocumentServiceError("INVALID_PATCH", "Document end only supports insert");
    content.content = [...(content.content ?? []), ...clone(after)];
    return { content, before: [] };
  }

  if ("fromBlockId" in target) {
    if (operation === "insert") throw new DocumentServiceError("INVALID_PATCH", "Block ranges do not support insert");
    const fromPath = findBlockPath(content, target.fromBlockId);
    const toPath = findBlockPath(content, target.toBlockId);
    if (!fromPath || !toPath) throw new DocumentServiceError("BLOCK_NOT_FOUND", "Patch block was not found", 409);
    const fromParent = parentAtPath(content, fromPath);
    const toParent = parentAtPath(content, toPath);
    if (pathKey(fromParent.parentPath) !== pathKey(toParent.parentPath)) {
      throw new DocumentServiceError("ANCHOR_INVALID", "Patch block ranges must share a parent", 409);
    }
    const start = Math.min(fromParent.index, toParent.index);
    const end = Math.max(fromParent.index, toParent.index);
    const before = clone(fromParent.parent.content!.slice(start, end + 1));
    const replacement = operation === "delete" ? [] : nodesForParent(fromParent.parent, after);
    fromParent.parent.content!.splice(start, end - start + 1, ...replacement);
    return { content, before };
  }

  const path = findBlockPath(content, target.blockId);
  if (!path) throw new DocumentServiceError("BLOCK_NOT_FOUND", "Patch block was not found", 409);
  const { parent, index } = parentAtPath(content, path);
  const current = parent.content![index]!;
  if ("edge" in target) {
    if (operation !== "insert") throw new DocumentServiceError("INVALID_PATCH", "Block edges only support insert");
    const insertAt = target.edge === "before" ? index : index + 1;
    parent.content!.splice(insertAt, 0, ...nodesForParent(parent, after));
    return { content, before: [] };
  }

  const hasOffsets = target.fromOffset !== undefined || target.toOffset !== undefined;
  if (hasOffsets) {
    const fromOffset = target.fromOffset ?? target.toOffset ?? 0;
    const toOffset = target.toOffset ?? fromOffset;
    const replacement = operation === "delete" ? [] : after;
    const nodes = inlineReplacement(current, fromOffset, toOffset, replacement, operation === "insert");
    parent.content!.splice(index, 1, ...nodesForParent(parent, nodes));
    return { content, before: [clone(current)] };
  }
  if (operation === "insert") throw new DocumentServiceError("INVALID_PATCH", "Insert requires an edge or offset");
  const replacement = operation === "delete" ? [] : nodesForParent(parent, after);
  parent.content!.splice(index, 1, ...replacement);
  return { content, before: [clone(current)] };
}

type PatchTargetRegion =
  | { kind: "insert"; key: string; anchorPath: number[] | null }
  | { kind: "mutation"; paths: number[][] };

function pathStartsWith(path: number[], prefix: number[]): boolean {
  return prefix.length <= path.length && prefix.every((value, index) => path[index] === value);
}

function targetRegion(content: TiptapJsonContent, target: DocumentPatchTarget): PatchTargetRegion {
  if ("at" in target) {
    return { kind: "insert", key: `:${content.content?.length ?? 0}`, anchorPath: null };
  }
  if ("fromBlockId" in target) {
    const fromPath = findBlockPath(content, target.fromBlockId);
    const toPath = findBlockPath(content, target.toBlockId);
    if (!fromPath || !toPath) return { kind: "mutation", paths: [] };
    const fromParent = fromPath.slice(0, -1);
    const toParent = toPath.slice(0, -1);
    if (pathKey(fromParent) !== pathKey(toParent)) return { kind: "mutation", paths: [fromPath, toPath] };
    const start = Math.min(fromPath.at(-1)!, toPath.at(-1)!);
    const end = Math.max(fromPath.at(-1)!, toPath.at(-1)!);
    return {
      kind: "mutation",
      paths: Array.from({ length: end - start + 1 }, (_, index) => [...fromParent, start + index]),
    };
  }
  const path = findBlockPath(content, target.blockId);
  if (!path) return { kind: "mutation", paths: [] };
  if ("edge" in target) {
    const parentPath = path.slice(0, -1);
    const index = path.at(-1)! + (target.edge === "after" ? 1 : 0);
    return { kind: "insert", key: `${pathKey(parentPath)}:${index}`, anchorPath: path };
  }
  return { kind: "mutation", paths: [path] };
}

export function targetsOverlap(
  content: TiptapJsonContent,
  left: DocumentPatchTarget,
  right: DocumentPatchTarget,
): boolean {
  const leftRegion = targetRegion(content, left);
  const rightRegion = targetRegion(content, right);
  if (leftRegion.kind === "insert" && rightRegion.kind === "insert") {
    return leftRegion.key === rightRegion.key;
  }
  if (leftRegion.kind === "mutation" && rightRegion.kind === "mutation") {
    return leftRegion.paths.some((leftPath) => rightRegion.paths.some((rightPath) =>
      pathStartsWith(leftPath, rightPath) || pathStartsWith(rightPath, leftPath)));
  }
  if (leftRegion.kind === "insert" && rightRegion.kind === "mutation") {
    return leftRegion.anchorPath !== null
      && rightRegion.paths.some((path) => pathStartsWith(leftRegion.anchorPath!, path));
  }
  if (rightRegion.kind === "insert" && leftRegion.kind === "mutation") {
    return rightRegion.anchorPath !== null
      && leftRegion.paths.some((path) => pathStartsWith(rightRegion.anchorPath!, path));
  }
  return false;
}
