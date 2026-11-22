import { describe, expect, it } from "vitest";
import { checkSemanticStoryboard, CONTENT_SOURCE_SCHEMA, type ContentSource } from "../src/modules/subagents/slides-semantic-contract.js";

const sources: ContentSource[] = [
  { id: "s1:data", pageId: "p1", kind: "data", value: "产品研发: 30%；批量生产: 30%；市场营销: 20%", mustShow: true },
];
const page = {
  id: "p1", sourceRefs: [sources[0]!.id], role: "content" as const, message: "融资",
  blocks: [
    { id: "f-rd", sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true, type: "metric" as const, label: "产品研发", value: "30", unit: "%" },
    { id: "f-prod", sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true, type: "metric" as const, label: "批量生产", value: "30", unit: "%" },
    { id: "f-mkt", sourceRefs: [sources[0]!.id], priority: "primary" as const, mustShow: true, type: "metric" as const, label: "市场营销", value: "20", unit: "%" },
  ],
  relations: [], focusRefs: ["f-rd"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
};

describe("metric 数值口径：value+unit 拼合后比对（30% 不再误报 30 无来源）", () => {
  it("block 级与必留覆盖检查都通过", () => {
    const report = checkSemanticStoryboard([page], sources);
    expect(report.errors.filter(e => e.includes("无来源") || e.includes("必留数据缺失"))).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
