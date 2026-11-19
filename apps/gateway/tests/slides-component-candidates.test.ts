import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv } from "ajv";
import { componentCandidatesFor } from "../src/modules/slides-layout/tree/v2/component-candidates.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";
import { componentAdoptionFor, adoptionFeedback, type CandidateLike } from "../src/modules/subagents/slides-semantic-bindings.js";
import type { SemanticBlock, SemanticPage } from "../src/modules/subagents/slides-semantic-contract.js";

const contract = contractFromStyleParams(null);

/** 候选产物必须能过 layouter 输入 schema 的 componentCandidates 子模式（类型与 schema 同步）。 */
it("候选对象与 layouter 输入 schema 同步", () => {
  const schema = JSON.parse(readFileSync(resolve("../../agents/slides-layouter/schemas/input.schema.json"), "utf8"));
  const validate = new Ajv({ strict: false }).compile(schema.properties.componentCandidates);
  const page = pageOf([text("b1", "调研市场"), text("b2", "设计方案"), text("b3", "交付上线")],
    { relations: [{ type: "precedes", refs: ["b1", "b2", "b3"], basis: "先后" }], focusRefs: ["b1"] });
  const candidates = componentCandidatesFor(page, contract);
  expect(candidates.length).toBeGreaterThan(0);
  for (const candidate of [candidates, candidates.map(c => ({ ...c, feasible: false, note: "参数超限：演示" }))]) {
    expect(validate(candidate), JSON.stringify(validate.errors)).toBe(true);
  }
});

function pageOf(blocks: SemanticBlock[], extra: Partial<SemanticPage> = {}): SemanticPage {
  return {
    id: "page-1",
    sourceRefs: blocks.flatMap(b => b.sourceRefs),
    role: "content",
    message: "标题",
    blocks,
    relations: [],
    focusRefs: [],
    constraints: { verbatimRefs: [] },
    notes: "",
    omissions: [],
    ...extra,
  } as SemanticPage;
}

const text = (id: string, body: string, priority: "primary" | "supporting" | "detail" = "primary"): SemanticBlock =>
  ({ id, type: "text", text: body, sourceRefs: [id], priority, mustShow: true }) as SemanticBlock;
const metric = (id: string, label: string, value: string | number, unit?: string): SemanticBlock =>
  ({ id, type: "metric", label, value, ...(unit ? { unit } : {}), sourceRefs: [id], priority: "primary", mustShow: true }) as SemanticBlock;

