import type { RoomDocument, TiptapJsonContent } from "@nxcore/agent-contract";
import { describe, expect, it } from "vitest";
import { buildDocumentEnvelope, envelopeFilename } from "../src/modules/knowledge/envelope.js";
import { tiptapToMarkdown } from "../src/modules/knowledge/tiptap-markdown.js";

function documentOf(contentJson: TiptapJsonContent, overrides: Partial<RoomDocument> = {}): RoomDocument {
  return {
    id: "doc-1",
    roomId: "room-1",
    title: "示例文档",
    contentJson,
    contentSchemaVersion: 1,
    version: 3,
    status: "active",
    activeTransactionId: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T01:00:00.000Z",
    ...overrides,
  };
}

describe("tiptapToMarkdown", () => {
  it("exports headings, paragraphs and inline marks", () => {
    const markdown = tiptapToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "加粗", marks: [{ type: "bold" }] },
            { type: "text", text: " 与 " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " 与 ", marks: [] },
            {
              type: "text",
              text: "链接",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    });
    expect(markdown).toContain("## 标题");
    expect(markdown).toContain("**加粗**");
    expect(markdown).toContain("`code`");
    expect(markdown).toContain("[链接](https://example.com)");
  });

  it("exports nested lists with ordered markers", () => {
    const markdown = tiptapToMarkdown({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "一级" }] },
                {
                  type: "bulletList",
                  content: [
                    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "二级" }] }] },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第一" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第二" }] }] },
          ],
        },
      ],
    });
    expect(markdown).toContain("- 一级");
    expect(markdown).toContain("  - 二级");
    expect(markdown).toContain("1. 第一");
    expect(markdown).toContain("2. 第二");
  });

  it("exports code blocks with language and tables with escaped pipes", () => {
    const markdown = tiptapToMarkdown({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1\n" }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a|b" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(markdown).toContain("```ts\nconst x = 1\n```");
    expect(markdown).toContain("| a\\|b | c |");
    expect(markdown).toContain("| --- | --- |");
  });

  it("degrades unsupported blocks to placeholders instead of dropping them", () => {
    const markdown = tiptapToMarkdown({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "前文" }] },
        { type: "canvasBlock", attrs: { id: "x" } },
      ],
    });
    expect(markdown).toContain("前文");
    expect(markdown).toContain("（未导出内容块：canvasBlock）");
  });
});

describe("DocEnvelope", () => {
  it("builds a stable filename from source kind, id and sanitized title", () => {
    const envelope = buildDocumentEnvelope(
      documentOf({ type: "doc", content: [] }, { title: "评审/纪要: v2? " }),
    );
    expect(envelopeFilename(envelope)).toMatch(/^everroom-doc-doc-1__.+\.md$/);
    expect(envelopeFilename(envelope)).not.toMatch(/[/\\:*?"<>|]/);
  });

  it("carries frontmatter with title, room, version and markdown body", () => {
    const envelope = buildDocumentEnvelope(documentOf({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "正文" }] }],
    }));
    expect(envelope.ref).toEqual({ kind: "everroom-doc", id: "doc-1", version: 3 });
    expect(envelope.markdown).toContain('title: "示例文档"');
    expect(envelope.markdown).toContain("room: room-1");
    expect(envelope.markdown).toContain("version: 3");
    expect(envelope.markdown).toContain("正文");
    expect(Buffer.byteLength(envelope.markdown, "utf8")).toBeLessThanOrEqual(512 * 1024);
  });

  it("truncates oversized documents with an explicit marker", () => {
    const huge = "字".repeat(300_000); // ~900KB UTF-8
    const envelope = buildDocumentEnvelope(documentOf({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: huge }] }],
    }));
    expect(Buffer.byteLength(envelope.markdown, "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(envelope.markdown).toContain("已截断");
  });
});
