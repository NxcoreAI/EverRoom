import { describe, expect, it } from "vitest";
import { componentCandidatesFor } from "./component-candidates.js";
import { semanticRelationIssues } from "../../../subagents/slides-semantic-bindings.js";
import { contractFromStyleParams } from "../layout-contract.js";
import type { SemanticPage } from "../../../subagents/slides-semantic-contract.js";

const CONTRACT = contractFromStyleParams(null);

function page(overrides: Partial<SemanticPage> & Pick<SemanticPage, "blocks" | "relations">): SemanticPage {
  return {
    id: "p1", sourceRefs: ["s1"], role: "content", message: "一句话结论",
    focusRefs: [], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
    ...overrides,
  };
}

const textBlock = (id: string, text: string) => ({
  id, sourceRefs: ["s1"], priority: "primary" as const, mustShow: true, type: "text" as const, text,
});
const metricBlock = (id: string, label: string, value: string, unit?: string) => ({
  id, sourceRefs: ["s1"], priority: "primary" as const, mustShow: true, type: "metric" as const,
  label, value, ...(unit ? { unit } : {}),
});

describe("componentCandidatesFor：按关系预检候选", () => {
  it("precedes 关系 → timeline/steps/chevron，绑定实际 block 且给出可行性", () => {
    const blocks = [
      textBlock("s1", "2024 年完成样机"),
      textBlock("s2", "2025 年小批量试产"),
      textBlock("s3", "2026 年渠道扩张"),
    ];
    const candidates = componentCandidatesFor(page({
      blocks, relations: [{ type: "precedes", refs: ["s1", "s2", "s3"], basis: "路线图" }],
    }), CONTRACT);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(c => ["timeline", "steps", "chevron"].includes(c.name))).toBe(true);
    expect(candidates.every(c => c.relation === "precedes" && c.blockRefs.length === 3)).toBe(true);
    expect(candidates.every(c => typeof c.feasible === "boolean")).toBe(true);
    // 短文本在半页槽位必可展开：至少一个 feasible 且带 validatedSlot 与预检网格
    const feasible = candidates.find(c => c.feasible);
    expect(feasible?.validatedSlot).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
    expect(feasible?.validatedGrid).toMatchObject({ cols: 12, rows: 8, gutter: expect.any(Number), rowGutter: expect.any(Number), margin: expect.any(Number) });
  });

  it("≥2 个 metric block → stats 候选（relation=metrics）", () => {
    const candidates = componentCandidatesFor(page({
      blocks: [metricBlock("m1", "众筹金额", "63", "万美金"), metricBlock("m2", "支持者", "774", "名")],
      relations: [],
    }), CONTRACT);
    const stats = candidates.find(c => c.name === "stats");
    expect(stats?.relation).toBe("metrics");
    expect(stats?.blockRefs).toEqual(["m1", "m2"]);
  });

  it("compares 两侧 → comparison（泛化比较不映射 prosCons）；cover 角色页不生成候选", () => {
    const compared = page({
      blocks: [textBlock("a", "方案甲成本低"), textBlock("b", "方案乙性能强")],
      relations: [{ type: "compares", refs: ["a", "b"], basis: "取舍" }],
    });
    const names = componentCandidatesFor(compared, CONTRACT).map(c => c.name);
    expect(names).toContain("comparison");
    expect(names).not.toContain("prosCons");
    const cover = page({ role: "cover", blocks: [textBlock("a", "标题")], relations: [] });
    expect(componentCandidatesFor(cover, CONTRACT)).toEqual([]);
  });

  it("候选数封顶 4；超出时优先保留可行项", () => {
    const blocks = Array.from({ length: 6 }, (_, i) => textBlock(`t${i}`, `第 ${i + 1} 条要点：说明文字`));
    const candidates = componentCandidatesFor(page({
      blocks,
      relations: [
        { type: "precedes", refs: blocks.map(b => b.id), basis: "流程" },
        { type: "parallel", refs: blocks.map(b => b.id), basis: "并列" },
      ],
    }), CONTRACT);
    expect(candidates.length).toBeLessThanOrEqual(4);
  });
});

