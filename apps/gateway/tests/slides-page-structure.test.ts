import { describe, expect, it } from "vitest";
import {
  CRAFT_BANDS,
  CRAFT_LIMITS,
  craftBandFor,
  MAX_WHITESPACE_JUMP,
  fontTiers,
  lineWidthPx,
  measureCharsFor,
  onSpacingGrid,
  pxToPt,
  ptToPx,
  snapSpacing,
  tierSpan,
} from "../src/modules/slides-layout/craft.js";
import {
  deckStructure,
  maxConsecutiveRun,
  measurePage,
  overlapRatio,
  structureSummary,
  unionArea,
} from "../src/modules/slides-layout/page-structure.js";
import { resolveTheme } from "../src/modules/slides-layout/theme.js";
import type { SpecElement } from "../src/modules/slides-layout/elements.js";

/**
 * 第二册 Step 1：只测量、不修正。
 * 测试要证明的是"数字算得对"，不是"页面好看"——观感进盲测，不进单测。
 */

const theme = resolveTheme();

function text(x: number, y: number, w: number, h: number, content: string, sizePt: number, align: "left" | "center" | "right" = "left"): SpecElement {
  return { type: "text", x, y, w, h, paragraphs: [{ runs: [{ text: content, sizePt }], align }] };
}

function shape(x: number, y: number, w: number, h: number, fill = "#112233"): SpecElement {
  return { type: "shape", shape: "rect", x, y, w, h, fill };
}

describe("画布与网格换算", () => {
  it("1pt = 4/3px，来回换算不失真", () => {
    expect(ptToPx(12)).toBeCloseTo(16, 6);
    expect(pxToPt(16)).toBeCloseTo(12, 6);
    expect(pxToPt(ptToPx(20))).toBeCloseTo(20, 6);
  });

  it("间距吸到 16px 网格", () => {
    expect(snapSpacing(97)).toBe(96);
    expect(snapSpacing(104)).toBe(112);
    expect(onSpacingGrid(96)).toBe(true);
    expect(onSpacingGrid(100)).toBe(false);
    expect(onSpacingGrid(97)).toBe(true); // 容差 1px
  });
});

describe("行长度（measure）上限随字号走", () => {
  it("大字一行字数少，小字一行字数多", () => {
    expect(measureCharsFor(60, theme.typeScale)).toBeLessThan(measureCharsFor(20, theme.typeScale));
    expect(measureCharsFor(20, theme.typeScale)).toBeGreaterThan(measureCharsFor(40, theme.typeScale));
  });

  it("落到 body 档时给 22 字/行", () => {
    expect(measureCharsFor(theme.typeScale.body, theme.typeScale)).toBe(22);
  });

  it("一行 22 个中文字需要的宽度与估算一致", () => {
    expect(lineWidthPx(22, 20)).toBeCloseTo(22 * 1.35 * 20, 6);
  });
});

describe("字号档", () => {
  it("相差 12% 以内算同一档", () => {
    expect(fontTiers([20, 19])).toEqual([20]);
    expect(tierSpan([20, 19])).toBe(1);
  });

  it("60/20/13 是三档", () => {
    expect(tierSpan([60, 20, 13])).toBe(3);
  });

  it("空页零档", () => {
    expect(tierSpan([])).toBe(0);
  });
});

