import { describe, expect, it } from "vitest";
import { normalizeTree } from "../src/modules/slides-layout/tree/schema.js";
import { compileTree } from "../src/modules/slides-layout/tree/compile.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";
import { contrastRatio } from "../src/modules/slides-layout/color-guard.js";
import type { SpecElement } from "../src/modules/slides-layout/elements.js";

/**
 * 节点级颜色守门：色板级守门保证"每一对角色都合格"，但具体落位仍会糊在一起——
 * 例如 `tone: primary` 压在 `panel: tint` 上（同一族色），或 stats 数值落在墨面板上。
 * 这里断言编译期把这类组合拉回可读。
 */

const CONTRACT = contractFromStyleParams({});
const colors = CONTRACT.theme.colors;

const compile = (raw: unknown): SpecElement[] => compileTree(normalizeTree(raw), CONTRACT).spec.elements;

const textElements = (elements: SpecElement[]) =>
  elements.filter((element): element is Extract<SpecElement, { type: "text" }> => element.type === "text");

// 文字可以挂在 text 元素上，也可以挂在 shape 上（图注徽章、色块）
const allRuns = (elements: SpecElement[]) =>
  elements
    .flatMap((element) => (element.type === "text" || element.type === "shape" ? element.paragraphs ?? [] : []))
    .flatMap((paragraph) => paragraph.runs ?? []);

const runOf = (elements: SpecElement[], text: string) => allRuns(elements).find((run) => run.text.includes(text));

describe("节点级对比度守门（v2 编译期）", () => {
  it("反白色文字压在浅色 tint 板上会被压深到可读", () => {
    const elements = compile({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{
        type: "group",
        slot: { col: [1, 8], row: [1, 8] },
        panel: "tint",
        direction: "column",
        children: [{ type: "text", token: "body", tone: "inverse", text: "反白字压在浅色板上" }],
      }],
    });
    const run = runOf(elements, "反白字");
    expect(run?.color).toBeDefined();
    // 承载面是 tint 板（primarySoft），不是页面底色
    expect(contrastRatio(run!.color!, colors.primarySoft)).toBeGreaterThanOrEqual(4.5);
    // 原色（near-white）在浅板上不可读，必须被改掉
    expect(run!.color).not.toBe(colors.onDarkText);
  });

  it("stats 数值落在墨面板上会被提亮到 3:1（大字）", () => {
    const elements = compile({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{
        type: "group",
        slot: { col: [1, 8], row: [1, 8] },
        panel: "dark",
        direction: "column",
        children: [{
          type: "stats",
          items: [
            { value: "3.87", unit: "万亿元", label: "2025 年 GDP" },
            { value: "21.38", unit: "万元", label: "人均 GDP" },
          ],
        }],
      }],
    });
    const valueRun = runOf(elements, "3.87");
    expect(valueRun?.color).toBeDefined();
    // h2 档 ≥24pt：按 WCAG 大字 3:1 判
    expect((valueRun!.sizePt ?? 0)).toBeGreaterThanOrEqual(24);
    expect(contrastRatio(valueRun!.color!, colors.darkBackground)).toBeGreaterThanOrEqual(3);
  });

  it("带 alpha 的承载面不参与守门（半透明纱罩算不准，不猜）", () => {
    const elements = compile({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{
        type: "image",
        url: `everroom-material://${"b".repeat(64)}`,
        fit: "cover",
        caption: "照片说明",
        slot: { col: [1, 8], row: [1, 6] },
      }],
    });
    const run = runOf(elements, "照片说明");
    // 图注徽章是半透明墨底 + 反白字：这一对由构造保证，守门不该再动它
    expect(run?.color).toBe(colors.onDarkText);
  });

  it("出血大图页面不做颜色介入（照片上的对比度算不准）", () => {
    const elements = compile({
      version: 2,
      role: "cover",
      composition: "immersive",
      nodes: [
        { type: "image", url: `everroom-material://${"a".repeat(64)}`, fit: "cover", bleed: true, slot: { col: [1, 12], row: [1, 8] } },
        { type: "text", token: "body", tone: "primary", text: "照片上的主色文字", slot: { col: [1, 6], row: [3, 4] } },
      ],
    });
    const run = runOf(elements, "照片上的主色文字");
    expect(run?.color).toBe(colors.primary);
  });

  it("页脚与图注不再写死 10pt，跟场景 caption 走", () => {
    const elements = compile({
      version: 2,
      role: "content",
      composition: "swiss",
      footer: { left: "左页脚", pageNumbers: true },
      nodes: [{ type: "text", token: "body", text: "正文", slot: { col: [1, 6], row: [1, 3] } }],
    });
    const footerRun = runOf(elements, "左页脚");
    expect(footerRun?.sizePt).toBe(CONTRACT.theme.typeScale.caption);
    expect(footerRun?.sizePt).toBeGreaterThanOrEqual(12);
  });

  it("同一场景下颜色守门是确定性的（两次编译逐元素一致）", () => {
    const tree = {
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{
        type: "group",
        slot: { col: [1, 8], row: [1, 8] },
        panel: "tint",
        direction: "column",
        children: [{ type: "text", token: "body", tone: "primary", text: "确定性" }],
      }],
    };
    expect(JSON.stringify(compile(tree))).toBe(JSON.stringify(compile(tree)));
  });
});

describe("页面级 stats 帧感知降档", () => {
  const statsTree = (slot: { col: [number, number]; row: [number, number] }): unknown => ({
    version: 2, role: "data", composition: "swiss",
    nodes: [{
      type: "stats",
      items: [
        { value: "63", unit: "万美金", label: "众筹金额" },
        { value: "774", unit: "名", label: "支持者" },
      ],
      slot,
    }],
  });
  const runSize = (elements: SpecElement[]) =>
    Math.max(...textElements(elements).flatMap(e => e.paragraphs.flatMap(p => p.runs.map(r => r.sizePt ?? 0))));

  it("宽槽保持 h2 大数字", () => {
    const elements = compile(statsTree({ col: [1, 12], row: [4, 8] }));
    expect(runSize(elements)).toBe(CONTRACT.theme.typeScale.h2);
  });

  it("窄槽自动降档到放得下的字号（group 深处的小帧不再必然溢出）", () => {
    // 复现线上案例：group 切出的 ~330×130px 小帧，h2(32pt) 两行 87px 装不下。
    const elements = compile({
      version: 2, role: "cover", composition: "swiss", dark: true,
      nodes: [{
        type: "group", direction: "row",
        slot: { col: [1, 12], row: [5, 8] },
        children: [{
          type: "group", direction: "column", weights: [1, 1.1], gapScale: 0.6,
          children: [
            { type: "text", token: "body", text: "众筹验证全球付费需求" },
            { type: "stats", items: [
              { value: "63", unit: "万美金", label: "众筹金额" },
              { value: "774", unit: "名", label: "支持者" },
            ] },
          ],
        }],
      }],
    });
    const size = runSize(elements);
    expect(size).toBeLessThan(CONTRACT.theme.typeScale.h2);
    // 降档后估算高度必须放得进格子，否则 overflow/overlap 缺陷依旧。
    const boxes = textElements(elements).filter(e => e.paragraphs.some(p => p.runs.some(r => r.text === "63")));
    const h2 = CONTRACT.theme.typeScale.h2 * 1.8;
    expect(boxes.every(box => box.h >= Math.min(h2, size * 1.8 + 30))).toBe(true);
  });
});
