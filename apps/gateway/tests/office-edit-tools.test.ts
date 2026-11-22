import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { DocumentExecutionContext, DocumentCapabilityTool } from "../src/modules/documents/capabilities/types.js";
import { officePlugin, type OfficeFileAccess } from "../src/modules/documents/capabilities/office-plugin.js";
import type { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";
import { readDocxParagraphs } from "../src/modules/files/docx-edit.js";

const DOCX_FIXTURE = resolve("../../docs/Nexwing_BP_数据汇编_2025-04.docx");

function toolOf(plugin: ReturnType<typeof officePlugin>, name: string): DocumentCapabilityTool {
  const tool = plugin.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function sampleDocxFind(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  const texts = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .map((match) => [...match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((node) => node[1] ?? "").join(""))
    .filter((text) => text.length >= 12 && /^[\u4e00-\u9fa5A-Za-z0-9，。、“”（）()：:；;！!？?\s-]+$/u.test(text));
  const unique = texts.find((text) => texts.filter((candidate) => candidate.includes(text)).length === 1);
  if (!unique) throw new Error("fixture has no unique paragraph");
  return unique;
}

function fileAccess(buffer: Buffer, originalName: string, contentHash = "a".repeat(64)): OfficeFileAccess {
  return {
    catalogEntry: vi.fn(() => ({
      id: "file-target",
      originalName,
      displayName: null,
      currentVersionId: "fver-1",
      contentHash,
    })),
    catalogContentOf: vi.fn(async () => ({ buffer, mime: "application/octet-stream", filename: originalName })),
  };
}

function context(activeFile?: { fileId: string; title: string; kind: "docx" | "spreadsheet" | "slides" | "pdf" }): DocumentExecutionContext {
  return {
    agentSessionId: "session-1",
    runId: "run-1",
    roomId: null,
    ...(activeFile ? { activeFile } : {}),
  };
}

function fakeBridge(result: unknown = { ok: true, version: 4 }): OfficeBridgeClient {
  return { applyFileBytes: vi.fn(async () => result) } as unknown as OfficeBridgeClient;
}

describe("office_edit / sheets_edit 工具", () => {
  it("office_edit 按当前打开文件改 Word，并把新字节与基线指纹交给桌面端", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const find = await sampleDocxFind(buffer);
    const bridge = fakeBridge();
    const plugin = officePlugin(bridge, null, null, () => fileAccess(buffer, "合同.docx"));
    const result = await toolOf(plugin, "office_edit").execute(
      { ops: [{ type: "replace_text", find, replace: "Agent 改过的文字" }] },
      context({ fileId: "file-target", title: "合同.docx", kind: "docx" }),
    );

    const apply = bridge.applyFileBytes as unknown as ReturnType<typeof vi.fn>;
    expect(apply).toHaveBeenCalledOnce();
    const payload = apply.mock.calls[0]![0] as { fileId: string; bytesBase64: string; expectedContentHash: string };
    expect(payload.fileId).toBe("file-target");
    expect(payload.expectedContentHash).toBe("a".repeat(64));
    const bytes = Buffer.from(payload.bytesBase64, "base64");
    const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
    expect(xml).toContain("Agent 改过的文字");
    expect(result.structuredContent).toMatchObject({
      fileId: "file-target",
      applied: true,
      version: 4,
    });
  });

  it("office_read 返回段落纯文本，可直接作为 office_edit 的 find（不受 Markdown 标记干扰）", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const paragraphs = await readDocxParagraphs(buffer);
    const target = paragraphs.slice(0, 20).find((paragraph) =>
      paragraph.text.length >= 12
      && paragraphs.filter((candidate) => candidate.text.includes(paragraph.text)).length === 1);
    if (!target) throw new Error("fixture has no unique paragraph in first page");

    const bridge = fakeBridge();
    const plugin = officePlugin(bridge, null, null, () => fileAccess(buffer, "合同.docx"));
    const read = await toolOf(plugin, "office_read").execute(
      { maxParagraphs: 20 },
      context({ fileId: "file-target", title: "合同.docx", kind: "docx" }),
    );
    expect(read.structuredContent).toMatchObject({ fileId: "file-target", totalParagraphs: paragraphs.length });
    expect((read.structuredContent.paragraphs as Array<{ text: string }>).some((item) => item.text === target.text)).toBe(true);

    const edited = await toolOf(plugin, "office_edit").execute(
      { ops: [{ type: "replace_paragraph", find: target.text, text: "用 office_read 的原文定位成功" }] },
      context({ fileId: "file-target", title: "合同.docx", kind: "docx" }),
    );
    expect(edited.structuredContent).toMatchObject({ applied: true });
  });

  it("sheets_edit 改当前打开的表格；sheets_read 能读回结果", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("预算");
    sheet.getCell("A1").value = "项目";
    sheet.getCell("B1").value = 100;
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const bridge = fakeBridge({ ok: true, version: 9 });
    const access = fileAccess(buffer, "预算.xlsx");
    const plugin = officePlugin(bridge, null, null, () => access);

    await toolOf(plugin, "sheets_edit").execute(
      { ops: [{ type: "set_cells", sheet: "预算", cells: [{ address: "B1", value: 250 }] }] },
      context({ fileId: "file-target", title: "预算.xlsx", kind: "spreadsheet" }),
    );
    const sent = Buffer.from(
      (bridge.applyFileBytes as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].bytesBase64 as string,
      "base64",
    );
    const readWorkbook = new ExcelJS.Workbook();
    await readWorkbook.xlsx.load(sent as unknown as ArrayBuffer);
    expect(readWorkbook.getWorksheet("预算")!.getCell("B1").value).toBe(250);

    // 读工具走同一个文件访问面，不碰桌面端
    const read = await toolOf(plugin, "sheets_read").execute(
      { sheet: "预算", range: "A1:B1" },
      context({ fileId: "file-target", title: "预算.xlsx", kind: "spreadsheet" }),
    );
    expect(read.structuredContent).toMatchObject({
      fileId: "file-target",
      sheet: { name: "预算", rows: [["项目", 100]] },
    });
  });

  it("未保存修改被桌面端拒绝时，把“先保存”转成可执行错误", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const find = await sampleDocxFind(buffer);
    const plugin = officePlugin(fakeBridge({ ok: false, reason: "unsaved" }), null, null, () => fileAccess(buffer, "合同.docx"));
    await expect(toolOf(plugin, "office_edit").execute(
      { ops: [{ type: "replace_text", find, replace: "x" }] },
      context({ fileId: "file-target", title: "合同.docx", kind: "docx" }),
    )).rejects.toThrow(/FILE_UNSAVED: .*保存/);
  });

  it("文件没打开 / 没聚焦时给出明确指引", async () => {
    const buffer = await readFile(DOCX_FIXTURE);
    const plugin = officePlugin(fakeBridge({ ok: false, reason: "not_open" }), null, null, () => fileAccess(buffer, "合同.docx"));
    await expect(toolOf(plugin, "office_edit").execute(
      { ops: [{ type: "append_paragraph", text: "x" }] },
      context({ fileId: "file-target", title: "合同.docx", kind: "docx" }),
    )).rejects.toThrow(/FILE_NOT_OPEN/);

    await expect(toolOf(plugin, "office_edit").execute(
      { ops: [{ type: "append_paragraph", text: "x" }] },
      context(),
    )).rejects.toThrow(/NO_ACTIVE_FILE/);
  });

  it("格式/类型不匹配时指出该用哪个工具", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").getCell("A1").value = "x";
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const plugin = officePlugin(fakeBridge(), null, null, () => fileAccess(buffer, "表格.xlsx"));
    await expect(toolOf(plugin, "office_edit").execute(
      { ops: [{ type: "append_paragraph", text: "x" }] },
      context({ fileId: "file-target", title: "表格.xlsx", kind: "spreadsheet" }),
    )).rejects.toThrow(/sheets_edit/);
  });

  it("没有注入文件访问面时不暴露这三个工具", () => {
    const plugin = officePlugin(fakeBridge(), null, null);
    expect(plugin.tools.map((tool) => tool.name)).not.toContain("office_read");
    expect(plugin.tools.map((tool) => tool.name)).not.toContain("office_edit");
    expect(plugin.tools.map((tool) => tool.name)).not.toContain("sheets_edit");
    expect(plugin.tools.map((tool) => tool.name)).not.toContain("sheets_read");
  });
});
