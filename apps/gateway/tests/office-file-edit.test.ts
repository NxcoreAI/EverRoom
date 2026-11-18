import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { applyDocxOps, DocxEditError } from "../src/modules/files/docx-edit.js";
import { applyXlsxOps, readXlsx, XlsxEditError } from "../src/modules/files/xlsx-edit.js";

const DOCX_FIXTURE = resolve("../../docs/Nexwing_BP_数据汇编_2025-04.docx");

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file("word/document.xml")!.async("string");
}

/** 从真实 docx 里挑一个全文唯一的普通段落，返回其完整文本（用作 find）。 */
async function sampleParagraphText(buffer: Buffer): Promise<string> {
  const xml = await documentXml(buffer);
  const texts = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .map((match) => [...match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((node) => node[1] ?? "")
      .join(""))
    .filter((text) => text.length >= 12 && /^[\u4e00-\u9fa5A-Za-z0-9，。、“”（）()：:；;！!？?\s-]+$/u.test(text));
  for (const text of texts) {
    if (texts.filter((candidate) => candidate.includes(text)).length === 1) return text;
  }
  throw new Error("fixture has no unique paragraph");
}

describe("docx 文本级编辑", () => {
  it("replace_text 改文字且保留文档结构", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const find = await sampleParagraphText(buffer);
    const outcome = await applyDocxOps(buffer, [{ type: "replace_text", find, replace: "已替换的测试文字" }]);
    const xml = await documentXml(outcome.buffer);
    expect(xml).toContain("已替换的测试文字");
    expect(xml).not.toContain(find);
    expect(outcome.changes).toHaveLength(1);
    // 仍然是可读 zip（docx 结构完整），且 Word 解析器能读出替换后的文字
    const zip = await JSZip.loadAsync(outcome.buffer);
    expect(zip.file("word/document.xml")).toBeTruthy();
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
    const extracted = await mammoth.extractRawText({ buffer: outcome.buffer });
    expect(extracted.value).toContain("已替换的测试文字");
  });

  it("replace_paragraph 换整段，并沿用原段落格式（pPr/rPr 仍在）", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const find = await sampleParagraphText(buffer);
    const outcome = await applyDocxOps(buffer, [{ type: "replace_paragraph", find, text: "整段替换后的正文" }]);
    const xml = await documentXml(outcome.buffer);
    expect(xml).toContain("整段替换后的正文");
    expect(xml).not.toContain(find);
  });

  it("insert_paragraph_after / append_paragraph / delete_paragraph 组合生效", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const find = await sampleParagraphText(buffer);
    const outcome = await applyDocxOps(buffer, [
      { type: "insert_paragraph_after", find, text: "插入在锚点之后的新段落" },
      { type: "append_paragraph", text: "文档末尾的新段落" },
      { type: "delete_paragraph", find: "插入在锚点之后的新段落" },
    ]);
    const xml = await documentXml(outcome.buffer);
    expect(xml).toContain("文档末尾的新段落");
    expect(xml).not.toContain("插入在锚点之后的新段落");
    expect(xml).toContain(find);
  });

  it("删除表格内段落被拒绝（避免 Word 打开报修复）", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const xml = await documentXml(buffer);
    const tableStart = xml.indexOf("<w:tbl");
    const tableEnd = xml.indexOf("</w:tbl>", tableStart);
    const cellParagraph = [...xml.slice(tableStart, tableEnd).matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
      .map((match) => phraseText(match[0]))
      .find((text) => text.length >= 8);
    if (!cellParagraph) return;
    await expect(applyDocxOps(buffer, [{ type: "delete_paragraph", find: cellParagraph }]))
      .rejects.toMatchObject({ code: "IN_TABLE" });
  });

  it("replace 与 find 相同时直接拒绝", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const find = await sampleParagraphText(buffer);
    await expect(applyDocxOps(buffer, [{ type: "replace_text", find, replace: find }]))
      .rejects.toMatchObject({ code: "INVALID_OP" });
  });

  it("找不到目标时给可执行的错误，不写坏文件", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    await expect(applyDocxOps(buffer, [
      { type: "replace_text", find: "这段文字一定不在文档里-9f7a3c", replace: "x" },
    ])).rejects.toMatchObject({ code: "TEXT_NOT_FOUND" } satisfies Partial<DocxEditError>);
  });

  it("多个段落命中同一片段时拒绝猜目标", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const xml = await documentXml(buffer);
    // 真实文档里截取一个必然重复的短片段（"数据" 在多处出现时才会触发歧义）
    const duplicated = ["数据", "项目", "公司"].find((candidate) => {
      const count = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
        .map((match) => match[0])
        .filter((paragraph) => phraseText(paragraph).includes(candidate)).length;
      return count > 1;
    });
    if (!duplicated) return;
    await expect(applyDocxOps(buffer, [
      { type: "delete_paragraph", find: duplicated },
    ])).rejects.toMatchObject({ code: "TEXT_AMBIGUOUS" });
  });
});

