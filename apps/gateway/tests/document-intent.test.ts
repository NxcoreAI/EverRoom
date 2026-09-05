import { describe, expect, it } from "vitest";

import {
  requestsDocumentModification,
  requestsWorkspaceDocument,
} from "../src/modules/agent/document-intent.js";

describe("requestsDocumentModification", () => {
  it.each([
    "帮我修改一下这份文档",
    "把第二部分润色一下，文档在房间里",
    "续写文档的最后一段",
    "帮我改一下这篇文档的开头",
    "更新一下项目文档",
    "重写文档里的风险章节",
    "please update the document with the latest numbers",
    "polish the article a bit",
    "文档标题再改一下，内容精简",
  ])("正向：%s", (prompt) => {
    expect(requestsDocumentModification(prompt)).toBe(true);
  });

  it.each([
    "总结一下这个房间里的所有文档",
    "房间里有哪些文档？",
    "对比一下这几份 BP 的差异",
    "帮我写一篇新的周报",
    "不要修改文档，只给我建议",
    "如何修改文档的标题样式？",
    "how do I edit a document in this app?",
    "今天天气怎么样",
  ])("负向：%s", (prompt) => {
    expect(requestsDocumentModification(prompt)).toBe(false);
  });

  it("不影响既有 requestsWorkspaceDocument 行为（写作/创建口径不变）", () => {
    expect(requestsWorkspaceDocument("帮我写一份项目文档")).toBe(true);
    expect(requestsWorkspaceDocument("总结一下这个房间里的所有文档")).toBe(false);
  });
});
