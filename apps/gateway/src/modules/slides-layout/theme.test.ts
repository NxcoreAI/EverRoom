import { describe, expect, it } from "vitest";
import { darkPageTheme, primaryFontFamily, resolveTheme } from "./theme.js";

describe("theme font normalization", () => {
  it("strips CSS font stacks to the primary OOXML typeface", () => {
    expect(primaryFontFamily("Songti SC, Georgia, serif")).toBe("Songti SC");
    expect(primaryFontFamily('"PingFang SC", sans-serif')).toBe("PingFang SC");
    expect(primaryFontFamily("")).toBe("");
  });

  it("writes a single family into the resolved theme", () => {
    const theme = resolveTheme({
      typography: { fontHeading: "Songti SC, Georgia", fontBody: "Inter, PingFang SC" },
    });
    expect(theme.fonts.heading).toBe("Songti SC");
    expect(theme.fonts.body).toBe("Inter");
  });
});

describe("theme design tokens (style card → components)", () => {
  it("resolves composition, motif and darkCover into design", () => {
    const theme = resolveTheme({
      composition: "poster",
      motif: { kind: "color-band", spec: { side: "left", width: 12 } },
      darkCover: false,
    });
    expect(theme.design.composition).toBe("poster");
    expect(theme.design.motif).toEqual({ kind: "color-band", spec: { side: "left", width: 12 } });
    expect(theme.design.darkCover).toBe(false);
    // poster → 组件默认 airy；没有卡面 token 时 surface=none。
    expect(theme.design.density).toBe("airy");
    expect(theme.design.surface).toBe("none");
  });

  it("maps decoration tokens to component defaults", () => {
    const card = resolveTheme({
      palette: { primary: "#2447B0", accent: "#C9A063" },
      decoration: { cardStroke: "#112233", cardShadow: "soft", divider: "none" },
    });
    expect(card.design.surface).toBe("card");
    expect(card.design.separator).toBe("gap");
    expect(card.design.accent).toBe("accent");
    expect(card.design.numeral).toBe("sans");
    const immersive = resolveTheme({ composition: "immersive" });
    expect(immersive.design.surface).toBe("tint");
    const swiss = resolveTheme({ composition: "swiss" });
    expect(swiss.design.density).toBe("tight");
    // accent 与 primary 相同时强调位退回 primary。
    expect(resolveTheme({ palette: { primary: "#2447B0", accent: "#2447B0" } }).design.accent).toBe("primary");
  });

  it("falls back to safe defaults for unknown motif/composition values", () => {
    const theme = resolveTheme({ composition: "brutalist" as never, motif: { kind: "unknown" as never, spec: { x: 1 } } });
    expect(theme.design.composition).toBe("editorial");
    expect(theme.design.motif.kind).toBe("none");
    expect(theme.design.motif.spec).toEqual({});
    expect(resolveTheme(null).design.darkCover).toBe(true);
  });

  it("keeps design on dark page theme views (colors flip, design does not)", () => {
    const theme = resolveTheme({ composition: "editorial", motif: { kind: "corner-accent" }, palette: { accent: "#C9A063" } });
    const dark = darkPageTheme(theme);
    expect(dark.design).toEqual(theme.design);
    expect(dark.colors.background).toBe(theme.colors.darkBackground);
    expect(dark.colors.primary).toBe(theme.colors.primary);
  });

  it("字号只由场景决定：风格卡的 sizes / typeScale 一律忽略", () => {
    // 同一场景下，风格卡塞什么字号都不该改变产物——否则每份 deck 的字号各漂各的。
    const plain = resolveTheme({});
    const withSizes = resolveTheme({ typography: { sizes: { kpi: 60 } } });
    const withScale = resolveTheme({ typography: { typeScale: { hero: 88 } } });
    expect(withSizes.typeScale).toEqual(plain.typeScale);
    expect(withScale.typeScale).toEqual(plain.typeScale);
    expect(withSizes.sizes).toEqual(plain.sizes);
    // 场景仍然是唯一切换字号的旋钮。
    expect(resolveTheme({}, "reading").typeScale.hero).toBeLessThan(plain.typeScale.hero);
  });
});
