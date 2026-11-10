import { describe, expect, it } from "vitest";
import { normalizeTree } from "../schema.js";
import { compileTree } from "../compile.js";
import { contractFromStyleParams } from "../layout-contract.js";
import { resolveTheme } from "../../theme.js";

const STYLE = {
  palette: {
    background: "#fafaf8", surface: "#f1f1ed", primary: "#2447b0", accent: "#c9a063",
    text: "#16181d", textMuted: "#63676f", onDarkText: "#fafaf8",
    chartSeries: ["#2447b0", "#16181d", "#8a94a8", "#c9a063"],
  },
  typography: {
    fontHeading: "Songti SC", fontBody: "PingFang SC",
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

function compile(node: Record<string, unknown>) {
  const tree = normalizeTree({
    version: 2, role: "content", composition: "swiss", background: THEME.colors.background,
    nodes: [{ type: "component", ...node, slot: { col: [1, 12], row: [1, 8] } }],
  });
  return compileTree(tree, CONTRACT);
}

const IMG = "https://example.com/a.png";

describe("production atom components", () => {
  it("compiles sectionHeader", () => {
    expect(compile({ name: "sectionHeader", title: "主要市场", subtitle: "美国飞行文化" }).spec.elements.length).toBeGreaterThan(2);
  });

  it("compiles fullBleedQuote", () => {
    expect(compile({ name: "fullBleedQuote", imageUrl: IMG, titleLines: ["当飞行执照不再是准入证", "天空不再是特权区"], subtitle: "娱乐飞行的平权运动" }).spec.elements.length).toBeGreaterThan(3);
  });

  it("compiles photoTriptych", () => {
    expect(compile({ name: "photoTriptych", images: [{ url: IMG }, { url: IMG }, { url: IMG }], labelMode: "none" }).spec.elements.length).toBeGreaterThan(3);
  });

  it("compiles kpiRows and categoryCards", () => {
    expect(compile({ name: "kpiRows", rows: [{ label: "俱乐部", value: "1500", note: "美国" }, { label: "机场", value: "20061", note: "公共+私人" }] }).spec.elements.length).toBeGreaterThan(3);
    expect(compile({ name: "categoryCards", items: [
      { title: "房车", metric: "300", note: "亿美元" }, { title: "游艇", metric: "105", note: "亿美元" },
      { title: "ATV", metric: "80", note: "亿美元" }, { title: "帆船", metric: "384", note: "亿美元" },
    ] }).spec.elements.length).toBeGreaterThan(5);
  });

  it("compiles financialBoard", () => {
    expect(compile({ name: "financialBoard", columns: ["年度", "销量"], rows: [["2027", "500"], ["2028", "2,000"]], chart: { categories: ["2027", "2028"], values: [500, 2000] }, funding: [{ label: "研发", value: "1000" }, { label: "人力", value: "3500" }] }).spec.elements.length).toBeGreaterThan(5);
  });

  it("compiles competitorBoard", () => {
    expect(compile({ name: "competitorBoard", competitors: [
      { name: "小鹏", tags: ["多轴"], facts: ["订单 4000 台"] },
      { name: "Jetson", tags: ["ULA"], facts: ["预订 500 台"] },
      { name: "Opener", tags: ["复合翼"], facts: ["交付 13 台"] },
    ] }).spec.elements.length).toBeGreaterThan(10);
  });

  it("compiles radialFunnel", () => {
    expect(compile({ name: "radialFunnel", centerTitle: "飞行的乐趣", centerSubtitle: "低门槛", satellites: ["移动储能", "无人机", "3D 打印", "扫地机器人", "竹蜻蜓"], bridge: "长大想做飞行员", conclusionTitle: "降低门槛" }).spec.elements.length).toBeGreaterThan(10);
  });

  it("compiles founderProfile and featureRail", () => {
    expect(compile({ name: "founderProfile", personName: "杜昊", role: "Co-founder", sections: [
      { heading: "学术", bullets: ["哈尔滨工业大学"] }, { heading: "行业", bullets: ["大疆 / 亿航 / 顺丰"] },
    ] }).spec.elements.length).toBeGreaterThan(5);
    expect(compile({ name: "featureRail", imageUrl: IMG, params: [{ label: "速度", value: "100" }, { label: "高度", value: "300" }], features: [{ title: "多旋翼", text: "4 轴 8 桨" }, { title: "可折叠", text: "上皮卡" }] }).spec.elements.length).toBeGreaterThan(8);
  });
});
