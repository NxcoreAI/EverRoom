import { describe, expect, it } from "vitest";
import { isPptxGenJsPage, pageSpecFromOperations, type PptxGenJsPage } from "../src/modules/subagents/slides-pptx-exec.js";
import type { ChartElement, SpecElement, TableElement, TextElement } from "../src/modules/slides-layout/elements.js";

const PAGE: PptxGenJsPage = {
  kind: "pptxgenjs-page",
  layout: "LAYOUT_WIDE",
  background: "21295C",
  operations: [
    { op: "addText", text: "深圳 45 年", options: { x: 0.9, y: 2.2, w: 11.5, h: 1.6, fontSize: 66, bold: true, color: "FFFFFF", fontFace: "Microsoft YaHei", isTextBox: true, margin: 0 } },
    { op: "addShape", shapeType: "roundRect", options: { x: 0.9, y: 4.9, w: 3.75, h: 1.5, rectRadius: 0.08, fill: { color: "2A3568" }, line: { color: "3A4A80", width: 1 } } },
    { op: "addChart", chartType: "bar", data: [{ name: "GDP", labels: ["1980", "2025"], values: [2.7, 38700] }], options: { chartColors: ["065A82"], showValue: true, catAxisLabelColor: "5B6B7B" } },
    { op: "addTable", rows: [["产业", { text: "规模", options: { bold: true, color: "FFFFFF", fill: { color: "065A82" } } }]], options: { x: 0.6, y: 1.9, w: 12.1, colW: [3.0, 2.8], fontSize: 14 } },
    { op: "addNotes", notes: "开场：立起规模感。" },
  ],
};

describe("pageSpecFromOperations", () => {
  it("完整页面映射：英寸→像素、裸 hex→#hex、图表/表格/讲稿各就各位", () => {
    expect(isPptxGenJsPage(PAGE)).toBe(true);
    const { spec, warnings } = pageSpecFromOperations(PAGE);
    expect(warnings).toEqual([]);
    expect(spec.background).toBe("#21295C");
    expect(spec.notes).toBe("开场：立起规模感。");
    const text = spec.elements[0] as TextElement;
    expect(text).toMatchObject({ type: "text", x: 86, w: 1104, h: 154 });
    expect(text.paragraphs[0]!.runs[0]).toMatchObject({ text: "深圳 45 年", sizePt: 66, bold: true, color: "#FFFFFF", font: "Microsoft YaHei" });
    const shape = spec.elements[1] as { type: string; shape: string; fill: string; adj: number; stroke: { color: string; widthPt: number } };
    expect(shape).toMatchObject({ type: "shape", shape: "roundRect", fill: "#2A3568" });
    expect(shape.stroke).toEqual({ color: "#3A4A80", widthPt: 1 });
    expect(shape.adj).toBeGreaterThan(0);
    const chart = spec.elements[2] as ChartElement;
    expect(chart).toMatchObject({ type: "chart", chart: "bar", categories: ["1980", "2025"], series: [{ name: "GDP", values: [2.7, 38700] }], colors: ["#065A82"], dataLabels: true });
    expect(chart.axis?.labelColor).toBe("#5B6B7B");
    const table = spec.elements[3] as TableElement;
    expect(table).toMatchObject({ type: "table", colWidths: [3, 2.8], fontSize: 14, w: 1162 });
    expect(table.rows[0]![1]).toMatchObject({ text: "规模", bold: true, color: "#FFFFFF", fill: "#065A82", align: "left" });
  });

  it("未知指令只告警不阻塞；非 pptxgenjs-page 不识别", () => {
    expect(isPptxGenJsPage({ version: 2, nodes: [] })).toBe(false);
    const { spec, warnings } = pageSpecFromOperations({ kind: "pptxgenjs-page", operations: [{ op: "addMovie", options: {} } as Record<string, unknown>] });
    expect(spec.elements).toEqual([]);
    expect(warnings[0]).toMatch(/addMovie/);
  });
});
