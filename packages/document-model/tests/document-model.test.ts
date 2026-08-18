import { describe, expect, it } from "vitest";
import {
  freshenDocumentContent,
  hasEmbeddedDocumentImages,
  normalizeDocumentContent,
  normalizeDocumentFragment,
  stripDocumentTitle,
} from "../src/index.js";

describe("document model", () => {
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
    const content = freshenDocumentContent({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { id: "source" },
        content: [{
          type: "text",
          text: "links",
          marks: [
            { type: "link", attrs: { href: "everroom://room/room-1/doc-import/source" } },
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
    expect(content.content?.[0]?.content?.[0]?.marks?.map((mark) => mark.attrs?.href)).toEqual([
      "everroom://room/room-1/doc-import/fresh-source",
      "everroom://room/room-1/doc-other/source",
    ]);
  });
});
