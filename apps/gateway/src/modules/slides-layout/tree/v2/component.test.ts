import { describe, expect, it } from "vitest";
import { normalizeTree } from "../schema.js";
import { compileTree } from "../compile.js";
import { measureDefects } from "../measure.js";
import { treeSignature } from "../similarity.js";
import { contractFromStyleParams } from "../layout-contract.js";
import { resolveTheme } from "../../theme.js";

const STYLE = {
  palette: {
    background: "#fafaf8",
    surface: "#f1f1ed",
    primary: "#2447b0",
    accent: "#c9a063",
    text: "#16181d",
    textMuted: "#63676f",
    onDarkText: "#fafaf8",
    chartSeries: ["#2447b0", "#16181d", "#8a94a8", "#c9a063"],
  },
  typography: {
    fontHeading: "Songti SC",
    fontBody: "PingFang SC",
    typeScale: { display: 56, hero: 72, h1: 40, h2: 32, h3: 26, lead: 20, body: 16, label: 13, kicker: 12, caption: 10 },
  },
  spacing: { margin: 80, gutter: 32, cardPadding: 18, cornerRadius: 10 },
  decoration: { cardStroke: "#112233", cardStrokeWidthPt: 1.25, cardShadow: "soft", divider: "line", imageFit: "cover" },
  composition: "editorial",
  motif: { kind: "color-band", spec: { side: "left", width: 8 } },
  darkCover: true,
} as const;

const CONTRACT = contractFromStyleParams(STYLE as never);
const THEME = resolveTheme(STYLE as never);

function page(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    role: "content",
    composition: "swiss",
    nodes: [
      {
        type: "component", name: "stats", style: { surface: "card", accent: "accent" },
        items: [{ value: "2.83", unit: "万亿元", label: "2020 GDP" }, { value: "3.87", unit: "万亿元", label: "2025 GDP" }],
        slot: { col: [1, 7], row: [1, 6] },
      },
      {
        type: "component", name: "pointList", style: { separator: "gap" },
        items: [{ label: "制度", body: "特区立法先行先试" }, { label: "产业", body: "电子制造形成集群" }],
        slot: { col: [8, 12], row: [1, 6] },
      },
    ],
    ...overrides,
  };
}

describe("v2 component nodes", () => {
  it("normalizes component nodes and compiles them through the shared component layer", () => {
    const tree = normalizeTree(page());
    expect(tree.v2?.nodes[0]).toMatchObject({ type: "component", name: "stats", style: { surface: "card", accent: "accent" } });
    const result = compileTree(tree, CONTRACT);
    const json = JSON.stringify(result.spec.elements);
    // 组件内容进来了（KPI 数值 + 要点正文）。
    expect(json).toContain("2.83");
    expect(json).toContain("特区立法");
    // 卡面用了风格卡描边，强调位用了 accent，页级母题色带也在。
    expect(json).toContain("#112233");
    expect(json).toContain("#c9a063");
    expect(result.placements.some((p) => p.kind === "component")).toBe(true);
  });

  it("keeps v2 pages defect-free for a normal component layout", () => {
    const tree = normalizeTree(page());
    const result = compileTree(tree, CONTRACT);
    const defects = measureDefects(result, CONTRACT);
    expect(defects).toEqual([]);
    expect(result.stats.elements).toBeLessThanOrEqual(CONTRACT.caps.elements);
  });

  it("rejects an invalid style on a component node", () => {
    expect(() => normalizeTree(page({ nodes: [{
      type: "component", name: "stats", style: { surface: "glass" },
      items: [{ value: "1", label: "A" }, { value: "2", label: "B" }],
      slot: { col: [1, 6], row: [1, 2] },
    }] }))).toThrow(/V2_INVALID: .*surface/);
  });

  it("includes component name + style in the page signature", () => {
    const a = normalizeTree(page());
    const b = normalizeTree(page({ nodes: page().nodes.map((node) => ({ ...node, style: { ...(node.style ?? {}), density: "airy" } })) }));
    expect(treeSignature(a)).not.toBe(treeSignature(b));
    expect(treeSignature(a)).toContain("stats:card,accent");
  });

  it("applies spacing.margin/gutter from the style card when the page omits grid", () => {
    const tree = normalizeTree(page());
    expect(tree.v2?.grid).toBeUndefined();
    const result = compileTree(tree, CONTRACT);
    const placement = result.placements.find((p) => p.kind === "component")!;
    expect(placement.frame.x).toBe(80);
  });

  it("honors an explicit page grid override", () => {
    const tree = normalizeTree(page({ grid: { margin: 40, gutter: 20 } }));
    const result = compileTree(tree, CONTRACT);
    expect(result.placements.find((p) => p.kind === "component")!.frame.x).toBe(40);
  });

  it("lets style card darkCover make cover pages dark deterministically", () => {
    const cover = normalizeTree({
      version: 2,
      role: "cover",
      composition: "immersive",
      nodes: [
        { type: "image", url: "everroom-material://" + "a".repeat(64), fit: "cover", bleed: true, slot: { col: [1, 12], row: [1, 8] } },
        { type: "text", token: "display", text: "封面标题", tone: "inverse", slot: { col: [1, 8], row: [6, 7] } },
      ],
    });
    const result = compileTree(cover, CONTRACT);
    expect(result.spec.background).toBe(THEME.colors.darkBackground);
    const lightContract = contractFromStyleParams({ ...STYLE, darkCover: false } as never);
    expect(compileTree(cover, lightContract).spec.background).toBe(resolveTheme({ ...STYLE, darkCover: false } as never).colors.background);
  });
});
