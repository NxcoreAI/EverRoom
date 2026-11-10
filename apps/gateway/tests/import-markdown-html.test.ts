import { describe, expect, it } from "vitest";
import type { TiptapJsonContent } from "@nxcore/agent-contract";
import {
  agentDocumentMarkdown,
  normalizeImportedMarkdown,
  parseImportedMarkdown,
} from "../src/modules/documents/agent-markdown.js";

const FEISHU_MARKDOWN = [
  "# 容展易PRD——产品数字化管理与展示系统",
  "",
  "<title>容展易-RBA-PRD需求概述 副本</title>",
  "",
  '<callout emoji="💡"><p>版本号: 1.0</p><p>维护责任人: <cite type="user" user-id="ou_al6e34e586e3110efecb897fa4363a29">张三</cite></p></callout>',
  "",
  "## 一、项目概述",
  "",
  "<p>容展易集成设备管理、展台展示与画册制作。</p>",
  "",
  "<p>管理端以<strong>产品库</strong>为核心，所有关联模块以此为基准。</p>",
].join("\n");

function collectText(node: TiptapJsonContent, into: string[] = []): string[] {
  if (node.type === "text" && typeof node.text === "string") into.push(node.text);
  for (const child of node.content ?? []) collectText(child, into);
  return into;
}

function hasMark(node: TiptapJsonContent, markType: string, text: string): boolean {
  return (node.content ?? []).some(
    (child) => child.type === "text"
      && child.text === text
      && (child.marks ?? []).some((mark) => mark.type === markType),
  ) || (node.content ?? []).some((child) => hasMark(child, markType, text));
}

describe("import markdown html (gateway headless)", () => {
  it("normalizes feishu callout/cite/title into markdown semantics", () => {
    const normalized = normalizeImportedMarkdown(FEISHU_MARKDOWN);
    expect(normalized).not.toMatch(/<callout|<cite|<title/);
    expect(normalized).toContain("**容展易-RBA-PRD需求概述 副本**");
    expect(normalized).toContain("> 💡 版本号: 1.0");
    expect(normalized).toContain("**@张三**");
  });

  it("parses embedded html into rich nodes instead of literal text", () => {
    const parsed = parseImportedMarkdown(FEISHU_MARKDOWN);
    const text = collectText(parsed).join("");

    // 字面化回归：正文不允许出现原始标签。
    expect(text).not.toMatch(/<\/?(callout|cite|title|p|strong)\b/);
    expect(text).toContain("容展易集成设备管理、展台展示与画册制作。");

    const types = (parsed.content ?? []).map((node) => node.type);
    expect(types).toContain("heading");
    expect(types).toContain("blockquote");
    const heading = (parsed.content ?? []).find((node) => node.type === "heading");
    expect(heading?.attrs).toMatchObject({ level: 1 });

    // <strong> → bold mark；<cite type="user"> → 加粗 @提及。
    expect(hasMark(parsed, "bold", "产品库")).toBe(true);
    expect(hasMark(parsed, "bold", "@张三")).toBe(true);

    // callout 进入引用块，首行带 emoji。
    const blockquote = (parsed.content ?? []).find((node) => node.type === "blockquote");
    expect(collectText(blockquote!).join(" ")).toContain("💡 版本号: 1.0");
  });

  it("round trips without resurrecting raw tags", () => {
    const serialized = agentDocumentMarkdown.serialize(parseImportedMarkdown(FEISHU_MARKDOWN));
    expect(serialized).not.toMatch(/<\/?(callout|cite|title|p|strong)\b/);
    expect(serialized).toContain("@张三");
  });

  it("leaves plain markdown untouched and restores globals after parse", () => {
    const beforeWindow = (globalThis as { window?: unknown }).window;
    const parsed = parseImportedMarkdown("# 标题\n\n普通段落 **加粗**。");
    expect((globalThis as { window?: unknown }).window).toBe(beforeWindow);
    const types = (parsed.content ?? []).map((node) => node.type);
    expect(types).toEqual(["heading", "paragraph"]);
  });
});
