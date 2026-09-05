import type { TiptapJsonContent } from "@nxcore/agent-contract";

export const DOCUMENT_CONTENT_SCHEMA_VERSION = 3;
export const DOCUMENT_TITLE_NODE_TYPE = "documentTitle";

export const ADDRESSABLE_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "documentBlockReference",
] as const;

export const addressableBlockTypes: ReadonlySet<string> = new Set(ADDRESSABLE_BLOCK_TYPES);

export interface ProjectedDocumentBlock {
  blockId: string;
  parentBlockId: string | null;
  rootBlockId: string;
  type: string;
  siblingIndex: number;
  ordinal: number;
  path: number[];
  depth: number;
  textPreview: string;
}

export interface ProjectedDocumentReference {
  sourceBlockId: string;
  targetRoomId: string;
  targetDocumentId: string;
  targetBlockId: string;
  ordinal: number;
}

export interface EverroomBlockReference {
  roomId: string;
  documentId: string;
  blockId: string;
  fallbackTitle?: string | null;
  fallbackPreview?: string | null;
}

export interface NormalizeDocumentOptions {
  createId?: () => string;
}

export interface FreshenDocumentOptions {
  createId?: () => string;
}

export interface NormalizedDocumentContent {
  content: TiptapJsonContent;
  blocks: ProjectedDocumentBlock[];
  references: ProjectedDocumentReference[];
  changed: boolean;
  schemaVersion: number;
}

const TEXT_PREVIEW_LIMIT = 240;
const DOCUMENT_TITLE_LIMIT = 120;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cleanOptionalText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export function createEverroomBlockReferenceUrl(reference: EverroomBlockReference): string {
  const path = [reference.roomId, reference.documentId, reference.blockId]
    .map((part) => encodeURIComponent(part))
    .join("/");
  const query = new URLSearchParams();
  const title = cleanOptionalText(reference.fallbackTitle);
  const preview = cleanOptionalText(reference.fallbackPreview);
  if (title) query.set("title", title);
  if (preview) query.set("preview", preview);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `everroom://room/${path}${suffix}`;
}

export function parseEverroomBlockReferenceUrl(value: string): EverroomBlockReference | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "everroom:" || url.hostname !== "room") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) return null;
  try {
    const [roomId, documentId, blockId] = parts.map(decodeURIComponent);
    if (!roomId || !documentId || !blockId) return null;
    return {
      roomId,
      documentId,
      blockId,
      fallbackTitle: cleanOptionalText(url.searchParams.get("title")),
      fallbackPreview: cleanOptionalText(url.searchParams.get("preview")),
    };
  } catch {
    return null;
  }
}

export function isValidBlockId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

export interface EverroomMemoryIndex {
  roomId: string;
  memoryId: string;
  fallbackTitle?: string | null;
  fallbackPreview?: string | null;
}

/**
 * Block index mark targets. `document` points at a same-Room document block;
 * `memory` points at a Room-local memory item. The two URL hosts (`room` with
 * 3 path segments vs `memory` with 2) are disjoint by construction, so the
 * legacy `parseEverroomBlockReferenceUrl` never misreads a memory URL.
 */
export type EverroomBlockIndexTarget =
  | ({ kind: "document" } & EverroomBlockReference)
  | ({ kind: "memory" } & EverroomMemoryIndex);

const MEMORY_INDEX_HOST = "memory";

export function createEverroomMemoryIndexUrl(target: EverroomMemoryIndex): string {
  const path = [target.roomId, target.memoryId]
    .map((part) => encodeURIComponent(part))
    .join("/");
  const query = new URLSearchParams();
  const title = cleanOptionalText(target.fallbackTitle);
  const preview = cleanOptionalText(target.fallbackPreview);
  if (title) query.set("title", title);
  if (preview) query.set("preview", preview);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `everroom://${MEMORY_INDEX_HOST}/${path}${suffix}`;
}

