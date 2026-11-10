import { describe, expect, it } from "vitest";
import { niceStep, valueAxisPlan } from "../src/modules/slides-layout/chart-axis.js";
import { normalizeTree } from "../src/modules/slides-layout/tree/schema.js";
import { compileTree } from "../src/modules/slides-layout/tree/compile.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";

/**
 * 值轴刻度的回归样本来自真实产物 `screenshots/ppt-audit/02-latest-deck-data-page.png`：
 * 两根柱子（2.7 / 3.87）配上 0 到 4.5、步长 0.5 的十条 Y 轴刻度标签，
 * 而柱顶已经有 64pt 的数据标签。这是纯噪音。
 */
describe("好读步长", () => {
  it("吸到 1/2/2.5/5/10 × 10^k", () => {
    expect(niceStep(0.3)).toBe(0.5);
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.2)).toBe(2);
    expect(niceStep(2.3)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(1.1)).toBe(2);
    expect(niceStep(0.011)).toBeCloseTo(0.02, 6);
  });

  it("非法输入给 1，不返回 NaN/0", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(niceStep(bad)).toBe(1);
    }
  });
});

describe("值轴刻度方案", () => {
  it("两根柱子 + 数据标签 → 整条值轴隐藏（图 02 的问题）", () => {
    const plan = valueAxisPlan({ values: [2.7, 3.87], dataLabels: true, categories: 2 });
    expect(plan).toEqual({ hideValueAxis: true });
  });

  it("类目多时给 3~5 条刻度的步长，而不是隐藏", () => {
    const plan = valueAxisPlan({ values: [12, 19, 8, 15, 22, 11, 17], dataLabels: true, categories: 7 });
    expect(plan.hideValueAxis).toBeUndefined();
    const step = plan.majorUnit!;
    const ticks = Math.ceil(22 / step);
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(ticks).toBeLessThanOrEqual(6);
  });

  it("没有数据标签时绝不隐藏值轴（否则整张图没有数字）", () => {
    const plan = valueAxisPlan({ values: [2.7, 3.87], dataLabels: false, categories: 2 });
    expect(plan.hideValueAxis).toBeUndefined();
    expect(plan.majorUnit).toBeGreaterThan(0);
  });

  it("全零/空数据不插手，交给引擎兜底", () => {
    expect(valueAxisPlan({ values: [], dataLabels: true, categories: 3 })).toEqual({});
    expect(valueAxisPlan({ values: [0, 0], dataLabels: false, categories: 2 })).toEqual({});
    expect(valueAxisPlan({ values: [Number.NaN, Number.POSITIVE_INFINITY], dataLabels: false, categories: 2 })).toEqual({});
  });

  it("负值按绝对值取量级（瀑布/涨跌类图不打乱刻度）", () => {
    const plan = valueAxisPlan({ values: [-40, 25, 15], dataLabels: false, categories: 3 });
    expect(plan.majorUnit).toBeGreaterThan(0);
    expect(Number.isFinite(plan.majorUnit!)).toBe(true);
  });

  it("同输入同输出（确定性）", () => {
    const input = { values: [3.87, 2.7, 5.5], dataLabels: true, categories: 3 };
    expect(valueAxisPlan(input)).toEqual(valueAxisPlan(input));
  });
});

describe("编译产物真的带上了刻度方案", () => {
  const CONTRACT = contractFromStyleParams({});
  const compileChart = (node: Record<string, unknown>) => {
    const elements = compileTree(normalizeTree({
      version: 2, role: "data", composition: "hero-data",
      nodes: [node],
    }), CONTRACT).spec.elements;
    return elements.find((element) => element.type === "chart")!;
  };

  it("两柱 + 数据标签 → 产物里 hideValueAxis=true（图 02 的十条刻度消失）", () => {
    const chart = compileChart({
      type: "chart", kind: "bar", categories: ["2024", "2025"],
      series: [{ name: "占比", values: [38, 43] }], dataLabels: true,
      slot: { col: [1, 8], row: [1, 6] },
    });
    if (chart.type !== "chart") throw new Error("no chart");
    expect(chart.axis?.hideValueAxis).toBe(true);
    expect(chart.axis?.majorUnit).toBeUndefined();
  });

  it("多类目 → 产物里带 majorUnit，而不是隐藏", () => {
    const chart = compileChart({
      type: "chart", kind: "bar",
      categories: ["1", "2", "3", "4", "5", "6", "7"],
      series: [{ name: "占比", values: [12, 19, 8, 15, 22, 11, 17] }], dataLabels: false,
      slot: { col: [1, 8], row: [1, 6] },
    });
    if (chart.type !== "chart") throw new Error("no chart");
    expect(chart.axis?.majorUnit).toBeGreaterThan(0);
    expect(chart.axis?.hideValueAxis).toBeUndefined();
  });
});
