/**
 * 组件联系表（可复现渲染基线）：固定代表场景内容 × 全宽/半页/窄栏 × 浅底/深底/品牌强调色。
 * 本仓无像素渲染器，基线口径 = 走真实编译管线（含重叠/溢出闸门）零缺陷 + 直扩产物
 * 正文 run 不低于 16pt、注释不低于 12pt。视觉评审轮换真机渲染时在此基线上对照。
 */

import { describe, expect, it } from "vitest";
import type { Frame } from "../../grid.js";
import { resolveTheme, type StyleParamsInput } from "../../theme.js";
import { expandComponent, normalizeComponentLeaf } from "./index.js";
import type { SpecElement } from "../../elements.js";
import { normalizeTree } from "../schema.js";
import { compileTree } from "../compile.js";
import { measureDefects } from "../measure.js";
import { contractFromStyleParams } from "../layout-contract.js";

const FULL: Frame = { x: 64, y: 120, w: 1152, h: 520 };
const HALF: Frame = { x: 64, y: 120, w: 560, h: 300 };
const COLUMN: Frame = { x: 64, y: 120, w: 340, h: 520 };

const LIGHT: StyleParamsInput = {
  palette: { background: "#fafaf8", primary: "#2447b0", accent: "#c9a063", text: "#16181d" },
  typography: { fontHeading: "Songti SC", fontBody: "PingFang SC" },
  decoration: { cardStroke: "#d8d5cc", cardShadow: "soft", divider: "line" },
  composition: "editorial",
};
const DARK: StyleParamsInput = {
  palette: { background: "#101216", primary: "#5b7bd5", accent: "#c9a063", text: "#f5f7fa", onDarkText: "#f5f7fa" },
  typography: { fontHeading: "Songti SC", fontBody: "PingFang SC" },
  decoration: { cardStroke: "#2a2e36", divider: "line" },
  composition: "editorial",
};
const BRAND: StyleParamsInput = {
  palette: { background: "#ffffff", primary: "#0f6b4f", accent: "#0f6b4f", text: "#14201b" },
  typography: { fontHeading: "Songti SC", fontBody: "PingFang SC" },
  decoration: { cardStroke: "#d7e2dc", divider: "line" },
  composition: "editorial",
};

/** 五个代表场景的固定内容（BP 常用页型）。 */
const SCENARIOS: Record<string, Record<string, unknown>> = {
  经营KPI: {
    name: "stats",
    items: [
      { value: "2.83", unit: "万亿元", label: "2026 市场规模" },
      { value: "38", unit: "%", label: "年复合增速" },
      { value: "1.2", unit: "亿元", label: "本年 GMV" },
    ],
  },
  产品卖点: {
    name: "featureCards",
    items: [
      { title: "直连工厂", body: "与源头工厂直接合作，出厂价直供，毛利显著优于传统经销。", icon: "check-circle" },
      { title: "柔性供应", body: "小单快反，以销定产，库存周转压缩到三十天以内。", icon: "light-bulb" },
      { title: "数据选品", body: "动销数据驱动月度换款，滞销率降到行业一半。", icon: "chart-bar" },
    ],
  },
  竞品比较: {
    name: "comparison",
    sides: [
      { title: "传统经销", points: ["层层加价 30%+", { text: "库存风险高", mark: "no" }, "终端反馈慢"] },
      { title: "直连模式", tag: "建议", points: [{ text: "出厂价直供", mark: "yes" }, { text: "以销定产", mark: "yes" }, "数据回流快"] },
    ],
    featured: 1,
  },
  发展里程碑: {
    name: "timeline",
    items: [
      { label: "2026", text: "品类验证：单城模型跑通" },
      { label: "2027", text: "渠道扩张：进入八个城市" },
      { label: "2028", text: "品牌溢价：自有品牌上线" },
    ],
  },
  团队介绍: {
    name: "teamGrid",
    members: [
      { name: "张一", role: "CEO", bio: "前头部品类负责人" },
      { name: "李二", role: "CTO", bio: "供应链系统十年" },
      { name: "王三", role: "COO", bio: "连锁零售运营" },
      { name: "赵四", role: "CMO", bio: "增长与品牌" },
    ],
  },
};

function runs(els: SpecElement[]): { text: string; sizePt?: number }[] {
  return els
    .filter((el): el is Extract<SpecElement, { type: "text" }> => el.type === "text")
    .flatMap((el) => el.paragraphs)
    .flatMap((p) => p.runs);
}

describe("组件联系表：全宽真实编译管线（含重叠/溢出闸门）", () => {
  for (const [scene, node] of Object.entries(SCENARIOS)) {
    for (const [themeName, styleParams] of Object.entries({ 浅底: LIGHT, 深底: DARK, 强调色: BRAND })) {
      it(`${scene} × ${themeName}：编译零缺陷`, () => {
        const contract = contractFromStyleParams(styleParams as never);
        const tree = normalizeTree({
          role: "content",
          title: `${scene}`,
          direction: "column",
          weights: [0.14, 0.86],
          children: [
            { type: "text", variant: "subtitle", text: `${scene} · ${themeName}` },
            { type: "component", ...(node as Record<string, unknown>) },
          ],
        });
        const result = compileTree(tree, contract);
        const defects = measureDefects(result, contract);
        const blocking = defects.filter((d) => d.type !== "min_size");
        expect(blocking, `${scene}/${themeName}: ${JSON.stringify(defects)}`).toEqual([]);
      });
    }
  }
});

describe("组件联系表：半页/窄栏直扩（字号下限）", () => {
  for (const [scene, node] of Object.entries(SCENARIOS)) {
    it(`${scene}：半页装下（字号下限成立）或报可执行缺陷`, () => {
      const leaf = normalizeComponentLeaf({ type: "component", ...node }, "root");
      let els: SpecElement[];
      try {
        els = expandComponent(leaf, HALF, resolveTheme(LIGHT as never), "root");
      } catch (error) {
        // 半页贴着字号下限的组件（如 3 项长单位 KPI）按规格报可执行缺陷，不静默缩字。
        expect((error as Error).message).toMatch(/LAYOUT_LEAF_INVALID: /);
        return;
      }
      for (const run of runs(els)) {
        expect(run.sizePt ?? 18, `${scene} run「${run.text}」`).toBeGreaterThanOrEqual(12);
        if ([...run.text].length >= 10) {
          expect(run.sizePt ?? 18, `${scene} 正文「${run.text.slice(0, 10)}」`).toBeGreaterThanOrEqual(16);
        }
      }
    });

    it(`${scene}：窄栏要么装下（字号下限成立）要么报可执行缺陷，不静默缩字`, () => {
      const leaf = normalizeComponentLeaf({ type: "component", ...node }, "root");
      let els: SpecElement[];
      try {
        els = expandComponent(leaf, COLUMN, resolveTheme(LIGHT as never), "root");
      } catch (error) {
        expect((error as Error).message).toMatch(/LAYOUT_LEAF_INVALID: .*（|LAYOUT_LEAF_INVALID: .*——/);
        return;
      }
      for (const run of runs(els)) {
        expect(run.sizePt ?? 18, `${scene} run「${run.text}」`).toBeGreaterThanOrEqual(12);
      }
    });
  }
});
