import { describe, expect, it } from "vitest";
import { blockNeedsFor } from "./block-needs.js";
import { contractFromStyleParams } from "../layout-contract.js";
import type { SemanticPage } from "../../../subagents/slides-semantic-contract.js";

const CONTRACT = contractFromStyleParams(null);

function page(blocks: SemanticPage["blocks"]): SemanticPage {
  return {
    id: "p1", sourceRefs: ["s1"], role: "content", message: "页标题",
    blocks, relations: [], focusRefs: [], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  };
}
const textBlock = (id: string, text: string) => ({
  id, sourceRefs: ["s1"], priority: "primary" as const, mustShow: true, type: "text" as const, text,
});

describe("blockNeedsFor：内容块实测区域需求", () => {
  it("text block 给 3/6/12 列三档实测高度，窄列更高、宽列递减", () => {
    const needs = blockNeedsFor(page([textBlock("b1", "外挂电机拓展升级便捷，但对车架及轮胎宽度等要求较高，不具备平台属性。")]), CONTRACT);
    expect(needs).toHaveLength(1);
    const heights = needs[0]!.heightsByWidth!;
    expect(heights.map(h => h.cols)).toEqual([3, 6, 12]);
    expect(heights[0]!.px).toBeGreaterThan(heights[1]!.px);
    expect(heights[1]!.px).toBeGreaterThan(heights[2]!.px);
    expect(heights[0]!.px).toBeGreaterThan(0);
  });

  it("metric block 按 label+value+unit 拼串量测；空文本块跳过", () => {
    const needs = blockNeedsFor(page([
      { id: "m1", sourceRefs: ["s1"], priority: "primary", mustShow: true, type: "metric", label: "入境过夜游客", value: 1308.2, unit: "万人次" },
      textBlock("b2", "  "),
    ]), CONTRACT);
    expect(needs).toHaveLength(1);
    expect(needs[0]!.blockId).toBe("m1");
    expect(needs[0]!.kind).toBe("text");
  });

  it("table 给总行数、估算高度与建议槽位；chart 给建议槽位", () => {
    const needs = blockNeedsFor(page([
      {
        id: "t1", sourceRefs: ["s1"], priority: "primary", mustShow: true, type: "table",
        headers: ["厂商", "路线", "单价"], rows: [["A", "多旋翼", "12 万"], ["B", "复合翼", "19 万"]],
      },
      {
        id: "c1", sourceRefs: ["s1"], priority: "supporting", mustShow: true, type: "chart",
        labels: ["2024", "2025"], series: [{ name: "收入", values: [1, 2] }],
      },
    ]), CONTRACT);
    const table = needs.find(n => n.blockId === "t1")!;
    expect(table.rows).toBe(3);
    expect(table.estimatedPx).toBeGreaterThan(0);
    expect(table.suggestedSlot).toMatchObject({ col: expect.any(Array), row: [3, 8] });
    const chart = needs.find(n => n.blockId === "c1")!;
    expect(chart.kind).toBe("chart");
    expect(chart.suggestedSlot).toMatchObject({ col: [5, 12], row: [2, 6] });
  });
});
