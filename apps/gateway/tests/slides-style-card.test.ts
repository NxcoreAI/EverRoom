import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { presetThumbnails } from "../src/modules/slides-style/preset-thumbnails.js";
import { buildDemoPageSpec } from "../src/modules/slides-style/demo-page.js";
import { checkDemoPage, runSelfCheck } from "../src/modules/slides-style/self-check.js";
import type { DemoPptxRenderer } from "../src/modules/slides-style/render.js";
import { defaultStyleParams } from "../src/modules/slides-style/validate.js";
import type { StyleParams } from "../src/modules/slides-style/types.js";
import { styleCardPayload, styleImagesPayload } from "../src/modules/slides-style/style-card.js";

const params: StyleParams = defaultStyleParams({
  background: "#f5f2ec", surface: "#ffffff", primary: "#1e3a5f", accent: "#e0a03c",
  text: "#2f2b28", textMuted: "#8f8a81", onDarkText: "#f2f4f7", darkCover: true,
});

describe("presetThumbnails", () => {
  it("每个构图家族出封面/内容/数据三张通用线框", () => {
    for (const composition of ["swiss", "editorial", "poster", "immersive"] as const) {
      const thumbs = presetThumbnails({ ...params, composition });
      expect(thumbs).toHaveLength(3);
      expect(thumbs.map((t) => t.role)).toEqual(["cover", "content", "data"]);
      for (const thumb of thumbs) {
        expect(thumb.svg).toContain("<svg");
        // 假字条版式图：只画形状，不渲染文字元素。
        expect(thumb.svg).not.toContain("<text");
      }
      // 内容页以浅底起笔——调色板背景色必须出现。
      const content = thumbs.find((t) => t.role === "content");
      expect(content?.svg).toContain(params.palette.background);
    }
  });

  it("标签随构图家族变化；darkCover 只换画法不改标签", () => {
    const labels = (p: StyleParams | null) => presetThumbnails(p).map((t) => t.label);
    expect(labels({ ...params, composition: "swiss" })).toEqual(["封面 · 瑞士网格", "内容页 · 瑞士网格", "数据页 · 瑞士网格"]);
    expect(labels({ ...params, composition: "swiss", darkCover: false })).toEqual(["封面 · 瑞士网格", "内容页 · 瑞士网格", "数据页 · 瑞士网格"]);
    expect(labels({ ...params, composition: "immersive" })[0]).toBe("封面 · 沉浸大图");
    // 旧会话无 params：按 swiss 兜底，不报错。
    expect(labels(null)).toEqual(["封面 · 瑞士网格", "内容页 · 瑞士网格", "数据页 · 瑞士网格"]);
  });

  it("缩略图用会话色板上色而非灰框", () => {
    const swiss = presetThumbnails(params);
    const content = swiss.find((t) => t.role === "content");
    expect(content?.svg).toContain(params.palette.primary);
    expect(content?.svg).toContain(params.palette.accent);
  });
});

describe("buildDemoPageSpec", () => {
  it("emits a full-bleed style demo with palette colors and valid geometry", () => {
    const spec = buildDemoPageSpec(params);
    expect(spec.background).toBe("#f5f2ec");
    expect(spec.elements.length).toBeGreaterThanOrEqual(8);
    const serialized = JSON.stringify(spec);
    // 引擎整页拒绝 emoji——演示页文案是固定词表，此断言防手滑。
    expect(serialized).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    for (const element of spec.elements) {
      const x = element.x as number;
      const y = element.y as number;
      const w = element.w as number;
      const h = element.h as number;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(1280);
      expect(y + h).toBeLessThanOrEqual(720);
    }
    const chart = spec.elements.find((element) => element.type === "chart") as Record<string, unknown>;
    expect((chart.categories as unknown[]).length).toBe(4);
    expect((chart.series as Array<{ values: number[] }>).every((series) => series.values.length === 4)).toBe(true);
  });
});

/** 画一张「像渲染结果」的 PNG：底色 + 标题墨带 + 三条文字带 + 强调色块。 */
function fakeDemoPng(background: string, accent: string): Buffer {
  const canvas = createCanvas(1280, 720);
  const context = canvas.getContext("2d");
  context.fillStyle = background;
  context.fillRect(0, 0, 1280, 720);
  context.fillStyle = "#1e3a5f";
  context.fillRect(100, 110, 620, 50);
  context.fillStyle = "#2f2b28";
  context.fillRect(100, 260, 540, 18);
  context.fillRect(100, 320, 500, 18);
  context.fillRect(100, 380, 520, 18);
  context.fillStyle = "#d9d9d9";
  context.fillRect(780, 110, 420, 190);
  context.fillRect(780, 330, 420, 90);
  context.fillStyle = accent;
  context.fillRect(810, 160, 200, 60);
  context.fillRect(100, 450, 130, 10);
  context.fillStyle = "#3d5f82";
  for (let index = 0; index < 4; index += 1) {
    context.fillRect(120 + index * 150, 560 - index * 30, 90, 60 + index * 30);
  }
  return canvas.toBuffer("image/png");
}

