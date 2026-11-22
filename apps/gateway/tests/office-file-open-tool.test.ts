/**
 * file_open：把资料库/产物里的文件在界面打开给用户看。
 *
 * 补的能力缺口：此前 Agent 只有读/改/生成工具，用户说「打开那份文档」时
 * 没有任何工具能把文件呈现出来，只能回答“没有这个能力”。
 */
import { describe, expect, it, vi } from "vitest";
import type { DocumentCapabilityTool, DocumentExecutionContext } from "../src/modules/documents/capabilities/types.js";
import { officePlugin, type OfficeFileAccess } from "../src/modules/documents/capabilities/office-plugin.js";
import type { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";

function toolOf(plugin: ReturnType<typeof officePlugin>, name: string): DocumentCapabilityTool {
  const tool = plugin.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function context(roomId: string | null = null): DocumentExecutionContext {
  return {
    agentSessionId: "session-1",
    runId: "run-1",
    roomId,
  };
}

function fakeBridge(openFile: OfficeBridgeClient["openFile"]): OfficeBridgeClient {
  return { openFile } as unknown as OfficeBridgeClient;
}

function fileAccess(originalName: string): OfficeFileAccess {
  return {
    catalogEntry: vi.fn(() => ({
      id: "file-target",
      originalName,
      displayName: null,
      currentVersionId: "fver-1",
      contentHash: "a".repeat(64),
    })),
    catalogContentOf: vi.fn(async () => ({ buffer: Buffer.from(""), mime: "application/octet-stream", filename: originalName })),
  };
}

describe("file_open 工具", () => {
  it("暴露在工具面里，且是只读操作（不改文件内容）", () => {
    const plugin = officePlugin(fakeBridge(vi.fn()), null, null, () => fileAccess("合同.docx"));
    const tool = toolOf(plugin, "file_open");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.inputSchema).toMatchObject({ required: ["fileId"], additionalProperties: false });
  });

  it("按 fileId 打开文件：透传 editable/roomId 并带条目标题给回复用", async () => {
    const openFile = vi.fn(async () => ({
      ok: true as const,
      openedWith: "office" as const,
      fileId: "file-target",
      originalName: "合同.docx",
      kind: "docx",
    }));
    const plugin = officePlugin(fakeBridge(openFile), null, null, () => fileAccess("合同.docx"));

    const result = await toolOf(plugin, "file_open").execute(
      { fileId: "file-target", editable: true },
      context("ws-7"),
    );

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith({
      fileId: "file-target",
      editable: true,
      roomId: "ws-7",
    });
    expect(result.structuredContent).toMatchObject({
      fileId: "file-target",
      title: "合同.docx",
      openedWith: "office",
      originalName: "合同.docx",
      editable: true,
    });
    expect(JSON.stringify(result.structuredContent.hint)).toContain("已在应用内打开");
  });

  it("缺 fileId → 直接拒绝，并指引先用 file_search 定位", async () => {
    const openFile = vi.fn(async () => ({
      ok: true as const,
      openedWith: "external" as const,
      fileId: "file-target",
      originalName: "x.zip",
    }));
    const plugin = officePlugin(fakeBridge(openFile), null, null, () => fileAccess("x.zip"));
    await expect(toolOf(plugin, "file_open").execute({}, context()))
      .rejects.toThrow(/fileId 不能为空.*file_search/u);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("桌面端报 not_found → 转成 FILE_NOT_FOUND（模型知道该换个名字搜）", async () => {
    const openFile = vi.fn(async () => {
      const error = new Error("文件不在文件库中") as Error & { code?: string };
      error.code = "not_found";
      throw error;
    });
    const plugin = officePlugin(fakeBridge(openFile), null, null, () => fileAccess("合同.docx"));
    await expect(toolOf(plugin, "file_open").execute({ fileId: "file-404" }, context()))
      .rejects.toThrow(/FILE_NOT_FOUND/u);
  });

  it("其他打开失败 → FILE_OPEN_FAILED 带上文件名与原错误", async () => {
    const openFile = vi.fn(async () => {
      throw new Error("预览实例创建失败");
    });
    const plugin = officePlugin(fakeBridge(openFile), null, null, () => fileAccess("合同.docx"));
    await expect(toolOf(plugin, "file_open").execute({ fileId: "file-target" }, context()))
      .rejects.toThrow(/FILE_OPEN_FAILED: 《合同.docx》打开失败：预览实例创建失败/u);
  });

  it("条目查不到时不阻断打开（仍交给桌面端按 fileId 核实）", async () => {
    const openFile = vi.fn(async () => ({
      ok: true as const,
      openedWith: "office" as const,
      fileId: "file-legacy",
      originalName: "老文件.pptx",
    }));
    const access: OfficeFileAccess = {
      catalogEntry: vi.fn(() => null),
      catalogContentOf: vi.fn(async () => null),
    };
    const plugin = officePlugin(fakeBridge(openFile), null, null, () => access);

    const result = await toolOf(plugin, "file_open").execute({ fileId: "file-legacy" }, context());
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ fileId: "file-legacy" }));
    expect(result.structuredContent).toMatchObject({ openedWith: "office", originalName: "老文件.pptx" });
  });
});
