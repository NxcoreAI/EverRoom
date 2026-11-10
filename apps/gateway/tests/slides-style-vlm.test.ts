import { describe, expect, it, vi } from "vitest";
import {
  decorationToEngine,
  readDecoration,
  readFontTemperament,
} from "../src/modules/slides-style/vlm-extract.js";
import { styleParamsFromStyler, baselineStyleParams } from "../src/modules/slides-style/compose.js";
import type { OverviewExtraction } from "../src/modules/slides-style/compose.js";
import type { VlmPromptAnalyzer } from "../src/modules/vision/vlm-client.js";
import type { PaletteRoles } from "../src/modules/slides-style/extract.js";

function analyzer(answer: unknown): VlmPromptAnalyzer {
  return {
    model: "test-vlm",
    analyze: vi.fn(async () => answer),
  };
}

describe("readFontTemperament / readDecoration", () => {
  it("parses valid closed answers", async () => {
    const fontVlm = analyzer({ serif: true, weight: "bold", geometric: "neutral", rounded: false });
    const font = await readFontTemperament(fontVlm, { buffer: Buffer.from("x"), mime: "image/png" });
    expect(font).toEqual({ serif: true, weight: "bold", geometric: "neutral", rounded: false });

    const decoVlm = analyzer({ cornerRadius: "medium", stroke: "thin", shadow: "soft", motif: "ghost" });
    const deco = await readDecoration(decoVlm, { buffer: Buffer.from("x"), mime: "image/png" });
    expect(deco).toEqual({ cornerRadius: "medium", stroke: "thin", shadow: "soft", motif: "ghost" });
  });

  it("throws on out-of-vocabulary answers", async () => {
    const vlm = analyzer({ serif: "yes", weight: "bold", geometric: "neutral", rounded: false });
    await expect(readFontTemperament(vlm, { buffer: Buffer.from("x"), mime: "image/png" }))
      .rejects.toThrow(/serif/);
    const vlm2 = analyzer({ cornerRadius: "huge", stroke: "none", shadow: "none", motif: "none" });
    await expect(readDecoration(vlm2, { buffer: Buffer.from("x"), mime: "image/png" }))
      .rejects.toThrow(/cornerRadius/);
  });
});

describe("decorationToEngine", () => {
  it("maps buckets onto engine vocabulary", () => {
    expect(decorationToEngine({ cornerRadius: "large", stroke: "thin", shadow: "soft", motif: "none" }))
      .toEqual({ cornerRadiusPx: 22, strokeWidthPt: 0.5, shadow: "soft" });
    expect(decorationToEngine({ cornerRadius: "none", stroke: "none", shadow: "none", motif: "none" }))
      .toEqual({ cornerRadiusPx: 0, strokeWidthPt: null, shadow: "none" });
  });
});

const roles: PaletteRoles = {
  background: "#f5f2ec", surface: "#faf9f6", primary: "#1e3a5f", accent: "#e0a03c",
  text: "#2f2b28", textMuted: "#8f8a81", onDarkText: "#f2f4f7", darkCover: true,
};

const extraction: OverviewExtraction = {
  clusters: [{ hex: "#f5f2ec", ratio: 0.7 }, { hex: "#1e3a5f", ratio: 0.15 }, { hex: "#e0a03c", ratio: 0.05 }],
  roles,
  font: { serif: false, weight: "bold", geometric: "neutral", rounded: false },
  decoration: { cornerRadius: "medium", stroke: "none", shadow: "soft", motif: "ghost" },
};

describe("styleParamsFromStyler", () => {
  it("accepts a valid styler output", () => {
    const outcome = styleParamsFromStyler({
      styleParams: {
        palette: { ...roles, chartSeries: undefined as never },
        typography: { fontHeading: "Inter, PingFang SC", fontBody: "PingFang SC", sizes: {}, headingBold: true },
        spacing: {},
        decoration: { cardShadow: "none", divider: "line", imageFit: "cover", cardStrokeWidthPt: 0.75 },
        motif: { kind: "none", spec: {} },
        layoutHints: {},
        darkCover: true,
        effectLines: ["主色 深藏青"],
      },
    }, extraction);
    expect(outcome.fellBack).toBe(false);
    expect(outcome.params.typography.fontHeading).toBe("Inter, PingFang SC");
  });

  it("falls back to the deterministic baseline on garbage", () => {
    const outcome = styleParamsFromStyler({ styleParams: { palette: { primary: "blue" } } }, extraction);
    expect(outcome.fellBack).toBe(true);
    expect(outcome.params.palette.primary).toBe("#1e3a5f");
    // 装饰档位来自 VLM 读取：medium 圆角=12、soft 阴影。
    expect(outcome.params.spacing.cornerRadius).toBe(12);
    expect(outcome.params.decoration.cardShadow).toBe("soft");
    expect(outcome.reason).toBeTruthy();
  });
});

describe("baselineStyleParams", () => {
  it("is a complete valid baseline reflecting extraction", () => {
    const params = baselineStyleParams(extraction);
    expect(params.palette.primary).toBe("#1e3a5f");
    expect(params.spacing.cornerRadius).toBe(12);
    expect(params.effectLines).toEqual([]);
  });
});