describe("矩形并集与压叠", () => {
  it("重叠部分只算一次", () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    expect(unionArea([{ x: 0, y: 0, w: 60, h: 60 }, { x: 40, y: 40, w: 60, h: 60 }], box)).toBe(60 * 60 + 60 * 60 - 20 * 20);
  });

  it("超出裁切区的部分不算", () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    expect(unionArea([{ x: 50, y: 50, w: 200, h: 200 }], box)).toBe(50 * 50);
  });

  it("完全包含时压叠比是 1", () => {
    expect(overlapRatio({ x: 0, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 20, h: 20 })).toBeCloseTo(1, 6);
  });

  it("不相交是 0", () => {
    expect(overlapRatio({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBe(0);
  });
});

describe("单页结构指标", () => {
  it("一个大块占主角、留白低", () => {
    const page = measurePage([shape(80, 160, 800, 400)], { theme });
    expect(page.heroAreaRatio).toBeGreaterThan(0.45);
    // 800×400 占内容区的 46%，剩下 54% 是留白——这是"主角够大但版心没填满"的正常形状。
    expect(page.whitespaceRatio).toBeGreaterThan(0.45);
    expect(page.whitespaceRatio).toBeLessThan(0.6);
    expect(page.heroType).toBe("shape");
  });

  it("两行独立文字：左边缘同轴 → 1 条对齐轴", () => {
    const page = measurePage([text(80, 160, 500, 40, "第一句结论", 32), text(80, 240, 500, 40, "第二句支撑", 20)], { theme });
    expect(page.alignAxes).toBe(1);
    expect(page.alignAxisXs).toEqual([80]);
  });

  it("左中右各一块 → 对齐轴超上限", () => {
    const page = measurePage([
      text(80, 160, 300, 40, "左", 24),
      text(520, 160, 300, 40, "中", 24),
      text(960, 160, 300, 40, "右", 24),
    ], { theme });
    expect(page.alignAxes).toBe(3);
    expect(page.alignAxes).toBeGreaterThan(CRAFT_LIMITS.maxAlignAxes);
  });

  it("通栏长文 → measure 超限（AI 味的隐形来源）", () => {
    const long = "这是一段很长的正文用来验证行长度会不会超过上限并且确实超过了二十二个字一行";
    const page = measurePage([text(80, 160, 1120, 200, long, 20)], { theme });
    expect(page.measureMax).toBeGreaterThan(22);
    expect(page.measureOver).toBe(1);
  });

  it("窄栏短句 → 不超限", () => {
    const page = measurePage([text(80, 160, 380, 200, "一句短支撑语。", 20)], { theme });
    expect(page.measureOver).toBe(0);
  });

  it("两块文字叠在一起 → 记一处压叠", () => {
    const page = measurePage([text(80, 160, 400, 300, "第一段", 20), text(120, 200, 400, 300, "第二段", 20)], { theme });
    expect(page.overlaps).toBe(1);
  });

  it("文字压在色块上不算压叠（底色是有意的）", () => {
    const page = measurePage([shape(80, 160, 400, 300), text(120, 200, 300, 100, "压在色块上的字", 20)], { theme });
    expect(page.overlaps).toBe(0);
  });

  it("字号全挤成一档 → 1 档（页面显平）", () => {
    const page = measurePage([text(80, 160, 500, 40, "标题", 20), text(80, 260, 500, 40, "正文", 20)], { theme });
    expect(page.tierSpan).toBe(1);
  });

  it("字号跨三档", () => {
    const page = measurePage([
      text(80, 160, 900, 90, "主张", 54),
      text(80, 280, 900, 40, "支撑", 24),
      text(80, 360, 900, 30, "注脚", 13),
    ], { theme });
    expect(page.tierSpan).toBe(3);
  });

  it("全屏色块算背景，不算内容块", () => {
    const page = measurePage([shape(0, 140, 1280, 540), text(80, 200, 500, 60, "一句结论", 40)], { theme });
    expect(page.elementCount).toBe(1);
  });

  it("同输入同输出（确定性）", () => {
    const elements = [shape(80, 160, 400, 300), text(80, 500, 400, 40, "结论", 24)];
    expect(measurePage(elements, { theme })).toEqual(measurePage(elements, { theme }));
  });
});

describe("全册结构指标", () => {
  const pageA = [shape(80, 160, 800, 400)];
  const pageB = [shape(80, 160, 400, 400), text(500, 160, 300, 60, "一句话", 24)];
  const tablePage = [{ type: "table", x: 80, y: 160, w: 1000, h: 400, columns: [], rows: [] } as unknown as SpecElement];

  it("连续三页同骨架 → 失败", () => {
    const report = deckStructure({ pages: [pageA, pageA, pageA], theme, keys: ["x", "x", "x"] });
    expect(report.maxKeyRun).toBe(3);
    expect(report.failures.join(" ")).toContain("连续");
  });

  it("骨架交替 → 不判失败", () => {
    const report = deckStructure({ pages: [pageA, pageB, pageA, pageB], theme, keys: ["x", "y", "x", "y"] });
    expect(report.maxKeyRun).toBe(1);
    expect(report.keyVariety).toBe(2);
  });

  it("表格超过配额 → 失败", () => {
    const pages = [tablePage, tablePage, pageA, pageA, pageA];
    const report = deckStructure({ pages, theme });
    expect(report.tableAllowance).toBe(1);
    expect(report.failures.join(" ")).toContain("表格");
  });

  it("留白跳变过大 → 失败", () => {
    const dense = [shape(0, 140, 1240, 500)];
    const airy = [shape(0, 140, 140, 100)];
    const report = deckStructure({ pages: [dense, airy], theme });
    expect(report.maxWhitespaceJump).toBeGreaterThan(MAX_WHITESPACE_JUMP);
    expect(report.failures.join(" ")).toContain("留白率跳变");
  });

  it("摘要能一行读完", () => {
    const report = deckStructure({ pages: [pageA, pageB], theme, keys: ["x", "y"] });
    const line = structureSummary(report);
    expect(line).toContain("2 页");
    expect(line).toContain("对齐轴");
  });
});

describe("结构档随观看距离走（基线校准）", () => {
  /**
   * 这一组是拿 nexwing 13 页实测值反推的：那份 deck 页均有 4 条对齐轴、
   * 最长行 33 字、主角 19%——按投影档的尺子每页都不合格，但它本来就不是投影用的。
   */
  const nexwingLike = [
    text(80, 160, 300, 60, "第一栏标题文字", 24),
    text(400, 160, 300, 60, "第二栏标题文字", 24),
    text(720, 160, 300, 60, "第三栏标题文字", 24),
    text(80, 240, 880, 300, "这一行会很长因为版心很宽而字号不大所以一行能塞下三十多个汉字这是研读材料的常态", 13),
  ];

  it("近距（研读）档：多栏 + 长行不判失败", () => {
    const report = deckStructure({ pages: [nexwingLike], theme, distance: "near", density: "dense" });
    expect(report.pages[0]!.alignAxes).toBeGreaterThan(2);
    expect(report.pages[0]!.measureMax).toBeGreaterThan(22);
    expect(report.failures.filter((line) => line.includes("对齐轴"))).toHaveLength(0);
    expect(report.failures.filter((line) => line.includes("行长度"))).toHaveLength(0);
  });

  it("远距（投影）档：同样的页判对齐轴与行长度失败", () => {
    const report = deckStructure({ pages: [nexwingLike], theme, distance: "far" });
    const text = report.failures.join(" ");
    expect(text).toContain("对齐轴");
    expect(text).toContain("行长度");
  });

  it("两档的行长度上限差 1.5 倍（正文 22 vs 33 字）", () => {
    const projected = craftBandFor("far");
    const document = craftBandFor("near");
    expect(measureCharsFor(theme.typeScale.body, theme.typeScale, projected)).toBe(22);
    expect(measureCharsFor(theme.typeScale.body, theme.typeScale, document)).toBe(33);
    expect(document.maxAlignAxes).toBeGreaterThan(projected.maxAlignAxes);
    expect(document.heroAreaRatio.min).toBeLessThan(projected.heroAreaRatio.min);
  });

  it("字号档超过档位上限 → 判失败", () => {
    const page = [
      text(80, 160, 900, 90, "主张", 54),
      text(80, 260, 900, 60, "一级", 32),
      text(80, 330, 900, 50, "二级", 26),
      text(80, 390, 900, 40, "正文", 20),
      text(80, 440, 900, 30, "注脚", 13),
    ];
    const report = deckStructure({ pages: [page], theme, distance: "far" });
    expect(report.pages[0]!.tierSpan).toBeGreaterThan(4);
    expect(report.failures.join(" ")).toContain("档");
  });

  it("投影档留白过少 → 判失败（挤成一张纸）", () => {
    const crowded = [shape(0, 140, 1240, 520), text(80, 160, 1100, 480, "满版文字", 20)];
    const report = deckStructure({ pages: [crowded], theme, distance: "far", density: "standard" });
    expect(report.failures.join(" ")).toContain("留白率");
  });
});

describe("maxConsecutiveRun", () => {
  it("数最长连续段，缺失 key 不参与", () => {
    expect(maxConsecutiveRun(["a", "a", "b", "b", "b", "a"])).toBe(3);
    expect(maxConsecutiveRun([undefined, undefined, "a"])).toBe(1);
    expect(maxConsecutiveRun([])).toBe(0);
  });
});
