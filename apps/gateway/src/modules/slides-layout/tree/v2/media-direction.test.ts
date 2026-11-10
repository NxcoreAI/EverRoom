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

function compile(nodes: unknown[]) {
  const tree = normalizeTree({
    version: 2, role: "content", composition: "swiss", background: THEME.colors.background, nodes,
  });
  return compileTree(tree, CONTRACT);
}

describe("text direction and image mask", () => {
  it("stacks CJK text one character per paragraph when direction=vertical", () => {
    const result = compile([
      { type: "text", token: "h1", text: "飞行", direction: "vertical", align: "center", slot: { col: [1, 2], row: [1, 6] } },
    ]);
    const text = result.spec.elements.find((element) => element.type === "text");
    expect(text).toBeTruthy();
    if (text?.type !== "text") throw new Error("text missing");
    expect(text.paragraphs).toHaveLength(2);
    expect(text.paragraphs.map((paragraph) => paragraph.runs[0]?.text)).toEqual(["飞", "行"]);
    expect(text.paragraphs.every((paragraph) => paragraph.align === "center")).toBe(true);
  });

  it("compiles circle mask and a scrim overlay", () => {
    const result = compile([
      { type: "image", url: "https://example.com/a.png", mask: "circle", scrim: { color: "#000000", opacity: 0.5 }, slot: { col: [1, 8], row: [1, 8] } },
    ]);
    const image = result.spec.elements.find((element) => element.type === "image");
    expect(image?.type === "image" && image.circle).toBe(true);
    const scrim = result.spec.elements.find((element) => element.type === "shape" && element.fill === "#00000080");
    expect(scrim).toBeTruthy();
  });
});
