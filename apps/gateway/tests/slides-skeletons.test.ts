import { describe, expect, it } from "vitest";
import {
  SKELETONS,
  pickSkeleton,
  skeletonById,
  type SkeletonContent,
} from "../src/modules/slides-layout/tree/v3/skeletons.js";
import { normalizeTree } from "../src/modules/slides-layout/tree/schema.js";
import { compileTree } from "../src/modules/slides-layout/tree/compile.js";
import { measureDefects } from "../src/modules/slides-layout/tree/measure.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";
import { measurePage } from "../src/modules/slides-layout/page-structure.js";
import { formRuleFor } from "../src/modules/slides-layout/craft.js";
import { resolveTheme } from "../src/modules/slides-layout/theme.js";

const contract = contractFromStyleParams({} as never);
const theme = resolveTheme();

const CONTENT: SkeletonContent = {
  message: "四季度要把丢掉的节奏抢回来",
  supporting: ["芯片到货晚了两周", "验收标准中途改过一次"],
  facts: [{ value: "1.5", unit: "亿", label: "三季度营收" }],
  quote: { text: "我们输给了自己的节奏。", source: "销售负责人" },
  footer: "内部周会 · 2026Q4",
};

function build(skeletonId: string, content: SkeletonContent = CONTENT) {
  const skeleton = skeletonById(skeletonId);
  if (!skeleton) throw new Error(`缺骨架 ${skeletonId}`);
  const built = skeleton.build(content, {});
  const tree = normalizeTree(built.page);
  const result = compileTree(tree, contract);
  return { skeleton, built, tree, result };
}

describe("骨架：每个骨架都要产出合法、无缺陷、有主角的页面", () => {
  for (const skeleton of SKELETONS) {
    it(`${skeleton.id} 编译无缺陷`, () => {
      const { result } = build(skeleton.id);
      const defects = measureDefects(result, contract, {});
      expect(defects.map((defect) => `${defect.type}: ${defect.detail}`)).toEqual([]);
      expect(result.spec.elements.length).toBeGreaterThan(1);
    });

    it(`${skeleton.id} 结构指标符合该形态的档位`, () => {
      const { result } = build(skeleton.id);
      const structure = measurePage(result.spec.elements, { theme });
      // 阈值按形态取（单栏一页一主角，多栏按列数放宽），与 deckStructure 同一出处。
      const rule = formRuleFor(skeleton.form);
      expect(structure.heroAreaRatio).toBeGreaterThanOrEqual(rule.heroMin);
      expect(structure.heroAreaRatio).toBeLessThanOrEqual(rule.heroMax);
      expect(structure.alignAxes).toBeLessThanOrEqual(rule.maxAxes);
      expect(structure.tierSpan).toBeGreaterThanOrEqual(rule.minTiers);
      expect(structure.whitespaceRatio).toBeLessThanOrEqual(rule.whitespaceMax);
      expect(structure.measureOver).toBe(0);
      expect(structure.overlaps).toBe(0);
    });
  }
});

describe("容量协商：装不下就退回，不硬塞", () => {
  it("单事实页只吃两条支撑，第三条退回", () => {
    const skeleton = skeletonById("single-fact.number.hero-left")!;
    const built = skeleton.build({ ...CONTENT, supporting: ["一", "二", "三", "四"] });
    expect(built.rejected).toEqual(["三", "四"]);
  });

  it("引文页不吃支撑句", () => {
    const skeleton = skeletonById("quotation.quote.center")!;
    expect(skeleton.capacity.supportMax).toBe(0);
    const built = skeleton.build(CONTENT);
    expect(built.rejected).toEqual([]);
  });

  it("缺内容也不炸：没有数字时退回用 body 文本当主角", () => {
    const skeleton = skeletonById("single-fact.number.hero-left")!;
    const built = skeleton.build({ message: "只有一句话", facts: [{ body: "没有数字也要能排" }] });
    const result = compileTree(normalizeTree(built.page), contract);
    expect(measureDefects(result, contract, {})).toEqual([]);
  });
});

describe("选骨架：确定性打分", () => {
  it("按 form 过滤", () => {
    const picked = pickSkeleton({ form: "contrast", units: 2 });
    expect(picked.skeleton.form).toBe("contrast");
    expect(picked.candidates.every((row) => row.id.includes("contrast"))).toBe(true);
  });

  it("容量装不下的候选排到后面", () => {
    const picked = pickSkeleton({ form: "single-fact", units: 5 });
    expect(picked.candidates.filter((row) => row.fits)).toHaveLength(0);
    expect(picked.score).toBeLessThan(0);
  });

  it("同一骨架连用过两页后要换人（重复惩罚生效）", () => {
    const fresh = pickSkeleton({ form: "contrast", units: 2, emphasis: "title" });
    const again = pickSkeleton({
      form: "contrast",
      units: 2,
      emphasis: "title",
      recent: [fresh.skeleton.id, fresh.skeleton.id],
    });
    // 同 form 下有不止一个可用骨架时，连用两页后必须换；都不合适才允许重复。
    expect(again.skeleton.id).not.toBe(fresh.skeleton.id);
    expect(again.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("同一输入永远同一结果（可复现）", () => {
    const input = { form: "breakdown", units: 3, emphasis: "title" as const, recent: ["x"] };
    expect(pickSkeleton(input).skeleton.id).toBe(pickSkeleton(input).skeleton.id);
  });

  it("form 没有对应骨架时退回全库，不抛错", () => {
    const picked = pickSkeleton({ form: "no-such-form", units: 1 });
    expect(SKELETONS.map((skeleton) => skeleton.id)).toContain(picked.skeleton.id);
  });
});

describe("骨架纪律", () => {
  it("每个骨架恰好声明一次主角类型，不许空", () => {
    for (const skeleton of SKELETONS) {
      expect(skeleton.emphasis.length).toBeGreaterThan(0);
    }
  });

  it("骨架 id 唯一且是 form.emphasis.variant 形式", () => {
    const ids = SKELETONS.map((skeleton) => skeleton.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.split(".").length).toBeGreaterThanOrEqual(3);
  });

  it("骨架不写裸色号（颜色只能由契约给）", () => {
    for (const skeleton of SKELETONS) {
      const json = JSON.stringify(skeleton.build(CONTENT).page);
      expect(json).not.toMatch(/#[0-9a-fA-F]{6}/);
    }
  });
});