describe("semanticRelationIssues：关系表达验收", () => {
  const longBlocks = [
    textBlock("s1", "痛点：运动骑行用户想升级，但不愿换车。中置电机整车重、改装贵，轮毂电机无需修改车架即可适配。"),
    textBlock("s2", "方案：轮毂电机无需修改车架，可适配公路、山地、折叠等车型，平台化交付降低改装门槛。"),
    textBlock("s3", "验证：首轮众筹 63 万美金，774 名支持者来自 36 个国家，平均客单价 833 美金。"),
  ];
  const relation = { type: "precedes" as const, refs: ["s1", "s2", "s3"], basis: "叙事推进" };
  const equalColumns = {
    nodes: [{ type: "group", direction: "row", slot: { col: [1, 12], row: [3, 8] },
      children: longBlocks.map(b => ({ type: "text", token: "body", text: b.text })) }],
  };

  it("长文等宽文本列承载主关系 → 报一条修订提示", () => {
    const issues = semanticRelationIssues(page({ blocks: longBlocks, relations: [relation] }), equalColumns);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("precedes");
  });

  it("timeline 组件承载 → 通过", () => {
    const tree = {
      nodes: [{ type: "component", name: "timeline", slot: { col: [1, 12], row: [3, 8] },
        items: longBlocks.map(b => ({ label: b.text.slice(0, 6), text: b.text })) }],
    };
    expect(semanticRelationIssues(page({ blocks: longBlocks, relations: [relation] }), tree)).toEqual([]);
  });

  it("短标签等宽并列与封面页不拦", () => {
    const shortBlocks = [textBlock("a", "低成本"), textBlock("b", "高性能"), textBlock("c", "易安装")];
    const shortRelation = { type: "parallel" as const, refs: ["a", "b", "c"], basis: "并列" };
    const tree = { nodes: [{ type: "group", direction: "row", children: shortBlocks.map(b => ({ type: "text", token: "label", text: b.text })) }] };
    expect(semanticRelationIssues(page({ blocks: shortBlocks, relations: [shortRelation] }), tree)).toEqual([]);
    expect(semanticRelationIssues(page({ role: "cover", blocks: longBlocks, relations: [relation] }), equalColumns)).toEqual([]);
  });

  it("非均匀权重（有主次的表达）不拦；supports 辅助关系不检查", () => {
    const tree = {
      nodes: [{ type: "group", direction: "row", weights: [2.5, 1, 1], slot: { col: [1, 12], row: [3, 8] },
        children: longBlocks.map(b => ({ type: "text", token: "body", text: b.text })) }],
    };
    expect(semanticRelationIssues(page({ blocks: longBlocks, relations: [relation] }), tree)).toEqual([]);
    const supports = { type: "supports" as const, refs: ["s1", "s2"], basis: "论据" };
    expect(semanticRelationIssues(page({ blocks: longBlocks, relations: [supports] }), equalColumns)).toEqual([]);
  });
});

describe("候选预检：完整内容组与文本量测", () => {
  it("超过 8 条指标不再静默裁切：可行候选携带完整组，装不下的组以整体露出", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => metricBlock(`m${i + 1}`, `指标${i + 1}`, String(i + 1), "项"));
    const candidates = componentCandidatesFor(page({ blocks, relations: [] }), CONTRACT);
    // kpiRows 无条目上限：完整 10 条组参与预检，blockRefs 与 template 都不裁切。
    const kpi = candidates.find(c => c.name === "kpiRows");
    expect(kpi?.blockRefs).toHaveLength(10);
    expect((kpi?.template as { rows: unknown[] }).rows).toHaveLength(10);
    // 出现在候选里的 stats 类（若选中）必须声明完整组，不得悄悄取前 8 条。
    const stats = candidates.find(c => c.name === "stats");
    if (stats) {
      expect(stats.blockRefs).toHaveLength(10);
      if (!stats.feasible) expect(String(stats.note)).toMatch(/条目数 10 超出/);
    }
  });
});
