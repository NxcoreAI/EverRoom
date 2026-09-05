import { Node, type MarkdownToken } from "@tiptap/core";
import {
  formatBlockIndexMarkMarkdown,
  parseBlockIndexMarkMarkdown,
  type EverroomBlockIndexTarget,
} from "@nxcore/document-model";

export const BLOCK_INDEX_MARK_NODE = "blockIndexMark";

interface BlockIndexMarkNodeAttrs {
  kind: "document" | "memory";
  targetRoomId: string;
  targetDocumentId: string;
  targetBlockId: string;
  targetMemoryId: string;
  fallbackTitle: string | null;
  fallbackPreview: string | null;
}

function attrsToTarget(attrs: Partial<BlockIndexMarkNodeAttrs>): EverroomBlockIndexTarget | null {
  if (attrs.kind === "memory") {
    if (!attrs.targetRoomId || !attrs.targetMemoryId) return null;
    return {
      kind: "memory",
      roomId: attrs.targetRoomId,
      memoryId: attrs.targetMemoryId,
      fallbackTitle: attrs.fallbackTitle ?? null,
      fallbackPreview: attrs.fallbackPreview ?? null,
    };
  }
  if (!attrs.targetRoomId || !attrs.targetDocumentId || !attrs.targetBlockId) return null;
  return {
    kind: "document",
    roomId: attrs.targetRoomId,
    documentId: attrs.targetDocumentId,
    blockId: attrs.targetBlockId,
    fallbackTitle: attrs.fallbackTitle ?? null,
    fallbackPreview: attrs.fallbackPreview ?? null,
  };
}

function targetToAttrs(target: EverroomBlockIndexTarget): BlockIndexMarkNodeAttrs {
  return {
    kind: target.kind,
    targetRoomId: target.roomId,
    targetDocumentId: target.kind === "document" ? target.documentId : "",
    targetBlockId: target.kind === "document" ? target.blockId : "",
    targetMemoryId: target.kind === "memory" ? target.memoryId : "",
    fallbackTitle: target.fallbackTitle ?? null,
    fallbackPreview: target.fallbackPreview ?? null,
  };
}

/**
 * Headless twin of the renderer's BlockIndexMark node (see
 * apps/desktop/.../detail-editor/BlockIndexMark.tsx). Markdown round trip only:
 * the gateway's agentDocumentMarkdown manager uses it so doc-writer output
 * with `^[label](everroom://...)` marks parses, and `readDocumentForAgent`
 * serialization keeps the marks instead of silently dropping them.
 */
export const BlockIndexMarkHeadless = Node.create({
  name: BLOCK_INDEX_MARK_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      kind: { default: "document" },
      targetRoomId: { default: "" },
      targetDocumentId: { default: "" },
      targetBlockId: { default: "" },
      targetMemoryId: { default: "" },
      fallbackTitle: { default: null },
      fallbackPreview: { default: null },
    };
  },

  markdownTokenName: BLOCK_INDEX_MARK_NODE,

  markdownTokenizer: {
    name: BLOCK_INDEX_MARK_NODE,
    level: "inline",
    start: (source: string) => source.search(/\^\[/),
    tokenize: (source: string) => {
      const parsed = parseBlockIndexMarkMarkdown(source);
      if (!parsed) return undefined;
      return {
        type: BLOCK_INDEX_MARK_NODE,
        raw: parsed.raw,
        attrs: targetToAttrs(parsed.target),
      } as MarkdownToken;
    },
  },

  parseMarkdown(token, helpers) {
    const target = attrsToTarget(token.attrs as Partial<BlockIndexMarkNodeAttrs>);
    return helpers.createNode(
      BLOCK_INDEX_MARK_NODE,
      target
        ? targetToAttrs(target)
        : targetToAttrs({ kind: "document", roomId: "", documentId: "", blockId: "" }),
      [],
    );
  },

  renderMarkdown(node) {
    const target = attrsToTarget(node.attrs as Partial<BlockIndexMarkNodeAttrs>);
    if (!target) return "";
    return formatBlockIndexMarkMarkdown(target, target.fallbackTitle || "");
  },
});
