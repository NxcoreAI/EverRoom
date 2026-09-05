import { describe, expect, it } from "vitest";
import {
  createEverroomBlockReferenceUrl,
  createEverroomMemoryIndexUrl,
  everroomBlockIndexUrl,
  formatBlockIndexMarkMarkdown,
  freshenDocumentContent,
  hasEmbeddedDocumentImages,
  normalizeDocumentContent,
  normalizeDocumentFragment,
  parseBlockIndexMarkMarkdown,
  parseEverroomBlockReferenceUrl,
  parseEverroomMemoryIndexUrl,
  stripDocumentTitle,
} from "../src/index.js";

describe("document model", () => {
  it("round trips canonical block reference URLs with fallback metadata", () => {
    const reference = {
      roomId: "room/a",
      documentId: "doc 1",
      blockId: "block-1",
      fallbackTitle: "  计划草案  ",
      fallbackPreview: "第一阶段：调研",
    };
    const url = createEverroomBlockReferenceUrl(reference);

    expect(url).toContain("everroom://room/room%2Fa/doc%201/block-1?");
    expect(parseEverroomBlockReferenceUrl(url)).toEqual({
      ...reference,
      fallbackTitle: "计划草案",
    });
    expect(parseEverroomBlockReferenceUrl("https://example.com")).toBeNull();
    expect(parseEverroomBlockReferenceUrl("everroom://room/only/two")).toBeNull();
  });

  it("detects embedded image bytes but allows stable asset URLs", () => {
    expect(hasEmbeddedDocumentImages({
      type: "doc",
      content: [{ type: "image", attrs: { src: "data:image/png;base64,iVBORw0KGgo=" } }],
    })).toBe(true);
    expect(hasEmbeddedDocumentImages({
      type: "doc",
      content: [{ type: "image", attrs: { src: "nxcore-document-asset://local/key/image.png" } }],
    })).toBe(false);
  });

  it("strips retired title nodes from persisted body content", () => {
    const normalized = stripDocumentTitle({
      type: "doc",
      content: [
        { type: "documentTitle", content: [{ type: "text", text: "  新标题  " }] },
        { type: "documentTitle", content: [{ type: "text", text: "重复标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      ],
    });

    expect(normalized.legacyTitle).toBe("新标题");
    expect(normalized.content.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "正文" }] },
    ]);
  });

  it("normalizes Markdown fragments without injecting document metadata", () => {
    const normalized = normalizeDocumentFragment({
      type: "doc",
      content: [
        { type: "documentTitle", content: [{ type: "text", text: "不应进入片段" }] },
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      ],
    }, { createId: () => "fragment-block" });

    expect(normalized.content.content).toEqual([{
      type: "paragraph",
      attrs: { id: "fragment-block" },
      content: [{ type: "text", text: "正文" }],
    }]);
  });

  it("projects a nested block tree and keeps identity document-local", () => {
    let sequence = 0;
    const normalized = normalizeDocumentContent({
      type: "doc",
      content: [{
        type: "bulletList",
        attrs: { id: "list" },
        content: [{
          type: "listItem",
          attrs: { id: "item" },
          content: [{ type: "paragraph", attrs: { id: "item" }, content: [{ type: "text", text: "Text" }] }],
        }],
      }],
    }, { createId: () => `generated-${++sequence}` });

    expect(normalized.blocks).toEqual([
      expect.objectContaining({ blockId: "list", parentBlockId: null, rootBlockId: "list", depth: 0 }),
      expect.objectContaining({ blockId: "item", parentBlockId: "list", rootBlockId: "list", depth: 1 }),
      expect.objectContaining({ blockId: "generated-1", parentBlockId: "item", rootBlockId: "list", depth: 2 }),
    ]);
  });

  it("extracts atomic and inline block references", () => {
    const normalized = normalizeDocumentContent({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { id: "source" },
        content: [{
          type: "text",
          text: "link",
          marks: [{ type: "link", attrs: { href: "everroom://room/room-1/doc-1/block-1" } }],
        }],
      }, {
        type: "documentBlockReference",
        attrs: {
          id: "reference",
          targetRoomId: "room-1",
          targetDocumentId: "doc-2",
          targetBlockId: "block-2",
        },
      }],
    });
    expect(normalized.references).toEqual([
      expect.objectContaining({ sourceBlockId: "source", targetDocumentId: "doc-1" }),
      expect.objectContaining({ sourceBlockId: "reference", targetDocumentId: "doc-2" }),
    ]);
  });

  it("freshens imported block IDs and remaps only internal references", () => {
    const generated = ["fresh-source", "fresh-reference"];
    const internalReference = createEverroomBlockReferenceUrl({
      roomId: "room-1",
      documentId: "doc-import",
      blockId: "source",
      fallbackTitle: "来源文档",
      fallbackPreview: "来源内容",
    });
    const content = freshenDocumentContent({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { id: "source" },
        content: [{
          type: "text",
          text: "links",
          marks: [
            { type: "link", attrs: { href: internalReference } },
            { type: "link", attrs: { href: "everroom://room/room-1/doc-other/source" } },
          ],
        }],
      }, {
        type: "documentBlockReference",
        attrs: {
          id: "reference",
          targetRoomId: "room-1",
          targetDocumentId: "doc-import",
          targetBlockId: "source",
        },
      }],
    }, "doc-import", { createId: () => generated.shift()! });

    expect(content.content?.[0]?.attrs?.id).toBe("fresh-source");
    expect(content.content?.[1]?.attrs).toMatchObject({
      id: "fresh-reference",
      targetBlockId: "fresh-source",
    });
    const rewrittenLinks = content.content?.[0]?.content?.[0]?.marks?.map((mark) => mark.attrs?.href);
    expect(parseEverroomBlockReferenceUrl(String(rewrittenLinks?.[0]))).toEqual({
      roomId: "room-1",
      documentId: "doc-import",
      blockId: "fresh-source",
      fallbackTitle: "来源文档",
      fallbackPreview: "来源内容",
    });
    expect(rewrittenLinks?.[1]).toBe("everroom://room/room-1/doc-other/source");
  });

  it("round trips memory index URLs and keeps them disjoint from block reference URLs", () => {
    const memory = {
      roomId: "room-1",
      memoryId: "room-1-memory-2",
      fallbackTitle: "  用户偏好  ",
      fallbackPreview: "偏好简述",
    };
    const url = createEverroomMemoryIndexUrl(memory);
    expect(url).toContain("everroom://memory/room-1/room-1-memory-2?");
    expect(parseEverroomMemoryIndexUrl(url)).toEqual({
      ...memory,
      fallbackTitle: "用户偏好",
    });
    // The memory host must never be readable as a document block reference
    // (3-segment room URL) and vice versa.
    expect(parseEverroomBlockReferenceUrl(url)).toBeNull();
    expect(parseEverroomMemoryIndexUrl(
      createEverroomBlockReferenceUrl({ roomId: "r", documentId: "d", blockId: "b" }),
    )).toBeNull();
    expect(parseEverroomMemoryIndexUrl("everroom://memory/only-one")).toBeNull();
    expect(parseEverroomMemoryIndexUrl("https://example.com")).toBeNull();
  });

  it("round trips block index mark markdown for both target kinds", () => {
    const documentTarget = {
      kind: "document" as const,
      roomId: "room-1",
      documentId: "doc-2",
      blockId: "block-9",
    };
    const memoryTarget = {
      kind: "memory" as const,
      roomId: "room-1",
      memoryId: "room-1-memory-3",
    };

    const documentMarkdown = formatBlockIndexMarkMarkdown(documentTarget, "来源 [草稿]");
    expect(documentMarkdown).toBe(
      "^[来源 \\[草稿\\]](everroom://room/room-1/doc-2/block-9)",
    );
    const parsedDocument = parseBlockIndexMarkMarkdown(`${documentMarkdown}后续文本`);
    expect(parsedDocument?.target).toEqual({
      ...documentTarget,
      fallbackTitle: "来源 [草稿]",
      fallbackPreview: null,
    });
    expect(parsedDocument?.label).toBe("来源 [草稿]");
    expect(parsedDocument?.raw).toBe(documentMarkdown);

    const memoryMarkdown = formatBlockIndexMarkMarkdown(memoryTarget, "记忆项");
    expect(memoryMarkdown).toBe("^[记忆项](everroom://memory/room-1/room-1-memory-3)");
    const parsedMemory = parseBlockIndexMarkMarkdown(memoryMarkdown);
    expect(parsedMemory?.target).toEqual({
      ...memoryTarget,
      fallbackTitle: "记忆项",
      fallbackPreview: null,
    });

    // Fallback title fills an empty label; redundant title query is omitted
    // (label already carries it — writing both would grow on every round trip).
    expect(formatBlockIndexMarkMarkdown(
      { ...memoryTarget, fallbackTitle: "备用标题" },
      "",
    )).toBe("^[备用标题](everroom://memory/room-1/room-1-memory-3)");
  });

  it("rejects non-index markdown shapes without throwing", () => {
    expect(parseBlockIndexMarkMarkdown("[标题](everroom://room/r/d/b)")).toBeNull();
    expect(parseBlockIndexMarkMarkdown("^[标题](https://example.com)")).toBeNull();
    expect(parseBlockIndexMarkMarkdown("^[标题](everroom://room/only/two)")).toBeNull();
    expect(parseBlockIndexMarkMarkdown("普通文本")).toBeNull();
  });

  it("keeps everroomBlockIndexUrl aligned with each target kind", () => {
    expect(everroomBlockIndexUrl({
      kind: "document",
      roomId: "r",
      documentId: "d",
      blockId: "b",
    })).toBe("everroom://room/r/d/b");
    expect(everroomBlockIndexUrl({
      kind: "memory",
      roomId: "r",
      memoryId: "m",
    })).toBe("everroom://memory/r/m");
  });
});
