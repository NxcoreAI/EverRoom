import { describe, expect, it } from "vitest";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import { agentDocumentMarkdown } from "../src/modules/documents/agent-markdown.js";
import { normalizeDocumentContent } from "@nxcore/document-model";

const MARKDOWN = [
  "## 调研结论",
  "",
  "第一阶段完成了用户访谈^[访谈记录](everroom://room/room-1/doc-2/block-7)。",
  "用户偏好静默更新^[用户偏好](everroom://memory/room-1/room-1-memory-3?preview=%E5%81%8F%E5%A5%BD%E9%9D%99%E9%BB%98%E6%9B%B4%E6%96%B0)。",
].join("\n");

describe("block index mark markdown (gateway headless)", () => {
  it("parses inline index marks inside paragraphs and round trips them", () => {
    const parsed = agentDocumentMarkdown.parse(MARKDOWN);
    const paragraph = parsed.content?.find((node) => node.type === "paragraph"
      && node.content?.some((child) => child.type === "blockIndexMark"
        && child.attrs?.targetMemoryId === "room-1-memory-3"));
    expect(paragraph).toBeDefined()

    const documentMark = parsed.content
      ?.flatMap((node) => node.content ?? [])
      .find((child) => child.type === "blockIndexMark" && child.attrs?.kind === "document");
    expect(documentMark?.attrs).toMatchObject({
      targetRoomId: "room-1",
      targetDocumentId: "doc-2",
      targetBlockId: "block-7",
      fallbackTitle: "访谈记录",
    });

    expect(agentDocumentMarkdown.serialize(parsed)).toBe(MARKDOWN);
  });

  it("keeps block index marks through normalizeDocumentContent without projecting references", () => {
    const parsed = agentDocumentMarkdown.parse(MARKDOWN);
    const normalized = normalizeDocumentContent(parsed as unknown as TiptapJsonContent);
    const marks = JSON.stringify(normalized.content).match(/"blockIndexMark"/g) ?? [];
    expect(marks.length).toBe(2);
    // v1 刻意不纳入 references 投影：不写 documentBlockReferences、不触发跨房 409。
    expect(normalized.references).toHaveLength(0);
    expect(normalized.blocks.length).toBeGreaterThan(0);
  });

  it("treats a lone mark line as inline content, not a block reference card", () => {
    const parsed = agentDocumentMarkdown.parse("^[孤立标记](everroom://memory/room-1/room-1-memory-1)\n");
    expect(parsed.content?.[0]?.type).toBe("paragraph");
    expect(parsed.content?.[0]?.content?.[0]?.type).toBe("blockIndexMark");
  });
});
