import ExcelJS from "exceljs";

/**
 * Excel（.xlsx）编辑：用 exceljs 在原工作簿上改单元格/行/工作表，再整体
 * 写回。与 Word 的文本级编辑不同，exceljs 会重写工作簿结构，大多数样式、
 * 合并单元格、列宽、公式与数值格式能保留，但图表/图片/部分条件格式可能
 * 退化（工具描述里已提示）。
 */

export type XlsxCellValue = string | number | boolean | null;

export type XlsxEditOp =
  | {
    type: "set_cells";
    /** 工作表名；缺省 = 第一个工作表。 */
    sheet?: string;
    cells: Array<{
      /** A1 形式的单元格地址。 */
      address: string;
      value?: XlsxCellValue;
      /** 公式（不带前导 =）；给了 formula 时 value 作为缓存结果。 */
      formula?: string;
      /** 单元格数字格式，例如 "0.00"、"yyyy-mm-dd"、"0%"。 */
      numberFormat?: string;
    }>;
  }
  | {
    type: "set_range";
    sheet?: string;
    /** 起始单元格（A1 形式），值向右/向下铺开。 */
    start: string;
    rows: XlsxCellValue[][];
  }
  | {
    type: "insert_rows";
    sheet?: string;
    /** 1 起的行号。 */
    start: number;
    count?: number;
  }
  | {
    type: "delete_rows";
    sheet?: string;
    start: number;
    count?: number;
  }
  | { type: "add_sheet"; name: string }
  | { type: "rename_sheet"; sheet: string; name: string }
  | { type: "delete_sheet"; sheet: string };

export interface XlsxEditOutcome {
  buffer: Buffer;
  changes: string[];
}

export class XlsxEditError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "XlsxEditError";
  }
}

const MAX_OPS = 50;
const MAX_RANGE_ROWS = 5_000;
const MAX_RANGE_COLUMNS = 50;
const MAX_CELL_TEXT = 32_000;

const ADDRESS_PATTERN = /^([A-Za-z]{1,3})([1-9][0-9]{0,6})$/;
const RANGE_PATTERN = /^([A-Za-z]{1,3}[1-9][0-9]{0,6})(?::([A-Za-z]{1,3}[1-9][0-9]{0,6}))?$/;

function parseAddress(address: string): { column: number; row: number } {
  const match = ADDRESS_PATTERN.exec(address.trim());
  if (!match) throw new XlsxEditError("INVALID_OP", `单元格地址无效：${address}`);
  const letters = match[1]!.toUpperCase();
  let column = 0;
  for (const character of letters) column = column * 26 + (character.charCodeAt(0) - 64);
  return { column, row: Number(match[2]) };
}

function requireNumber(value: unknown, field: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new XlsxEditError("INVALID_OP", `${field} 必须是 >= ${minimum} 的整数`);
  }
  return value;
}

function cellValueOf(value: unknown): XlsxCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  const text = String(value);
  if (text.length > MAX_CELL_TEXT) throw new XlsxEditError("INVALID_OP", `单元格文本超过 ${MAX_CELL_TEXT} 字符`);
  return text;
}

function requireSheet(workbook: ExcelJS.Workbook, name: string | undefined): ExcelJS.Worksheet {
  if (name) {
    const sheet = workbook.getWorksheet(name);
    if (!sheet) {
      throw new XlsxEditError(
        "SHEET_NOT_FOUND",
        `工作表「${name}」不存在；现有工作表：${workbook.worksheets.map((item) => item.name).join("、")}`,
      );
    }
    return sheet;
  }
  const first = workbook.worksheets[0];
  if (!first) throw new XlsxEditError("SHEET_NOT_FOUND", "工作簿里没有工作表");
  return first;
}

function setCell(sheet: ExcelJS.Worksheet, address: string, op: { value?: XlsxCellValue; formula?: string; numberFormat?: string }): void {
  const cell = sheet.getCell(address);
  if (op.formula !== undefined && op.formula !== "") {
    const formula = op.formula.replace(/^=/, "");
    cell.value = op.value === null || op.value === undefined
      ? { formula }
      : { formula, result: op.value };
  } else {
    cell.value = op.value ?? null;
  }
  if (op.numberFormat) cell.numFmt = op.numberFormat;
}

