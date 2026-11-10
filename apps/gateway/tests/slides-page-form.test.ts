import { describe, expect, it } from "vitest";
import {
  PAGE_FORMS,
  PAGE_FORM_SPEC,
  deriveComposition,
  deriveSkeleton,
  factsMaxForForm,
  isPageForm,
  proseBudgetForForm,
  proseCoefficientForForm,
  unitsValid,
} from "../src/modules/subagents/slides-page-form.js";
import { SCENE_DENSITIES, proseBudgetBaseForDensity } from "../src/modules/slides-layout/scene.js";

describe("page form vocabulary", () => {
  it("九类形态各有系数与骨架，不缺字段", () => {
    expect(PAGE_FORMS).toHaveLength(9);
    for (const form of PAGE_FORMS) {
      const spec = PAGE_FORM_SPEC[form];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.when.length).toBeGreaterThan(0);
      expect(spec.skeleton.length).toBeGreaterThan(10);
      expect(spec.units[0]).toBeLessThanOrEqual(spec.units[1]);
      expect(proseCoefficientForForm(form)).toBe(spec.proseCoefficient);
      expect(factsMaxForForm(form)).toBe(spec.factsMax);
    }
  });

  it("字数预算 = 场景密度基准 × 形态系数", () => {
    for (const density of SCENE_DENSITIES) {
      const base = proseBudgetBaseForDensity(density);
      for (const form of PAGE_FORMS) {
        expect(proseBudgetForForm(form, density)).toBe(
          Math.round(base * PAGE_FORM_SPEC[form].proseCoefficient),
        );
      }
    }
    // 缺省密度是 standard
    expect(proseBudgetForForm("contrast")).toBe(proseBudgetForForm("contrast", "standard"));
  });

  it("密度越高预算越大，且相邻档位不为同一数", () => {
    const airy = proseBudgetForForm("contrast", "airy");
    const standard = proseBudgetForForm("contrast", "standard");
    const dense = proseBudgetForForm("contrast", "dense");
    expect(airy).toBeLessThan(standard);
    expect(standard).toBeLessThan(dense);
  });

  it("轻页与图页的预算低于论证页（节奏靠形态，不靠写长）", () => {
    const standard = (form: (typeof PAGE_FORMS)[number]) => proseBudgetForForm(form, "standard");
    expect(standard("light-page")).toBeLessThan(standard("single-fact"));
    expect(standard("image-led")).toBeLessThan(standard("breakdown"));
    expect(standard("sequence")).toBeGreaterThan(standard("contrast"));
  });

  it("序列/拆解类允许 5 个单元，单事实只允许 1 个", () => {
    expect(unitsValid("sequence", 5)).toBe(true);
    expect(unitsValid("sequence", 2)).toBe(false);
    expect(unitsValid("single-fact", 1)).toBe(true);
    expect(unitsValid("single-fact", 2)).toBe(false);
    expect(unitsValid("table", 8)).toBe(true);
    expect(unitsValid("table", 2)).toBe(false);
    expect(unitsValid("breakdown", 3.5)).toBe(false);
  });

  it("构图推导只产出能保证满足硬约束的取值", () => {
    // 有图才能走 editorial（硬约束要图 + h1/h2）
    expect(deriveComposition("contrast", { hasImage: true })).toBe("editorial");
    expect(deriveComposition("contrast", { hasImage: false })).toBe("swiss");
    // 图为主视觉 → immersive；没图时不得推成 immersive
    expect(deriveComposition("image-led", { hasImage: true })).toBe("immersive");
    expect(deriveComposition("image-led", { hasImage: false })).toBe("poster");
    expect(deriveComposition("quotation")).toBe("poster");
    expect(deriveComposition("single-fact")).toBe("hero-data");
    expect(deriveComposition("table")).toBe("swiss");
    expect(deriveComposition("light-page", { role: "section" })).toBe("chapter");
    expect(deriveComposition("light-page", { role: "content" })).toBe("poster");
  });

  it("同一形态与条件永远得到同一个构图（可复现，不靠模型猜）", () => {
    const runs = Array.from({ length: 5 }, () => deriveComposition("sequence", { hasImage: false }));
    expect(new Set(runs).size).toBe(1);
  });

  it("骨架意图是几何指令，带形态名与单元数", () => {
    const skeleton = deriveSkeleton("contrast", 2);
    expect(skeleton).toContain("两方对照");
    expect(skeleton).toContain("2 个单元");
    expect(skeleton).toContain("1.4:1");
  });

  it("非法形态名不被接受", () => {
    expect(isPageForm("editorial")).toBe(false);
    expect(isPageForm("swiss")).toBe(false);
    expect(isPageForm("single-fact")).toBe(true);
  });
});
