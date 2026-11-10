import { describe, expect, it } from "vitest";
import { resolveTheme, type StyleParamsInput } from "../../theme.js";
import type { Frame } from "../../grid.js";
import { normalizeComponentLeaf, expandComponent } from "./index.js";
import {
  DARK_COVER_ROLES,
  normalizeComponentStyle,
  pageMotifElements,
  resolveComponentSkin,
} from "./kit.js";
import type { SpecElement } from "../../elements.js";

const FRAME: Frame = { x: 100, y: 100, w: 800, h: 360 };

function theme(overrides: StyleParamsInput = {}) {
  return resolveTheme(overrides);
}

function elements(node: Record<string, unknown>, styleParams?: StyleParamsInput): SpecElement[] {
  const t = theme(styleParams);
  const leaf = normalizeComponentLeaf({ type: "component", ...node }, "root");
  return expandComponent(leaf, FRAME, t, "root");
}

describe("normalizeComponentStyle", () => {
  it("accepts every enum and fills only provided fields", () => {
    expect(normalizeComponentStyle({ surface: "card", separator: "gap", align: "center", density: "airy", numeral: "sans", accent: "accent", motif: "none" }, "root.style"))
      .toEqual({ surface: "card", separator: "gap", align: "center", density: "airy", numeral: "sans", accent: "accent", motif: "none" });
  });

  it("rejects unknown fields and bad enums with actionable messages", () => {
    expect(() => normalizeComponentStyle({ surface: "shadow" }, "root.style")).toThrow(/LAYOUT_TREE_INVALID: root\.style\.surface/);
    expect(() => normalizeComponentStyle({ color: "#fff" }, "root.style")).toThrow(/不支持的样式字段/);
    expect(() => normalizeComponentStyle({ motif: "always" }, "root.style")).toThrow(/motif 必须是 inherit\|none/);
    expect(() => normalizeComponentStyle("card", "root.style")).toThrow(/必须是对象/);
  });

  it("omits an empty style object", () => {
    expect(normalizeComponentStyle({}, "root.style")).toBeUndefined();
  });
});

describe("resolveComponentSkin", () => {
  it("derives defaults from the style card", () => {
    const cardTheme = theme({
      composition: "editorial",
      decoration: { cardStroke: "#112233", cardShadow: "soft", divider: "none" },
      palette: { primary: "#2447B0", accent: "#C9A063" },
    });
    const skin = resolveComponentSkin(undefined, cardTheme);
    expect(skin.surface).toBe("card");
    expect(skin.separator).toBe("gap");
    expect(skin.density).toBe("normal");
    expect(skin.accent).toBe("accent");
    expect(skin.colors.emphasis).toBe("#c9a063");
  });

  it("maps composition to density and flat surfaces", () => {
    const swiss = resolveComponentSkin(undefined, theme({ composition: "swiss" }));
    expect(swiss.surface).toBe("none");
    expect(swiss.density).toBe("tight");
    const poster = resolveComponentSkin(undefined, theme({ composition: "poster" }));
    expect(poster.density).toBe("airy");
    const immersive = resolveComponentSkin(undefined, theme({ composition: "immersive" }));
    expect(immersive.surface).toBe("tint");
  });

  it("lets agent style win over card defaults", () => {
    const t = theme({ decoration: { cardShadow: "medium" }, composition: "swiss" });
    const skin = resolveComponentSkin({ surface: "outline", separator: "none", density: "airy", accent: "muted", align: "center" }, t);
    expect(skin.surface).toBe("outline");
    expect(skin.separator).toBe("none");
    expect(skin.density).toBe("airy");
    expect(skin.colors.emphasis).toBe(t.colors.textMuted);
    expect(skin.paragraphAlign).toBe("center");
    expect(skin.alignExplicit).toBe(true);
  });

  it("scales spacing by density", () => {
    const normal = resolveComponentSkin({ density: "normal" }, theme({ spacing: { gutter: 24, cardPadding: 16 } }));
    const tight = resolveComponentSkin({ density: "tight" }, theme({ spacing: { gutter: 24, cardPadding: 16 } }));
    const airy = resolveComponentSkin({ density: "airy" }, theme({ spacing: { gutter: 24, cardPadding: 16 } }));
    expect(tight.gap).toBeLessThan(normal.gap);
    expect(airy.gap).toBeGreaterThan(normal.gap);
    expect(tight.pad).toBeLessThan(normal.pad);
  });
});