export async function applyXlsxOps(
  buffer: Buffer,
  inputOps: readonly XlsxEditOp[],
): Promise<XlsxEditOutcome> {
  if (!Array.isArray(inputOps) || inputOps.length === 0) {
    throw new XlsxEditError("INVALID_OP", "ops 必须是非空数组");
  }
  if (inputOps.length > MAX_OPS) throw new XlsxEditError("INVALID_OP", `单次最多 ${MAX_OPS} 条操作`);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new XlsxEditError("NOT_XLSX", "文件不是有效的 .xlsx（或已损坏/带密码）");
  }
  if (workbook.worksheets.length === 0) throw new XlsxEditError("NOT_XLSX", "工作簿里没有工作表");

  const changes: string[] = [];
  for (const raw of inputOps) {
    const op = raw as Partial<XlsxEditOp> & { type?: unknown };
    switch (op.type) {
      case "set_cells": {
        if (!Array.isArray(op.cells) || op.cells.length === 0) {
          throw new XlsxEditError("INVALID_OP", "set_cells 需要非空 cells 数组");
        }
        const sheet = requireSheet(workbook, op.sheet);
        for (const cell of op.cells) {
          if (!cell || typeof cell.address !== "string") throw new XlsxEditError("INVALID_OP", "cells[].address 必填");
          setCell(sheet, cell.address, {
            ...(cell.value !== undefined ? { value: cellValueOf(cell.value) } : {}),
            ...(typeof cell.formula === "string" ? { formula: cell.formula } : {}),
            ...(typeof cell.numberFormat === "string" ? { numberFormat: cell.numberFormat } : {}),
          });
        }
        changes.push(`${sheet.name} 更新 ${op.cells.length} 个单元格`);
        break;
      }
      case "set_range": {
        if (!Array.isArray(op.rows) || op.rows.length === 0) {
          throw new XlsxEditError("INVALID_OP", "set_range 需要非空 rows 二维数组");
        }
        if (op.rows.length > MAX_RANGE_ROWS) throw new XlsxEditError("INVALID_OP", `rows 超过 ${MAX_RANGE_ROWS} 行`);
        const sheet = requireSheet(workbook, op.sheet);
        const start = parseAddress(typeof op.start === "string" ? op.start : "");
        op.rows.forEach((row, rowIndex) => {
          if (!Array.isArray(row)) throw new XlsxEditError("INVALID_OP", `第 ${rowIndex + 1} 行不是数组`);
          if (row.length > MAX_RANGE_COLUMNS) throw new XlsxEditError("INVALID_OP", `单行超过 ${MAX_RANGE_COLUMNS} 列`);
          row.forEach((value, columnIndex) => {
            sheet.getCell(start.row + rowIndex, start.column + columnIndex).value = cellValueOf(value);
          });
        });
        const widest = op.rows.reduce((max, row) => Math.max(max, row.length), 0);
        changes.push(`${sheet.name} 从 ${op.start} 写入 ${op.rows.length}×${widest} 区域`);
        break;
      }
      case "insert_rows": {
        const sheet = requireSheet(workbook, op.sheet);
        const start = requireNumber(op.start, "start");
        const count = op.count === undefined ? 1 : requireNumber(op.count, "count");
        sheet.spliceRows(start, 0, ...Array.from({ length: count }, () => []));
        changes.push(`${sheet.name} 在第 ${start} 行插入 ${count} 行`);
        break;
      }
      case "delete_rows": {
        const sheet = requireSheet(workbook, op.sheet);
        const start = requireNumber(op.start, "start");
        const count = op.count === undefined ? 1 : requireNumber(op.count, "count");
        sheet.spliceRows(start, count);
        changes.push(`${sheet.name} 删除第 ${start} 行起的 ${count} 行`);
        break;
      }
      case "add_sheet": {
        if (typeof op.name !== "string" || !op.name.trim()) throw new XlsxEditError("INVALID_OP", "name 必填");
        if (workbook.getWorksheet(op.name)) throw new XlsxEditError("INVALID_OP", `工作表「${op.name}」已存在`);
        workbook.addWorksheet(op.name.trim().slice(0, 31));
        changes.push(`新增工作表：${op.name}`);
        break;
      }
      case "rename_sheet": {
        if (typeof op.sheet !== "string" || !op.sheet.trim()) throw new XlsxEditError("INVALID_OP", "sheet 必填");
        if (typeof op.name !== "string" || !op.name.trim()) throw new XlsxEditError("INVALID_OP", "name 必填");
        const sheet = requireSheet(workbook, op.sheet);
        if (workbook.getWorksheet(op.name) && op.name !== sheet.name) {
          throw new XlsxEditError("INVALID_OP", `工作表「${op.name}」已存在`);
        }
        sheet.name = op.name.trim().slice(0, 31);
        changes.push(`工作表重命名：${op.sheet} → ${op.name}`);
        break;
      }
      case "delete_sheet": {
        if (typeof op.sheet !== "string" || !op.sheet.trim()) throw new XlsxEditError("INVALID_OP", "sheet 必填");
        if (workbook.worksheets.length <= 1) {
          throw new XlsxEditError("INVALID_OP", "工作簿至少要保留一个工作表");
        }
        const sheet = requireSheet(workbook, op.sheet);
        workbook.removeWorksheet(sheet.id);
        changes.push(`删除工作表：${op.sheet}`);
        break;
      }
      default:
        throw new XlsxEditError("INVALID_OP", `不支持的操作类型：${String(op.type)}`);
    }
  }

  const output = await workbook.xlsx.writeBuffer();
  return { buffer: Buffer.from(output), changes };
}

