import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { IngestError } from "./errors.js";
import {
  docToText,
  legacySlidesToMarkdown,
  legacySpreadsheetToMarkdown,
  legacyWordToMarkdown,
  odfToMarkdown,
  pptToText,
  readCompoundFile,
  rtfToText,
  xlsToText,
} from "./legacy-office.js";

const fixture = (name: string): Promise<Buffer> =>
  readFile(new URL(`./tests/fixtures/${name}`, import.meta.url));

/**
 * 旧版 Office 文本抽取回归：这些断言同时是「入库不再调 LibreOffice」的行为基线
 * —— 抽取只读文件字节，不依赖本机安装 soffice。
 */
describe("legacy office text extraction", () => {
  it("reads Word 97 piece-table text from .doc", async () => {
    const text = docToText(await fixture("legacy-sample.doc"), "legacy-sample.doc");
    expect(text).toContain("Legacy Report");
    expect(text).toContain("Legacy DOC body text");
    expect(text).toContain("Second paragraph from Word 97-2003.");
  });

  it("reads per-slide text from .ppt and skips master placeholders", async () => {
    const text = pptToText(await fixture("legacy-sample.ppt"), "legacy-sample.ppt");
    expect(text).toContain("## 第 1 页：Legacy PPT title");
    expect(text).toContain("- First slide body");
    expect(text).toContain("## 第 2 页：Second legacy slide");
    expect(text).not.toContain("Click to edit");
  });

  it("reads shared strings and cell values from .xls as a GFM table", async () => {
    const text = xlsToText(await fixture("legacy-sample.xls"), "legacy-sample.xls");
    expect(text).toContain("## sample");
    expect(text).toContain("| name | qty | price |");
    expect(text).toContain("| apple | 3 | 1.5 |");
    expect(text).toContain("| banana | 12 | 0.25 |");
  });

  it("strips RTF control words and keeps unicode", async () => {
    const text = rtfToText(await fixture("legacy-sample.rtf"), "legacy-sample.rtf");
    expect(text).toContain("Legacy RTF title");
    expect(text).toContain("中文");
  });

  it("reads ODF spreadsheet cells from .ods", async () => {
    const text = await odfToMarkdown(await fixture("legacy-sample.ods"), "spreadsheet", "legacy-sample.ods");
    expect(text).toContain("| name | qty | price |");
    expect(text).toContain("| apple | 3 | 1.5 |");
  });

  it("routes every legacy extension through the in-process extractors", async () => {
    const doc = await fixture("legacy-sample.doc");
    const ppt = await fixture("legacy-sample.ppt");
    const xls = await fixture("legacy-sample.xls");
    const rtf = await fixture("legacy-sample.rtf");
    const ods = await fixture("legacy-sample.ods");

    await expect(legacyWordToMarkdown(doc, "legacy-sample.doc")).resolves.toContain("Legacy DOC body text");
    await expect(legacyWordToMarkdown(rtf, "legacy-sample.rtf")).resolves.toContain("Legacy RTF title");
    await expect(legacySlidesToMarkdown(ppt, "legacy-sample.ppt")).resolves.toContain("Second legacy slide");
    await expect(legacySpreadsheetToMarkdown(xls, "legacy-sample.xls")).resolves.toContain("| banana | 12 | 0.25 |");
    await expect(legacySpreadsheetToMarkdown(ods, "legacy-sample.ods")).resolves.toContain("| apple | 3 | 1.5 |");
  });

  it("rejects non-CFB payloads with a typed ingest error instead of spawning a converter", async () => {
    await expect(legacyWordToMarkdown(Buffer.from("not a doc"), "fake.doc")).rejects.toBeInstanceOf(IngestError);
    await expect(legacySlidesToMarkdown(Buffer.from("not a ppt"), "fake.ppt")).rejects.toBeInstanceOf(IngestError);
    await expect(legacySpreadsheetToMarkdown(Buffer.from("not a xls"), "fake.xls")).rejects.toBeInstanceOf(IngestError);
    expect(() => readCompoundFile(Buffer.from("not a cfb"))).toThrow();
  });

  it("reports .xlsb honestly now that LibreOffice is no longer a fallback", async () => {
    await expect(legacySpreadsheetToMarkdown(Buffer.from("PK"), "book.xlsb")).rejects.toThrow(/xlsb/);
  });
});