describe("skin surface paint", () => {
  it("card surface carries theme fill, stroke, shadow and radius", () => {
    const t = theme({
      palette: { surface: "#F0F1F3" },
      decoration: { cardStroke: "#112233", cardStrokeWidthPt: 1.25, cardShadow: "soft" },
      spacing: { cornerRadius: 8 },
    });
    const skin = resolveComponentSkin({ surface: "card" }, t);
    const [ground] = skin.paint(FRAME);
    expect(ground).toMatchObject({
      type: "shape",
      shape: "roundRect",
      fill: "#f0f1f3",
      stroke: { color: "#112233", widthPt: 1.25 },
      shadow: "soft",
    });
    expect(ground && ground.type === "shape" ? ground.adj : undefined).toBeGreaterThan(0);
    // 内容框被 pad 内缩。
    expect(skin.contentBox(FRAME).x).toBeGreaterThan(FRAME.x);
  });

  it("outline / ink / tint / band produce distinct paints", () => {
    const t = theme({ palette: { primary: "#2447B0", text: "#16181D" } });
    const outline = resolveComponentSkin({ surface: "outline" }, t).paint(FRAME)[0]!;
    expect(outline).toMatchObject({ type: "shape", fill: "#00000000" });
    const ink = resolveComponentSkin({ surface: "ink" }, t).paint(FRAME)[0]!;
    expect(ink).toMatchObject({ type: "shape", fill: "#16181d" });
    const tint = resolveComponentSkin({ surface: "tint" }, t).paint(FRAME)[0]!;
    expect(tint).toMatchObject({ type: "shape" });
    expect(JSON.stringify(tint)).not.toContain("#16181d");
    const band = resolveComponentSkin({ surface: "band" }, t).paint(FRAME)[0]!;
    expect(band).toMatchObject({ type: "shape", shape: "rect", h: 4 });
    // band 只让出顶部条高，不做整块底。
    expect(resolveComponentSkin({ surface: "band" }, t).contentBox(FRAME).y).toBeGreaterThan(FRAME.y);
  });

  it("none surface paints nothing and keeps the frame", () => {
    const skin = resolveComponentSkin({ surface: "none" }, theme());
    expect(skin.paint(FRAME)).toEqual([]);
    expect(skin.contentBox(FRAME)).toEqual(FRAME);
  });
});

describe("skin separators", () => {
  it("separator line draws 1px divider; none/gap draw nothing", () => {
    const t = theme();
    const line = resolveComponentSkin({ separator: "line" }, t);
    expect(line.dividerH(FRAME, 200)).toMatchObject({ type: "shape", fill: t.colors.divider, h: 1 });
    expect(line.dividerV(FRAME, 300, 120, 200)).toMatchObject({ type: "shape", w: 1 });
    const none = resolveComponentSkin({ separator: "none" }, t);
    expect(none.dividerH(FRAME, 200)).toBeNull();
    const gap = resolveComponentSkin({ separator: "gap" }, t);
    expect(gap.dividerV(FRAME, 300, 120, 200)).toBeNull();
  });

  it("decoration.divider none turns the default separator into gap", () => {
    const skin = resolveComponentSkin(undefined, theme({ decoration: { divider: "none" } }));
    expect(skin.separator).toBe("gap");
    expect(skin.dividerH(FRAME, 200)).toBeNull();
  });
});

describe("skin typography and images", () => {
  it("numeral serif uses the heading font, sans uses body, none hides decorative runs", () => {
    const t = theme({ typography: { fontHeading: "Songti SC", fontBody: "PingFang SC" } });
    expect(resolveComponentSkin({ numeral: "serif" }, t).numeralRun("01", 20, "#000")?.[0]?.font).toBe("Songti SC");
    expect(resolveComponentSkin({ numeral: "sans" }, t).numeralRun("01", 20, "#000")?.[0]?.font).toBe("PingFang SC");
    expect(resolveComponentSkin({ numeral: "none" }, t).numeralRun("01", 20, "#000")).toBeUndefined();
  });

  it("heading runs honor headingBold, and typeScale ignores the card", () => {
    const t = theme({ typography: { headingBold: false, typeScale: { hero: 88 } } });
    const skin = resolveComponentSkin({}, t);
    expect(skin.heading("标题", 20)[0]?.bold).toBeUndefined();
    // 字号阶梯来自场景：风格卡里的 hero=88 不生效，仍等于主题阶梯。
    expect(skin.token("hero")).toBe(t.typeScale.hero);
    expect(skin.token("hero")).not.toBe(88);
    expect(skin.imageFit).toBe("cover");
    const contain = resolveComponentSkin({}, theme({ decoration: { imageFit: "contain" } }));
    expect(contain.imageFit).toBe("contain");
    expect(contain.imageRadiusAdj(200, 100)).toBeGreaterThan(0);
  });
});

