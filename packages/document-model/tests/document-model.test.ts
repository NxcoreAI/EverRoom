import { describe, expect, it } from "vitest";
import { ensureDocumentTitle, normalizeDocumentContent } from "../src/index.js";

describe("document model", () => {
  it("keeps one canonical title node before the body", () => {
    const normalized = ensureDocumentTitle({
      type: "doc",
      content: [
        { type: "documentTitle", content: [{ type: "text", text: "  新标题  " }] },
        { type: "documentTitle", content: [{ type: "text", text: "重复标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      ],
    }, "旧标题");

    expect(normalized.title).toBe("新标题");
    expect(normalized.content.content).toEqual([
      { type: "documentTitle", content: [{ type: "text", text: "新标题" }] },
      { type: "paragraph", content: [{ type: "text", text: "正文" }] },
    ]);
  });

  it("migrates only a legacy H1 that matches the stored title", () => {
    const matching = ensureDocumentTitle({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "旧标题" }] },
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      ],
    }, "旧标题");
    const unrelated = ensureDocumentTitle({
      type: "doc",
      content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "正文标题" }] }],
    }, "旧标题");

    expect(matching.content.content?.map((node) => node.type)).toEqual(["documentTitle", "paragraph"]);
    expect(unrelated.content.content?.map((node) => node.type)).toEqual(["documentTitle", "heading"]);
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
});
