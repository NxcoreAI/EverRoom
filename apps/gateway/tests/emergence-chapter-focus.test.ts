import { describe, expect, it } from "vitest";

import { buildFocusText, injectChapterFocusNode } from "../src/modules/knowledge/emergence-service.js";
import { buildTaskUnderstandingPrompt } from "../src/modules/knowledge/llm.js";
import type { EmergenceNode, ProjectionGraph, ProjectionGraphNode } from "../src/modules/knowledge/emergence-projection.js";

const ROOM = { title: "连接器 Room", summary: "跨系统打通" };
const DOC = { title: "发布计划", overviewText: "发布计划的导语文本" };

function graph(): ProjectionGraph {
  const docNode: ProjectionGraphNode = {
    id: "doc:doc-1",
    nodeType: "document",
    label: "发布计划",
    sourceGraph: "linkGraph",
    roomRef: null,
    updatedAt: null,
    groupKey: "document",
  };
  return { nodes: new Map([[docNode.id, docNode]]), edges: [] };
}

const FOCUS_NODE: EmergenceNode = {
  id: "doc:doc-1",
  nodeType: "document",
  label: "发布计划",
  sourceGraph: "linkGraph",
  roomRef: null,
  updatedAt: null,
};

describe("buildFocusText", () => {
  it("选区优先，章节全文作为上下文一并给出", () => {
    const text = buildFocusText(ROOM, DOC, "选中这段", { heading: "二、发布节奏", bodyText: "章节正文" });
    expect(text.startsWith("选中这段")).toBe(true);
    expect(text).toContain("（所在章节《二、发布节奏》）");
    expect(text).toContain("章节正文");
  });

  it("只有章节：《标题》+ 正文，不截断", () => {
    const longBody = "长".repeat(20_000);
    const text = buildFocusText(ROOM, DOC, null, { heading: "二、发布节奏", bodyText: longBody });
    expect(text.startsWith("《二、发布节奏》")).toBe(true);
    expect(text.length).toBe("《二、发布节奏》\n".length + 20_000);
  });

  it("章节无标题：正文原样", () => {
    const text = buildFocusText(ROOM, DOC, null, { heading: null, bodyText: "正文若干" });
    expect(text).toBe("正文若干");
  });

  it("无选区无章节：文档导语兜底", () => {
    expect(buildFocusText(ROOM, DOC, null, null)).toBe("发布计划的导语文本");
  });

  it("无文档：房间标题+简介兜底", () => {
    expect(buildFocusText(ROOM, null, null, null)).toBe("连接器 Room\n跨系统打通");
  });
});

describe("buildTaskUnderstandingPrompt 章节信号", () => {
  it("章节标题独立成行，正文不截断", () => {
    const longBody = "焦".repeat(6_000);
    const prompt = buildTaskUnderstandingPrompt({
      roomTitle: "连接器 Room",
      focusTitle: "发布计划",
      chapterHeading: "二、发布节奏",
      focusText: longBody,
    });
    expect(prompt).toContain("当前产物：《发布计划》");
    expect(prompt).toContain("当前章节：《二、发布节奏》");
    expect(prompt.includes(longBody)).toBe(true);
  });

  it("无章节时不出现章节行", () => {
    const prompt = buildTaskUnderstandingPrompt({
      roomTitle: "连接器 Room",
      focusTitle: "发布计划",
      chapterHeading: null,
      focusText: "只有选区",
    });
    expect(prompt).not.toContain("当前章节");
  });
});

describe("injectChapterFocusNode", () => {
  const CHAPTER = { heading: "二、发布节奏", bodyText: "章节正文" };

  it("注入临时章节节点，经「属于」边挂到产物节点并返回为树根", () => {
    const g = graph();
    const root = injectChapterFocusNode(g, FOCUS_NODE, { id: "doc-1" }, CHAPTER);
    expect(root.id).toMatch(/^chapter:doc:doc-1:[0-9a-f]{10}$/);
    expect(root.label).toBe("二、发布节奏");
    expect(g.nodes.get(root.id)?.nodeType).toBe("document");
    const edge = g.edges.find((item) => item.from === root.id);
    expect(edge).toMatchObject({ to: "doc:doc-1", relationType: "属于", edgeLevel: "original", confidence: 1 });
  });

  it("同标题同引用（稳定），不同标题不同引用", () => {
    const a = injectChapterFocusNode(graph(), FOCUS_NODE, { id: "doc-1" }, CHAPTER);
    const b = injectChapterFocusNode(graph(), FOCUS_NODE, { id: "doc-1" }, { ...CHAPTER });
    const c = injectChapterFocusNode(graph(), FOCUS_NODE, { id: "doc-1" }, { heading: "三、视觉", bodyText: "正文" });
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it("无标题/空正文/无产物：原样返回焦点节点，不动图", () => {
    for (const chapter of [null, { heading: null, bodyText: "正文" }, { heading: "二、发布节奏", bodyText: "  " }] as const) {
      const g = graph();
      const root = injectChapterFocusNode(g, FOCUS_NODE, { id: "doc-1" }, chapter);
      expect(root).toBe(FOCUS_NODE);
      expect(g.edges.length).toBe(0);
    }
    const g = graph();
    expect(injectChapterFocusNode(g, FOCUS_NODE, null, CHAPTER)).toBe(FOCUS_NODE);
    expect(g.edges.length).toBe(0);
  });
});