describe("componentCandidatesFor", () => {
  it("featureCards 用 title/body 正确映射并给出可行候选与 template", () => {
    const page = pageOf([
      text("b1", "轻量化车身：采用航空铝材，整车降至 12 公斤"),
      text("b2", "智能变速：路况自适应换挡，无需手动调节"),
      text("b3", "长续航：单次充电可支撑 120 公里通勤"),
    ], { relations: [{ type: "parallel", refs: ["b1", "b2", "b3"], basis: "并列卖点" }], focusRefs: ["b1", "b2", "b3"] });
    const candidates = componentCandidatesFor(page, contract);
    const feature = candidates.find(c => c.name === "featureCards");
    expect(feature?.feasible).toBe(true);
    expect(feature?.template).toMatchObject({
      items: [
        { title: "轻量化车身", body: "轻量化车身：采用航空铝材，整车降至 12 公斤" },
        { title: "智能变速", body: "智能变速：路况自适应换挡，无需手动调节" },
        { title: "长续航", body: "长续航：单次充电可支撑 120 公里通勤" },
      ],
    });
    expect(feature?.suggestedSlot?.row[0]).toBeGreaterThanOrEqual(2);
    expect(feature?.validatedSlot?.w).toBeGreaterThan(0);
  });

  it("超长正文不因截断获得 feasible：true，而是报参数超限", () => {
    const long = "这是一段非常长的正文".repeat(30); // ~330 字，超 featureCards body 200 上限
    const page = pageOf([text("b1", long), text("b2", long), text("b3", long)],
      { relations: [{ type: "parallel", refs: ["b1", "b2", "b3"], basis: "并列" }], focusRefs: ["b1"] });
    const candidates = componentCandidatesFor(page, contract);
    const feature = candidates.find(c => c.name === "featureCards");
    expect(feature).toBeDefined();
    expect(feature?.feasible).toBe(false);
    expect(feature?.note).toContain("参数超限");
    expect(feature?.template).toBeUndefined();
  });

  it("条目数超限报参数超限，不截断条目", () => {
    const blocks = Array.from({ length: 7 }, (_, i) => text(`b${i}`, `第 ${i + 1} 项内容说明`));
    const page = pageOf(blocks, {
      relations: [{ type: "precedes", refs: blocks.map(b => b.id), basis: "先后" }],
      focusRefs: ["b0"],
    });
    const timeline = componentCandidatesFor(page, contract).find(c => c.name === "timeline");
    expect(timeline?.feasible).toBe(false);
    expect(timeline?.note).toContain("条目数 7");
  });

  it("泛化 compares 不再映射 prosCons；table/chart block 不进候选", () => {
    const table: SemanticBlock = { id: "t1", type: "table", headers: ["维度"], rows: [["a"]], sourceRefs: ["t1"], priority: "primary", mustShow: true } as SemanticBlock;
    const page = pageOf([text("b1", "方案甲成本更低"), text("b2", "方案乙交付更快"), table],
      { relations: [{ type: "compares", refs: ["b1", "b2", "t1"], basis: "对照" }], focusRefs: ["b1", "b2"] });
    const names = componentCandidatesFor(page, contract).map(c => c.name);
    expect(names).toContain("comparison");
    expect(names).not.toContain("prosCons");
    expect(names.every(n => n !== "timeline")).toBe(true);
  });

  it("缺失 block 引用不出残缺候选", () => {
    const page = pageOf([text("b1", "只有一方"), text("b2", "另一方")],
      { relations: [{ type: "precedes", refs: ["b1", "b2", "ghost"], basis: "先后" }], focusRefs: ["b1"] });
    expect(componentCandidatesFor(page, contract)).toHaveLength(0);
  });

  it("指标组给出 stats 与 kpiRows 候选，引用页给出 quote 候选", () => {
    const metrics = pageOf([
      metric("m1", "年销量", 4000, "万台"),
      metric("m2", "增速", 9.2, "%"),
      metric("m3", "保有量", 20, "亿"),
    ]);
    const metricNames = componentCandidatesFor(metrics, contract).map(c => c.name);
    expect(metricNames).toEqual(expect.arrayContaining(["stats", "kpiRows"]));

    const quote: SemanticBlock = { id: "q1", type: "quotation", text: "骑行是城市的心跳", sourceRefs: ["q1"], priority: "primary", mustShow: true } as SemanticBlock;
    const quoteNames = componentCandidatesFor(pageOf([quote]), contract).map(c => c.name);
    expect(quoteNames).toContain("quote");
  });

  it("去重生效且候选不超过 4 个，不同内容组优先占位", () => {
    const blocks = [
      ...Array.from({ length: 3 }, (_, i) => text(`p${i}`, `卖点 ${i + 1}：说明文字`)),
      ...Array.from({ length: 3 }, (_, i) => text(`s${i}`, `阶段 ${i + 1}：推进说明`)),
    ];
    const page = pageOf(blocks, {
      relations: [
        { type: "parallel", refs: ["p0", "p1", "p2"], basis: "并列卖点" },
        { type: "precedes", refs: ["s0", "s1", "s2"], basis: "先后推进" },
      ],
      focusRefs: ["p0", "s0"],
    });
    const candidates = componentCandidatesFor(page, contract);
    expect(candidates.length).toBeLessThanOrEqual(4);
    const groups = new Set(candidates.map(c => [...c.blockRefs].sort().join(",")));
    expect(groups.size).toBeGreaterThanOrEqual(2);
    const keys = candidates.map(c => `${c.name}:${[...c.blockRefs].sort().join(",")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("探测槽位避开标题行与页脚行", () => {
    const page = pageOf([text("b1", "第一步：调研市场"), text("b2", "第二步：设计方案"), text("b3", "第三步：交付上线")],
      { relations: [{ type: "precedes", refs: ["b1", "b2", "b3"], basis: "先后" }], focusRefs: ["b1"] });
    for (const candidate of componentCandidatesFor(page, contract)) {
      if (!candidate.feasible || !candidate.suggestedSlot) continue;
      expect(candidate.suggestedSlot.row[0]).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("componentAdoptionFor / adoptionFeedback", () => {
  const precedesPage = pageOf(
    [text("b1", "第一步：调研市场"), text("b2", "第二步：设计方案"), text("b3", "第三步：交付上线")],
    { relations: [{ type: "precedes", refs: ["b1", "b2", "b3"], basis: "先后" }], focusRefs: ["b1", "b2", "b3"] },
  );
  const candidates: CandidateLike[] = [
    { name: "timeline", relation: "precedes", blockRefs: ["b1", "b2", "b3"], feasible: true, suggestedSlot: { col: [1, 8], row: [2, 7] } },
  ];

  it("整组绑定到语义匹配组件即视为采用", () => {
    const tree = { nodes: [{ type: "component", name: "timeline", items: [] }] };
    const bindings = [
      { blockId: "b1", paths: ["nodes/0"] },
      { blockId: "b2", paths: ["nodes/0"] },
      { blockId: "b3", paths: ["nodes/0"] },
    ];
    expect(componentAdoptionFor(precedesPage, tree, bindings, candidates))
      .toEqual([{ relation: "precedes", blockRefs: ["b1", "b2", "b3"], component: "timeline", adopted: true }]);
  });

  it("候选外的合法匹配组件同样认可；多个绑定路径算一条即可", () => {
    const tree = { nodes: [
      { type: "text", text: "导语" },
      { type: "component", name: "eraRail", items: [] },
    ] };
    const bindings = [
      { blockId: "b1", paths: ["nodes/0", "nodes/1"] },
      { blockId: "b2", paths: ["nodes/1"] },
      { blockId: "b3", paths: ["nodes/1"] },
    ];
    const adoption = componentAdoptionFor(precedesPage, tree, bindings, candidates);
    expect(adoption[0]).toMatchObject({ component: "eraRail", adopted: true });
  });

  it("栏头/结论框等辅助组件与 table 节点不能冒充主内容采用", () => {
    const auxTree = { nodes: [
      { type: "component", name: "indexHeader", num: "01", title: "推进" },
      { type: "table", rows: [["a"]] },
    ] };
    const bindings = [
      { blockId: "b1", paths: ["nodes/0", "nodes/1"] },
      { blockId: "b2", paths: ["nodes/1"] },
      { blockId: "b3", paths: ["nodes/1"] },
    ];
    const adoption = componentAdoptionFor(precedesPage, auxTree, bindings, candidates);
    expect(adoption[0]!.adopted).toBe(false);
    const feedback = adoptionFeedback(adoption, candidates);
    expect(feedback[0]).toContain("timeline");
    expect(feedback[0]).toContain("col 1~8");
  });

  it("组内 block 未完整绑定时不算采用；无可行候选的组不触发反馈", () => {
    const tree = { nodes: [{ type: "text", text: "第一步：调研市场 第二步：设计方案 第三步：交付上线" }] };
    const partial = [
      { blockId: "b1", paths: ["nodes/0"] },
      { blockId: "b2", paths: ["nodes/0"] },
    ];
    expect(componentAdoptionFor(precedesPage, tree, partial, candidates)[0]!.adopted).toBe(false);
    expect(componentAdoptionFor(precedesPage, tree, partial, [{ ...candidates[0]!, feasible: false }])).toHaveLength(0);
  });

  it("metrics 组认可页面级 stats 节点承载", () => {
    const metricsPage = pageOf([metric("m1", "年销量", 4000, "万台"), metric("m2", "增速", 9.2, "%")],
      { focusRefs: ["m1"] });
    const metricCandidates: CandidateLike[] = [
      { name: "stats", relation: "metrics", blockRefs: ["m1", "m2"], feasible: true },
    ];
    const tree = { nodes: [{ type: "stats", items: [] }] };
    const bindings = [{ blockId: "m1", paths: ["nodes/0"] }, { blockId: "m2", paths: ["nodes/0"] }];
    expect(componentAdoptionFor(metricsPage, tree, bindings, metricCandidates)[0]).toMatchObject({ component: "stats", adopted: true });
  });

  it("封面/引语/章节/收尾页不做采用检查", () => {
    expect(componentAdoptionFor({ ...precedesPage, role: "cover" }, { nodes: [] }, [], candidates)).toHaveLength(0);
  });
});
