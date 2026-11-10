import { describe, expect, it } from "vitest";
import { normalizeTree } from "../schema.js";
import { visualRichnessIssues } from "./richness.js";

function page(nodes: unknown[], role = "content") {
  return normalizeTree({ version: 2, role, composition: "swiss", nodes }).v2!;
}

describe("visualRichnessIssues", () => {
  it("rejects a text-only content page", () => {
    const tree = page([{ type: "text", token: "h1", text: "只有文字", slot: { col: [1, 8], row: [1, 2] } }]);
    expect(visualRichnessIssues(tree).length).toBeGreaterThanOrEqual(1);
  });

  it("accepts an icon, table or non-full decorative shape", () => {
    expect(visualRichnessIssues(page([
      { type: "text", token: "h1", text: "标题", slot: { col: [1, 8], row: [1, 2] } },
      { type: "text", token: "body", text: "正文", slot: { col: [1, 8], row: [3, 3] } },
      { type: "text", token: "caption", text: "来源", slot: { col: [8, 12], row: [8, 8] } },
      { type: "icon", name: "bolt", slot: { col: [1, 2], row: [4, 4] } },
    ]))).toEqual([]);
    expect(visualRichnessIssues(page([
      { type: "text", token: "h1", text: "标题", slot: { col: [1, 8], row: [1, 2] } },
      { type: "text", token: "body", text: "正文", slot: { col: [1, 8], row: [3, 3] } },
      { type: "text", token: "caption", text: "来源", slot: { col: [8, 12], row: [8, 8] } },
      { type: "shape", shape: "rect", fill: "#2F5BFF", slot: { col: [1, 2], row: [8, 8] } },
    ]))).toEqual([]);
  });

  it("does not gate cover/closing pages", () => {
    expect(visualRichnessIssues(page([
      { type: "text", token: "display", text: "封面", slot: { col: [1, 8], row: [2, 4] } },
    ], "cover"))).toEqual([]);
  });
});