export function parseEverroomMemoryIndexUrl(value: string): EverroomMemoryIndex | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "everroom:" || url.hostname !== MEMORY_INDEX_HOST) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  try {
    const [roomId, memoryId] = parts.map(decodeURIComponent);
    if (!roomId || !memoryId) return null;
    return {
      roomId,
      memoryId,
      fallbackTitle: cleanOptionalText(url.searchParams.get("title")),
      fallbackPreview: cleanOptionalText(url.searchParams.get("preview")),
    };
  } catch {
    return null;
  }
}

export function everroomBlockIndexUrl(target: EverroomBlockIndexTarget): string {
  return target.kind === "document"
    ? createEverroomBlockReferenceUrl(target)
    : createEverroomMemoryIndexUrl(target);
}

function escapeBlockIndexLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1").replace(/[\r\n]+/g, " ").trim();
}

function unescapeBlockIndexLabel(value: string): string {
  return value.replace(/\\([\\[\]])/g, "$1").trim();
}

/**
 * Markdown form of a block index mark: `^[label](everroom://...)`, written at
 * the end of the host block's text. The `^[` prefix keeps it disjoint from
 * plain markdown links and from the block-level reference tokenizer (which
 * only claims line-leading `[label](everroom://...)`).
 */
export function formatBlockIndexMarkMarkdown(target: EverroomBlockIndexTarget, label: string): string {
  const escaped = escapeBlockIndexLabel(label) || escapeBlockIndexLabel(target.fallbackTitle || "");
  // The label already carries the title; writing it into the URL query too
  // would make serialize(parse(x)) grow on every round trip.
  const redundantTitle = cleanOptionalText(target.fallbackTitle) === cleanOptionalText(escaped);
  const effective = redundantTitle
    ? { ...target, fallbackTitle: null as string | null }
    : target;
  return `^[${escaped}](${everroomBlockIndexUrl(effective)})`;
}

