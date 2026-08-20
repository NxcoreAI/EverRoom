import mammoth from "mammoth";
import TurndownService from "turndown";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { convertRawEmailToMarkdown } from "./email-content.js";
import { IngestError } from "./types.js";

/**
 * U2 格式扩展（unified-ingest-plan §5.3）：office/html/csv/eml -> markdown，
 * 全确定性零 LLM。约定：标题取文件名（文档内标题保留为正文首行），
 * 结构信息尽量保留（表格/分级标题/列表），转换失败 convert_failed。
 */

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
// 表格降级保底：GFM 表由 mammoth 输出 <table>，turndown 需显式开启规则
turndown.keep(["sub", "sup"]);

/** docx → md：mammoth 半结构化 HTML → turndown。 */
export async function docxToMarkdown(buffer: Buffer): Promise<string> {
  try {
    const { value: html } = await mammoth.convertToHtml({ buffer });
    const markdown = turndown.turndown(html ?? "");
    if (!markdown.trim()) throw new IngestError("docx 无可提取文本", "empty_content");
    return markdown;
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(`docx 转换失败：${(error as Error).message}`, "convert_failed");
  }
}

/** html → md：同一条 turndown 管线。 */
export function htmlToMarkdown(buffer: Buffer): string {
  try {
    const markdown = turndown.turndown(buffer.toString("utf8"));
    if (!markdown.trim()) throw new IngestError("html 无可提取文本", "empty_content");
    return markdown;
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(`html 转换失败：${(error as Error).message}`, "convert_failed");
  }
}

/** RFC 822 / MIME email (.eml) -> cleaned canonical Markdown body. */
export async function emlToMarkdown(buffer: Buffer): Promise<string> {
  try {
    const result = await convertRawEmailToMarkdown(buffer);
    if (!result.markdown.trim()) throw new IngestError("eml 无可提取正文", "empty_content");
    return result.markdown;
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(`eml 转换失败：${(error as Error).message}`, "convert_failed");
  }
}

/** 单元格 → GFM 安全文本（竖线/换行转义，空值占位）。 */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return " ";
  let text: string;
  if (typeof value === "object") {
    if ("text" in value && value.text !== null && value.text !== undefined) text = String(value.text);
    else if ("result" in value && value.result !== null && value.result !== undefined) text = String(value.result);
    else if (value instanceof Date) text = value.toISOString();
    else text = " ";
  } else {
    text = String(value);
  }
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || " ";
}

/** xlsx → md：每个 sheet 一个二级标题 + GFM 表。 */
export async function xlsxToMarkdown(buffer: Buffer): Promise<string> {
  try {
    const workbook = new ExcelJS.Workbook();
    // exceljs 的类型收窄到其自带 Buffer 声明（与 @types/node 泛型不兼容），
    // 运行时接受任意 Uint8Array——经函数签名断言桥接
    const load = workbook.xlsx.load.bind(workbook.xlsx) as unknown as
      (data: Uint8Array) => Promise<ExcelJS.Workbook>;
    await load(buffer);
    const parts: string[] = [];
    workbook.eachSheet((sheet) => {
      const rows: string[] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells = Array.from({ length: Math.max(row.cellCount, 1) }, (_, index) =>
          cellText(row.getCell(index + 1).value));
        rows.push(`| ${cells.join(" | ")} |`);
      });
      if (rows.length === 0) return;
      const width = rows[0]!.split("|").length - 2;
      parts.push(`## ${sheet.name}\n\n${rows[0]}\n|${" --- |".repeat(width)}\n${rows.slice(1).join("\n")}`);
    });
    if (parts.length === 0) throw new IngestError("xlsx 无非空工作表", "empty_content");
    return parts.join("\n\n");
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(`xlsx 转换失败：${(error as Error).message}`, "convert_failed");
  }
}

/** csv → md：首行当表头，RFC4180 引号规则解析。 */
export function csvToMarkdown(buffer: Buffer): string {
  const text = buffer.toString("utf8");
  const rows = parseCsv(text);
  if (rows.length === 0) throw new IngestError("csv 无数据行", "empty_content");
  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => {
    const cells = [...row];
    while (cells.length < width) cells.push("");
    return cells.map((cell) => cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || " ");
  });
  const [header, ...body] = padded;
  return [
    `| ${header!.join(" | ")} |`,
    `|${" --- |".repeat(width)}`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^﻿/, ""); // BOM
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; continue; }
    if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (char === "\r") continue;
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((line) => line.some((value) => value.trim().length > 0));
}

/**
 * pptx → md：jszip 解 slideN.xml，`<a:t>` 文本聚合为页级列表。
 * 首段文本当页标题（PPT 结构事实：占位符文本顺序即阅读顺序）。
 */
export async function pptxToMarkdown(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));
    if (slideNames.length === 0) throw new IngestError("pptx 无幻灯片", "empty_content");
    const parts: string[] = [];
    for (const name of slideNames) {
      const xml = await zip.files[name]!.async("string");
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXmlEntities(match[1] ?? "").trim())
        .filter((value) => value.length > 0);
      if (texts.length === 0) continue;
      const [heading, ...bullets] = texts;
      parts.push([
        `## 第 ${slideNumberOf(name)} 页：${heading}`,
        ...(bullets.length > 0 ? ["", ...bullets.map((bullet) => `- ${bullet}`)] : []),
      ].join("\n"));
    }
    if (parts.length === 0) throw new IngestError("pptx 无可提取文本", "empty_content");
    return parts.join("\n\n");
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(`pptx 转换失败：${(error as Error).message}`, "convert_failed");
  }
}

function slideNumberOf(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 扩展名 -> 转换器（U2 注册点：加一行 case 即新格式）。 */
export function converterOfExtension(
  extension: string,
): ((buffer: Buffer) => string | Promise<string>) | null {
  switch (extension.trim().toLowerCase()) {
    case "docx": return docxToMarkdown;
    case "xlsx": return xlsxToMarkdown;
    case "pptx": return pptxToMarkdown;
    case "csv": return csvToMarkdown;
    case "eml": return emlToMarkdown;
    case "html":
    case "htm": return htmlToMarkdown;
    default: return null;
  }
}
