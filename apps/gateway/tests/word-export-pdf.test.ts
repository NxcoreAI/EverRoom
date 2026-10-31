import { describe, expect, it, vi } from "vitest";

import {
  officePlugin,
  type OfficeFileAccess,
} from "../src/modules/documents/capabilities/office-plugin.js";
import type { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";
import type {
  DocumentCapabilityTool,
  DocumentExecutionContext,
} from "../src/modules/documents/capabilities/types.js";

interface FakeExportInput {
  fileId: string;
  fileName?: string | null;
  roomId?: string | null;
  workspaceId?: string | null;
}

function fileAccess(originalName = "智能家居行业调研报告.docx"): {
  access: OfficeFileAccess;
  catalogContentOf: ReturnType<typeof vi.fn>;
} {
  const catalogContentOf = vi.fn(async () => {
    throw new Error("word_export_pdf 不应读取 docx 字节（导出在桌面端完成）");
  });
  return {
    access: {
      catalogEntry: () => ({
        id: "fe-1",
        originalName,
        displayName: null,
        currentVersionId: "fver-1",
        contentHash: "a".repeat(64),
      }),
      catalogContentOf: catalogContentOf as unknown as OfficeFileAccess["catalogContentOf"],
    },
    catalogContentOf,
  };
}

function bridgeHarness(): {
  bridge: OfficeBridgeClient;
  exportPdf: ReturnType<typeof vi.fn>;
} {
  const exportPdf = vi.fn(async (_input: FakeExportInput) => ({
    ok: true,
    fileId: "fe-pdf",
    originalName: "智能家居行业调研报告.pdf",
    contentHash: "b".repeat(64),
  }));
  return { bridge: { exportPdf } as unknown as OfficeBridgeClient, exportPdf };
}

function context(activeFile = true): DocumentExecutionContext {
  const base: DocumentExecutionContext = {
    agentSessionId: "session-1",
    runId: "run-1",
    roomId: "room-9",
    workspaceId: "ws-7",
  };
  return activeFile
    ? { ...base, activeFile: { fileId: "fe-1", title: "智能家居行业调研报告.docx", kind: "docx" } }
    : base;
}

function toolOf(plugin: ReturnType<typeof officePlugin>, name: string): DocumentCapabilityTool {
  const tool = plugin.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("word_export_pdf", () => {
  it("调 bridge.exportPdf（元数据直达，不读 docx 字节）并返回新 PDF 的 fileId/文件名", async () => {
    const { bridge, exportPdf } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_export_pdf").execute({}, context());

    expect(catalogContentOf).not.toHaveBeenCalled();
    expect(exportPdf).toHaveBeenCalledOnce();
    expect(exportPdf.mock.calls[0]![0]).toEqual({
      fileId: "fe-1",
      roomId: "room-9",
      workspaceId: "ws-7",
    });
    expect(result.structuredContent).toMatchObject({
      fileId: "fe-pdf",
      sourceFileId: "fe-1",
      originalName: "智能家居行业调研报告.pdf",
      contentHash: "b".repeat(64),
      nextAction: "report_result",
    });
    expect(result.structuredContent.hint).toContain("不要重复导出");
  });

  it("fileName 透传；没有 activeFile 时显式 fileId 也能导出（headless）", async () => {
    const { bridge, exportPdf } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_export_pdf").execute(
      { fileId: "fe-1", fileName: "最终版.pdf" },
      context(false),
    );
    expect(exportPdf.mock.calls[0]![0]).toMatchObject({ fileId: "fe-1", fileName: "最终版.pdf" });
    expect(result.structuredContent.fileId).toBe("fe-pdf");
  });

  it("fileName 不是 .pdf 时在网关侧拒绝，不调 bridge", async () => {
    const { bridge, exportPdf } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "word_export_pdf").execute(
      { fileName: "最终版.docx" },
      context(),
    )).rejects.toThrow(/INVALID_REQUEST: fileName 必须以 \.pdf 结尾/);
    expect(exportPdf).not.toHaveBeenCalled();
  });

  it("非 docx 目标报 INVALID_TARGET", async () => {
    const { bridge, exportPdf } = bridgeHarness();
    const { access } = fileAccess("预算.xlsx");
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "word_export_pdf").execute({}, context()))
      .rejects.toThrow(/INVALID_TARGET: word_export_pdf 只支持 \.docx/);
    expect(exportPdf).not.toHaveBeenCalled();
  });

  it("桌面端导出失败时转成可读的 EXPORT_PDF_FAILED（含原始原因）", async () => {
    const { bridge, exportPdf } = bridgeHarness();
    exportPdf.mockRejectedValueOnce(new Error("LibreOffice 未安装，无法转换为 PDF"));
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "word_export_pdf").execute({}, context()))
      .rejects.toThrow(/EXPORT_PDF_FAILED: 《智能家居行业调研报告\.docx》导出 PDF 失败：LibreOffice 未安装/);
  });

  it("桌面端没有返回 PDF 文件条目时报错（不谎报成功）", async () => {
    const { bridge, exportPdf } = bridgeHarness();
    exportPdf.mockResolvedValueOnce({ ok: true, fileId: "", originalName: "" });
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "word_export_pdf").execute({}, context()))
      .rejects.toThrow(/EXPORT_PDF_FAILED: 桌面端未返回 PDF 文件条目/);
  });

  it("没有文件访问面时不暴露该工具", () => {
    const plugin = officePlugin({} as unknown as OfficeBridgeClient);
    expect(plugin.tools.map((tool) => tool.name)).not.toContain("word_export_pdf");
    expect(plugin.tools.map((tool) => tool.name)).not.toContain("word_compare");
  });
});