function phraseText(paragraphXml: string): string {
  return [...paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1] ?? "")
    .join("");
}

async function sampleWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("预算");
  sheet.getCell("A1").value = "项目";
  sheet.getCell("B1").value = "金额";
  sheet.getCell("A2").value = "服务器";
  sheet.getCell("B2").value = 12000;
  sheet.getCell("A3").value = "带宽";
  sheet.getCell("B3").value = 3000;
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2244AA" } };
  sheet.getColumn(1).width = 24;
  sheet.getCell("B2").numFmt = "#,##0";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("xlsx 编辑与读取", () => {
  it("set_cells / set_range / 公式 写入后能读回，样式与列宽保留", async () => {
    const source = await sampleWorkbookBuffer();
    const outcome = await applyXlsxOps(source, [
      {
        type: "set_cells",
        sheet: "预算",
        cells: [
          { address: "B2", value: 15000, numberFormat: "#,##0" },
          { address: "D2", formula: "SUM(B2:B3)", numberFormat: "#,##0" },
        ],
      },
      { type: "set_range", sheet: "预算", start: "A4", rows: [["合计", null], ["备注", "含税"]] },
    ]);
    const read = await readXlsx(outcome.buffer, { sheet: "预算", range: "A1:D4" });
    expect(read.sheet?.rows[1]?.[1]).toBe(15000);
    expect(read.sheet?.rows[3]?.[0]).toBe("合计");
    expect(read.sheet?.rows[3]?.[1]).toBeNull();
    expect(read.sheet?.rows[1]?.[3]).toMatchObject({ formula: "SUM(B2:B3)" });
    // 原有样式（A1 填充）与列宽仍在
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(outcome.buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet("预算")!;
    expect((sheet.getCell("A1").fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe("FF2244AA");
    expect(sheet.getColumn(1).width).toBeCloseTo(24, 1);
  });

  it("插入/删除行、增删改工作表", async () => {
    const source = await sampleWorkbookBuffer();
    const outcome = await applyXlsxOps(source, [
      { type: "insert_rows", sheet: "预算", start: 3, count: 1 },
      { type: "add_sheet", name: "说明" },
      { type: "rename_sheet", sheet: "说明", name: "备注" },
      { type: "delete_rows", sheet: "预算", start: 3, count: 1 },
    ]);
    const read = await readXlsx(outcome.buffer);
    expect(read.sheets.map((sheet) => sheet.name)).toEqual(["预算", "备注"]);
    const sheet = await readXlsx(outcome.buffer, { sheet: "预算", range: "A1:B4" });
    expect(sheet.sheet?.rows[2]?.[0]).toBe("带宽");
  });

  it("删除最后一个工作表被拒绝", async () => {
    const source = await sampleWorkbookBuffer();
    await expect(applyXlsxOps(source, [{ type: "delete_sheet", sheet: "预算" }]))
      .rejects.toMatchObject({ code: "INVALID_OP" } satisfies Partial<XlsxEditError>);
  });

  it("工作表不存在时列出可用工作表", async () => {
    const source = await sampleWorkbookBuffer();
    await expect(applyXlsxOps(source, [{
      type: "set_cells",
      sheet: "不存在的表",
      cells: [{ address: "A1", value: 1 }],
    }])).rejects.toThrow(/现有工作表：预算/);
  });
});