const BLOCK_INDEX_MARK_PATTERN =
  /^\^\[((?:\\.|[^\]])*)\]\((everroom:\/\/[^\s)]+)(?:\s+["'][^)]*["'])?\)/;

/** 块索引匹配原语：去除全部空白，消除排版差异对包含判断的干扰。 */
export function normalizeIndexText(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * 块索引匹配原语：来源块的匹配探针（归一化后前 80 字符）。
 * 短于 20 字符的探针特异性不足，返回 null（宁缺毋滥）。
 */
export function buildIndexProbe(textPreview: string): string | null {
  const probe = normalizeIndexText(textPreview).slice(0, 80);
  return probe.length >= 20 ? probe : null;
}

export function parseBlockIndexMarkMarkdown(
  text: string,
): { target: EverroomBlockIndexTarget; label: string | null; raw: string } | null {
  const match = text.match(BLOCK_INDEX_MARK_PATTERN);
  const raw = match?.[0];
  const rawLabel = match?.[1];
  const rawUrl = match?.[2];
  if (!match || !raw || rawLabel === undefined || !rawUrl) return null;
  const label = unescapeBlockIndexLabel(rawLabel) || null;

  const memory = parseEverroomMemoryIndexUrl(rawUrl);
  if (memory) {
    return {
      target: {
        kind: "memory",
        ...memory,
        fallbackTitle: memory.fallbackTitle || cleanOptionalText(label ?? undefined),
      },
      label,
      raw,
    };
  }
  const reference = parseEverroomBlockReferenceUrl(rawUrl);
  if (!reference) return null;
  return {
    target: {
      kind: "document",
      ...reference,
      fallbackTitle: reference.fallbackTitle || cleanOptionalText(label ?? undefined),
    },
    label,
    raw,
  };
}

export function tiptapText(node: TiptapJsonContent): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(tiptapText).join("");
}

export function documentTitleText(node: TiptapJsonContent | undefined): string {
  if (!node || node.type !== DOCUMENT_TITLE_NODE_TYPE) return "";
  return tiptapText(node).trim().slice(0, DOCUMENT_TITLE_LIMIT);
}

/** Removes the retired editor title node from persisted body content. */
export function stripDocumentTitle(
  source: TiptapJsonContent,
): { content: TiptapJsonContent; legacyTitle: string | null; changed: boolean } {
  const input = clone(source);
  const children = [...(input.content ?? [])];
  const existingTitle = children.find((node) => node.type === DOCUMENT_TITLE_NODE_TYPE);
  const normalized = {
    ...input,
    content: children.filter((node) => node.type !== DOCUMENT_TITLE_NODE_TYPE),
  };
  return {
    content: normalized,
    legacyTitle: documentTitleText(existingTitle) || null,
    changed: JSON.stringify(normalized) !== JSON.stringify(source),
  };
}

export function documentBodyContent(source: TiptapJsonContent): TiptapJsonContent {
  return stripDocumentTitle(source).content;
}

export function hasEmbeddedDocumentImages(source: TiptapJsonContent): boolean {
  if (source.type === "image" && typeof source.attrs?.src === "string") {
    return source.attrs.src.startsWith("data:image/");
  }
  return (source.content ?? []).some(hasEmbeddedDocumentImages);
}

/** Assigns fresh IDs to an imported tree and preserves its internal references. */
export function freshenDocumentContent(
  source: TiptapJsonContent,
  documentId: string,
  options: FreshenDocumentOptions = {},
): TiptapJsonContent {
  const createId = options.createId ?? defaultCreateId;
  const idMap = new Map<string, string>();
  const assignIds = (input: TiptapJsonContent): TiptapJsonContent => {
    const node = clone(input);
    if (addressableBlockTypes.has(node.type)) {
      const nextId = createId();
      const previousId = node.attrs?.id;
      if (isValidBlockId(previousId) && !idMap.has(previousId)) idMap.set(previousId, nextId);
      node.attrs = { ...node.attrs, id: nextId };
    }
    if (node.content) node.content = node.content.map(assignIds);
    return node;
  };
  const rewriteReferences = (input: TiptapJsonContent): TiptapJsonContent => {
    const node: TiptapJsonContent = {
      ...input,
      ...(input.attrs ? { attrs: { ...input.attrs } } : {}),
      ...(input.marks ? { marks: input.marks.map((mark) => ({
        ...mark,
        ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}),
      })) } : {}),
    };
    if (node.type === "documentBlockReference"
      && node.attrs?.targetDocumentId === documentId
      && typeof node.attrs.targetBlockId === "string") {
      node.attrs.targetBlockId = idMap.get(node.attrs.targetBlockId) ?? node.attrs.targetBlockId;
    }
    if (node.marks) {
      node.marks = node.marks.map((mark) => {
        if (mark.type !== "link" || typeof mark.attrs?.href !== "string") return mark;
        const reference = parseEverroomBlockReferenceUrl(mark.attrs.href);
        const targetBlockId = reference?.documentId === documentId
          ? idMap.get(reference.blockId)
          : null;
        if (!reference || !targetBlockId) return mark;
        return {
          ...mark,
          attrs: {
            ...mark.attrs,
            href: createEverroomBlockReferenceUrl({ ...reference, blockId: targetBlockId }),
          },
        };
      });
    }
    if (node.content) node.content = node.content.map(rewriteReferences);
    return node;
  };
  return rewriteReferences(assignIds(documentBodyContent(source)));
}

function textPreview(node: TiptapJsonContent): string {
  return tiptapText(node).replace(/\s+/g, " ").trim().slice(0, TEXT_PREVIEW_LIMIT);
}

function defaultCreateId(): string {
  return globalThis.crypto.randomUUID();
}

function nodeReferences(node: TiptapJsonContent): Array<{
  roomId: string;
  documentId: string;
  blockId: string;
}> {
  const result: Array<{ roomId: string; documentId: string; blockId: string }> = [];
  if (node.type === "documentBlockReference") {
    const roomId = node.attrs?.targetRoomId;
    const documentId = node.attrs?.targetDocumentId;
    const blockId = node.attrs?.targetBlockId;
    if (typeof roomId === "string" && typeof documentId === "string" && typeof blockId === "string") {
      result.push({ roomId, documentId, blockId });
    }
  }
  for (const mark of node.marks ?? []) {
    if (mark.type !== "link" || typeof mark.attrs?.href !== "string") continue;
    const reference = parseEverroomBlockReferenceUrl(mark.attrs.href);
    if (reference) result.push(reference);
  }
  return result;
}

