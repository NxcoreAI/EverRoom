import { describe, expect, it } from "vitest";
import { ambiguousDocumentTopic } from "../src/modules/agent/service.js";

/**
 * document_create_intent 预检的入口判定：误把续跑指令当文档创建话题时，run 会被
 * 短路成 completed + 等待澄清（前端若无澄清卡片，用户看到 agent 毫无反应——
 * 2026-11-03「生成到第5页看下」事故）。这里锁定两类词法的边界。
 */
describe("ambiguousDocumentTopic", () => {
  it("分页/续跑措辞不触发文档创建预检", () => {
    expect(ambiguousDocumentTopic("生成到第5页看下")).toBeNull();
    expect(ambiguousDocumentTopic("生成前3页")).toBeNull();
    expect(ambiguousDocumentTopic("做到第2页")).toBeNull();
    expect(ambiguousDocumentTopic("生成一页")).toBeNull();
  });

  it("真正的文档创建话题仍然触发澄清", () => {
    expect(ambiguousDocumentTopic("生成一份市场调研")).toBe("市场调研");
    expect(ambiguousDocumentTopic("帮我做一篇关于新能源的分析")).toBe("关于新能源的分析");
  });

  it("非创建动词与其余否定词保持原行为", () => {
    expect(ambiguousDocumentTopic("重新生成第 1 页")).toBeNull();
    expect(ambiguousDocumentTopic("生成幻灯片")).toBeNull();
    expect(ambiguousDocumentTopic("做一个项目计划")).toBeNull();
  });
});