describe("motif", () => {
  it("component motif kinds emit shapes and can be disabled per component", () => {
    const band = resolveComponentSkin({ surface: "card" }, theme({ motif: { kind: "color-band" } }));
    expect(band.motifDecor(FRAME)[0]).toMatchObject({ type: "shape", shape: "rect" });
    const corner = resolveComponentSkin({ surface: "card" }, theme({ motif: { kind: "corner-accent" } }));
    expect(corner.motifDecor(FRAME)[0]).toMatchObject({ type: "shape", shape: "ellipse" });
    const ghost = resolveComponentSkin({ surface: "card" }, theme({ motif: { kind: "ghost-number" } }));
    expect(ghost.motifDecor(FRAME).length).toBeGreaterThan(0);
    expect(resolveComponentSkin({ motif: "none", surface: "card" }, theme({ motif: { kind: "color-band" } })).motifDecor(FRAME)).toEqual([]);
    // 无底面的组件不重复画母题（页级母题统一承担）。
    expect(resolveComponentSkin({}, theme({ motif: { kind: "color-band" } })).motifDecor(FRAME)).toEqual([]);
  });

  it("page motif paints once per page, not per component", () => {
    const t = theme({ motif: { kind: "ghost-word", spec: { alpha: 0.05 } } });
    const motif = pageMotifElements(t);
    expect(motif.length).toBeGreaterThan(0);
    expect(motif.every((el) => el.type === "shape")).toBe(true);
    expect(pageMotifElements(theme())).toEqual([]);
    expect(DARK_COVER_ROLES.has("cover")).toBe(true);
  });
});

describe("component expanders consume the skin", () => {
  it("stats surface card + accent + motif shows up in compiled elements", () => {
    const out = elements(
      { name: "stats", style: { surface: "card", accent: "accent" }, items: [{ value: "2.83", unit: "万亿元", label: "2020 GDP" }, { value: "3.87", unit: "万亿元", label: "2025 GDP" }] },
      {
        palette: { primary: "#2447B0", accent: "#C9A063" },
        decoration: { cardStroke: "#112233", cardShadow: "soft" },
        motif: { kind: "color-band" },
      },
    );
    expect(out[0]).toMatchObject({ type: "shape", shape: "roundRect", stroke: { color: "#112233" } });
    // 母题色带 + accent 刻标都进了产物。
    const json = JSON.stringify(out);
    expect(json).toContain("#c9a063");
  });

  it("separator none removes stats column dividers; default line keeps them", () => {
    const items = [{ value: "1", label: "A" }, { value: "2", label: "B" }];
    const t = resolveTheme({ decoration: { divider: "line" } });
    const withLine = elements({ name: "stats", items }, { decoration: { divider: "line" } });
    const without = elements({ name: "stats", style: { separator: "none" }, items }, { decoration: { divider: "line" } });
    const divider = (els: SpecElement[]) => els.filter((el) => el.type === "shape" && el.fill === t.colors.divider).length;
    expect(divider(withLine)).toBeGreaterThan(divider(without));
  });

  it("imageFit flows into components that render images", () => {
    const node = { name: "featureCards", items: [
      { title: "A", image: "everroom-material://" + "a".repeat(64) },
      { title: "B" },
    ] };
    const cover = elements(node);
    const contain = elements(node, { decoration: { imageFit: "contain" } });
    const fitOf = (els: SpecElement[]) => els.find((el) => el.type === "image");
    expect(fitOf(cover)).toMatchObject({ type: "image", fit: "cover" });
    expect(fitOf(contain)).toMatchObject({ type: "image", fit: "contain" });
  });
});