describe("checkDemoPage", () => {
  it("passes on a healthy render", async () => {
    const report = await checkDemoPage(fakeDemoPng("#f5f2ec", "#e0a03c"), params);
    expect(report.passed).toBe(true);
    expect(report.deviations).toEqual([]);
  }, 20_000);

  it("flags blank and wrong-background renders", async () => {
    const canvas = createCanvas(1280, 720);
    const context = canvas.getContext("2d");
    // 纯紫底：底色错、满页墨、无文字带、无强调色——四层全翻。
    // 不用纯红：#cc2222 与缺省强调色（#b87e25）的逐通道均值距离只有 38（容差 40），
    // 会被判成"强调色出现过"，让这条用例变成对色距公式的隐式断言而不是对四层的断言。
    context.fillStyle = "#7a1fa2";
    context.fillRect(0, 0, 1280, 720);
    const report = await checkDemoPage(canvas.toBuffer("image/png"), params);
    expect(report.passed).toBe(false);
    expect(report.deviations.map((deviation) => deviation.layer)).toEqual(
      expect.arrayContaining(["background", "inkCoverage", "textBands", "accentPresence"]),
    );
  }, 20_000);
});

describe("runSelfCheck", () => {
  it("swaps background/surface when the render clearly used surface", async () => {
    // 背景与卡片底差异要大到超容差，换底规则才有意义。
    const swapped: StyleParams = {
      ...params,
      palette: { ...params.palette, background: "#1a2b40", surface: "#f2f4f7" },
    };
    const renderer: DemoPptxRenderer = {
      async renderPptx() {
        throw new Error("unused");
      },
    };
    // 渲染器永远把 surface 画成底色（模拟引擎忽略 background 的情况）。
    const painted = swapped.palette.surface;
    const outcome = await runSelfCheck(swapped, renderer, {
      renderPng: async () => fakeDemoPng(painted, params.palette.accent),
    });
    expect(outcome.rounds).toBe(2);
    expect(outcome.params.palette.background).toBe(painted);
    expect(outcome.report.passed).toBe(true);
  }, 20_000);

  it("stops without a fix when the deviation is not the swap case", async () => {
    const renderer: DemoPptxRenderer = { async renderPptx() { throw new Error("unused"); } };
    // 恒定渲染成纯红底：既不是 background 也不接近 surface → 无修参规则适用，停机留残留。
    const outcome = await runSelfCheck(params, renderer, {
      renderPng: async () => {
        const canvas = createCanvas(1280, 720);
        const context = canvas.getContext("2d");
        context.fillStyle = "#cc2222";
        context.fillRect(0, 0, 1280, 720);
        return canvas.toBuffer("image/png");
      },
    });
    expect(outcome.rounds).toBe(1);
    expect(outcome.residual.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("style card payloads", () => {
  it("composes an images payload with material URLs and direction labels", () => {
    const payload = styleImagesPayload({
      id: "s1", draftDocumentId: null, instruction: "", feedback: [],
      overviewImages: [
        { contentHash: "a".repeat(64), label: "深空科技", generation: 1 },
        { contentHash: "b".repeat(64), generation: 2 },
      ],
      selectedImageHash: null, styleParams: null, demoImageHash: null,
      stage: "images_ready", generation: 2,
    }, "演示标题");
    expect(payload.stage).toBe("style_images_ready");
    expect(payload.generation).toBe(2);
    expect(payload.candidates[0]?.url).toBe(`everroom-material://${"a".repeat(64)}`);
    expect(payload.candidates[0]?.label).toBe("深空科技");
    // 老会话无 label：字段省略而非空串。
    expect(payload.candidates[1]).not.toHaveProperty("label");
  });

  it("composes a card payload from params", () => {
    const payload = styleCardPayload({
      id: "s1", draftDocumentId: null, instruction: "", feedback: [],
      overviewImages: [], selectedImageHash: "c".repeat(64),
      styleParams: params, demoImageHash: "d".repeat(64),
      stage: "card_ready", generation: 1,
    });
    expect(payload.swatches.length).toBe(6);
    expect(payload.swatches[1]).toEqual({ hex: "#1e3a5f", label: "主色" });
    expect(payload.typography[0]?.value).toBe("64pt");
    expect(payload.details.map((row) => row.label)).toEqual(["构图", "明暗", "母题", "卡面", "分隔", "图片", "视觉字号"]);
    expect(payload.details.find((row) => row.label === "明暗")?.value).toBe("封面/章节深底");
    expect(payload.details.find((row) => row.label === "母题")?.value).toBe("无");
    expect(payload.wireframes).toHaveLength(3);
    expect(payload.wireframes.map((frame) => frame.label)).toEqual(["封面 · 瑞士网格", "内容页 · 瑞士网格", "数据页 · 瑞士网格"]);
    expect(payload.demoImageUrl).toBe(`everroom-material://${"d".repeat(64)}`);
    expect(payload.effectLines).toEqual([]);
  });

  it("缩略图按 styleParams.composition 出家族变体", () => {
    const editorial = styleCardPayload({
      id: "s2", draftDocumentId: null, instruction: "", feedback: [],
      overviewImages: [], selectedImageHash: "c".repeat(64),
      styleParams: { ...params, composition: "editorial" }, demoImageHash: null,
      stage: "card_ready", generation: 1,
    });
    expect(editorial.wireframes.map((frame) => frame.label)).toEqual(["封面 · 编辑杂志", "内容页 · 编辑杂志", "数据页 · 编辑杂志"]);
    // 无 composition（旧会话）退 swiss 配方，不报错（exactOptionalPropertyTypes：解构剔除键而非直写 undefined）。
    const { composition: _omitted, ...legacyBase } = params;
    void _omitted;
    const legacy = styleCardPayload({
      id: "s3", draftDocumentId: null, instruction: "", feedback: [],
      overviewImages: [], selectedImageHash: "c".repeat(64),
      styleParams: legacyBase, demoImageHash: null,
      stage: "card_ready", generation: 1,
    });
    expect(legacy.wireframes.map((frame) => frame.label.split(" · ")[1])).toEqual(["瑞士网格", "瑞士网格", "瑞士网格"]);
  });
});