// ── 读取 ─────────────────────────────────────────────────────

export interface XlsxSheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
}

export interface XlsxReadResult {
  sheets: XlsxSheetSummary[];
  sheet?: {
    name: string;
    startAddress: string;
    rows: unknown[][];
    truncated: boolean;
  };
}

function normalizeCellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const record = value as unknown as Record<string, unknown>;
    if (typeof record.formula === "string" || typeof record.sharedFormula === "string") {
      return { formula: record.formula ?? record.sharedFormula, result: record.result ?? null };
    }
    if (Array.isArray(record.richText)) {
      return (record.richText as Array<{ text?: string }>).map((item) => item.text ?? "").join("");
    }
    if (typeof record.text === "string") return record.text;
    if (typeof record.error === "string") return record.error;
  }
  return String(value);
}

export interface XlsxReadOptions {
  sheet?: string;
  /** A1 或 A1:D20；缺省读取已用区域。 */
  range?: string;
  maxRows?: number;
  maxColumns?: number;
}

export async function readXlsx(buffer: Buffer, options: XlsxReadOptions = {}): Promise<XlsxReadResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new XlsxEditError("NOT_XLSX", "文件不是有效的 .xlsx（或已损坏/带密码）");
  }
  const sheets = workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheet.actualRowCount,
    columnCount: sheet.actualColumnCount,
  }));
  if (!options.sheet && !options.range) return { sheets };

  const sheet = requireSheet(workbook, options.sheet);
  const maxRows = Math.min(Math.max(options.maxRows ?? 200, 1), 5_000);
  const maxColumns = Math.min(Math.max(options.maxColumns ?? 50, 1), 200);
  let startRow = 1;
  let startColumn = 1;
  let endRow = Math.max(sheet.actualRowCount, 1);
  let endColumn = Math.max(sheet.actualColumnCount, 1);
  if (options.range) {
    const match = RANGE_PATTERN.exec(options.range.trim());
    if (!match) throw new XlsxEditError("INVALID_OP", `range 无效：${options.range}`);
    const start = parseAddress(match[1]!);
    startRow = start.row;
    startColumn = start.column;
    if (match[2]) {
      const end = parseAddress(match[2]);
      endRow = end.row;
      endColumn = end.column;
    } else {
      endRow = Math.max(startRow, Math.min(sheet.actualRowCount, startRow + maxRows - 1));
      endColumn = Math.max(startColumn, Math.min(sheet.actualColumnCount, startColumn + maxColumns - 1));
    }
  }
  const rowLimit = Math.min(endRow - startRow + 1, maxRows);
  const columnLimit = Math.min(endColumn - startColumn + 1, maxColumns);
  const rows: unknown[][] = [];
  for (let rowIndex = 0; rowIndex < rowLimit; rowIndex += 1) {
    const row: unknown[] = [];
    for (let columnIndex = 0; columnIndex < columnLimit; columnIndex += 1) {
      row.push(normalizeCellValue(sheet.getCell(startRow + rowIndex, startColumn + columnIndex).value));
    }
    rows.push(row);
  }
  return {
    sheets,
    sheet: {
      name: sheet.name,
      startAddress: sheet.getCell(startRow, startColumn).address,
      rows,
      truncated: rowLimit < endRow - startRow + 1 || columnLimit < endColumn - startColumn + 1,
    },
  };
}
