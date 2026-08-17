import type { TiptapJsonContent } from "@nxcore/agent-contract";

export const DOCUMENT_CONTENT_SCHEMA_VERSION = 2;
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

export interface NormalizeDocumentOptions {
  createId?: () => string;
  documentTitle?: string;
}

export interface NormalizedDocumentContent {
  content: TiptapJsonContent;
  title: string;
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

export function isValidBlockId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
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

function titleNode(title: string): TiptapJsonContent {
  return {
    type: DOCUMENT_TITLE_NODE_TYPE,
    content: title ? [{ type: "text", text: title }] : [],
  };
}

/** Keeps the title as the unique first node in the persisted document tree. */
export function ensureDocumentTitle(
  source: TiptapJsonContent,
  fallbackTitle = "无标题文档",
): { content: TiptapJsonContent; title: string; changed: boolean } {
  const input = clone(source);
  const fallback = fallbackTitle.trim().slice(0, DOCUMENT_TITLE_LIMIT) || "无标题文档";
  const children = [...(input.content ?? [])];
  const existingTitle = children.find((node) => node.type === DOCUMENT_TITLE_NODE_TYPE);
  let title = documentTitleText(existingTitle);
  let body = children.filter((node) => node.type !== DOCUMENT_TITLE_NODE_TYPE);
  if (!title && body[0]?.type === "heading" && body[0].attrs?.level === 1) {
    const legacyTitle = tiptapText(body[0]).trim().slice(0, DOCUMENT_TITLE_LIMIT);
    if (legacyTitle && legacyTitle === fallback) {
      title = legacyTitle;
      body = body.slice(1);
    }
  }
  title = title || fallback;
  const normalized = { ...input, content: [titleNode(title), ...body] };
  return {
    content: normalized,
    title,
    changed: JSON.stringify(normalized) !== JSON.stringify(source),
  };
}

export function documentBodyContent(source: TiptapJsonContent): TiptapJsonContent {
  return {
    ...clone(source),
    content: (source.content ?? []).filter((node) => node.type !== DOCUMENT_TITLE_NODE_TYPE),
  };
}

function textPreview(node: TiptapJsonContent): string {
  return tiptapText(node).replace(/\s+/g, " ").trim().slice(0, TEXT_PREVIEW_LIMIT);
}

function defaultCreateId(): string {
  return globalThis.crypto.randomUUID();
}

function parseEverroomReference(value: string): {
  roomId: string;
  documentId: string;
  blockId: string;
} | null {
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
    return roomId && documentId && blockId ? { roomId, documentId, blockId } : null;
  } catch {
    return null;
  }
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
    const reference = parseEverroomReference(mark.attrs.href);
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
  const titled = ensureDocumentTitle(source, options.documentTitle);
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
    content: visit(titled.content, [], null, null),
    title: titled.title,
    blocks,
    references,
    changed: changed || titled.changed,
    schemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
  };
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