/** Migrates persisted content without changing any valid block identity. */
export function migrateDocumentContent(
  content: TiptapJsonContent,
  fromSchemaVersion: number,
): { content: TiptapJsonContent; schemaVersion: number; changed: boolean } {
  if (!Number.isSafeInteger(fromSchemaVersion) || fromSchemaVersion < 0) {
    throw new Error("Invalid document content schema version");
  }
  if (fromSchemaVersion > DOCUMENT_CONTENT_SCHEMA_VERSION) {
    throw new Error("Document content was created by a newer schema");
  }
  return {
    content: clone(content),
    schemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
    changed: fromSchemaVersion !== DOCUMENT_CONTENT_SCHEMA_VERSION,
  };
}

export function normalizeDocumentContent(
  source: TiptapJsonContent,
  options: NormalizeDocumentOptions = {},
): NormalizedDocumentContent {
  const createId = options.createId ?? defaultCreateId;
  const stripped = stripDocumentTitle(source);
  const seen = new Set<string>();
  const blocks: ProjectedDocumentBlock[] = [];
  const references: ProjectedDocumentReference[] = [];
  let blockOrdinal = 0;
  let referenceOrdinal = 0;
  let changed = false;

  const visit = (
    input: TiptapJsonContent,
    path: number[],
    parentBlockId: string | null,
    rootBlockId: string | null,
  ): TiptapJsonContent => {
    const node: TiptapJsonContent = {
      ...input,
      ...(input.attrs ? { attrs: { ...input.attrs } } : {}),
      ...(input.marks ? { marks: input.marks.map((mark) => ({
        ...mark,
        ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}),
      })) } : {}),
    };
    let ownerBlockId = parentBlockId;
    let ownerRootBlockId = rootBlockId;
    let projected: ProjectedDocumentBlock | null = null;
    if (addressableBlockTypes.has(node.type)) {
      const explicitId = node.attrs?.id;
      const blockId = isValidBlockId(explicitId) && !seen.has(explicitId)
        ? explicitId
        : createId();
      if (blockId !== explicitId) changed = true;
      seen.add(blockId);
      node.attrs = { ...node.attrs, id: blockId };
      ownerBlockId = blockId;
      ownerRootBlockId = rootBlockId ?? blockId;
      projected = {
        blockId,
        parentBlockId,
        rootBlockId: ownerRootBlockId,
        type: node.type,
        siblingIndex: path.at(-1) ?? 0,
        ordinal: blockOrdinal++,
        path,
        depth: path.length - 1,
        textPreview: "",
      };
      blocks.push(projected);
    }
    for (const target of nodeReferences(node)) {
      if (!ownerBlockId) continue;
      references.push({
        sourceBlockId: ownerBlockId,
        targetRoomId: target.roomId,
        targetDocumentId: target.documentId,
        targetBlockId: target.blockId,
        ordinal: referenceOrdinal++,
      });
    }
    if (node.content) {
      node.content = node.content.map((child, index) => visit(
        child,
        [...path, index],
        ownerBlockId,
        ownerRootBlockId,
      ));
    }
    if (projected) projected.textPreview = textPreview(node);
    return node;
  };

  return {
    content: visit(stripped.content, [], null, null),
    blocks,
    references,
    changed: changed || stripped.changed,
    schemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
  };
}

export function normalizeDocumentFragment(
  source: TiptapJsonContent,
  options: NormalizeDocumentOptions = {},
): NormalizedDocumentContent {
  return normalizeDocumentContent(documentBodyContent(source), options);
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
    if (!child) throw new Error("Document block path is no longer valid");
    node = child;
  }
  return node;
}
