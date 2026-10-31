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

interface FakeApplyInput {
  kind: "docx" | "spreadsheet";
  fileId: string;
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  roomId?: string | null;
  workspaceId?: string | null;
}

interface FakeDescribeInput {
  kind: "docx" | "spreadsheet";
  fileId: string;
  roomId?: string | null;
  workspaceId?: string | null;
}

/** 工作簿上下文（sheets_agent_read 的 describe 返回的 context 是 JSON 文本）。 */
const SHEET_CONTEXT_OUTPUT = JSON.stringify({
  sheets: [
    { id: "sheet-1", name: "预算", range: "A1:F30" },
    { id: "sheet-2", name: "明细", range: "A1:D120" },
  ],
  selection: "B2:D8",
  nonEmptyCells: 214,
});

function bridgeHarness(): {
  bridge: OfficeBridgeClient;
  apply: ReturnType<typeof vi.fn>;
  describe: ReturnType<typeof vi.fn>;
} {
  const apply = vi.fn(async (input: FakeApplyInput) => ({
    ok: true,
    version: "fver-2",
    results: input.calls.map((call) => ({
      id: call.id,
      name: call.name,
      output: `${call.name} ok`,
      mutated: true,
    })),
  }));
  const describe = vi.fn(async (_input: FakeDescribeInput) => ({
    context: SHEET_CONTEXT_OUTPUT,
    tools: [{ name: "read_range" }, { name: "read_cells" }, { name: "propose_operations" }],
    guides: { writing: "propose_operations {operations, summary} …" },
  }));
  return {
    bridge: {
      applyAgentArtifactTools: apply,
      describeAgentArtifact: describe,
    } as unknown as OfficeBridgeClient,
    apply,
    describe,
  };
}

/** 文件访问面：catalogEntry 命中但 catalogContentOf 一旦被调用就失败（证明走元数据通道）。 */
function fileAccess(originalName = "智能家居预算.xlsx"): {
  access: OfficeFileAccess;
  catalogContentOf: ReturnType<typeof vi.fn>;
} {
  const catalogContentOf = vi.fn(async () => {
    throw new Error("sheets_agent_* 不应读取 xlsx 字节");
  });
  return {
    access: {
      catalogEntry: () => ({
        id: "fe-sheet",
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

function context(
  overrides: Partial<DocumentExecutionContext> = {},
  withActiveFile = true,
): DocumentExecutionContext {
  const base: DocumentExecutionContext = {
    agentSessionId: "session-1",
    runId: "run-1",
    roomId: "room-9",
    workspaceId: "ws-7",
    ...overrides,
  };
  return withActiveFile
    ? { ...base, activeFile: { fileId: "fe-sheet", title: "智能家居预算.xlsx", kind: "spreadsheet" } }
    : base;
}

function toolOf(plugin: ReturnType<typeof officePlugin>, name: string): DocumentCapabilityTool {
  const tool = plugin.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("sheets_agent_read：元数据级目标解析（headless 读取）", () => {
  it("不读 xlsx 字节，按 fileId 透传 Room/工作区并返回工作簿上下文", async () => {
    const { bridge, describe } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "sheets_agent_read").execute(
      { fileId: "fe-sheet" },
      context(),
    );

    // 元数据通道：不读 xlsx 字节（无 25MB 网关字节上限）。
    expect(catalogContentOf).not.toHaveBeenCalled();
    expect(describe).toHaveBeenCalledOnce();
    const payload = describe.mock.calls[0]![0] as FakeDescribeInput;
    expect(payload).toMatchObject({
      kind: "spreadsheet",
      fileId: "fe-sheet",
      roomId: "room-9",
      workspaceId: "ws-7",
    });
    expect(result.structuredContent).toMatchObject({
      fileId: "fe-sheet",
      context: SHEET_CONTEXT_OUTPUT,
    });
    expect(result.structuredContent.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "propose_operations" })]),
    );
    expect(result.structuredContent.hint).toContain("propose_operations");
  });

  it("未打开（无 activeFile）时显式 fileId 仍然可用——headless 读取的前提", async () => {
    const { bridge, describe } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "sheets_agent_read").execute(
      { fileId: "fe-sheet" },
      context({}, false),
    );
    expect(describe).toHaveBeenCalledOnce();
    expect(result.structuredContent.fileId).toBe("fe-sheet");
  });

  it("fileId 省略时用当前浏览的表格", async () => {
    const { bridge, describe } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await toolOf(plugin, "sheets_agent_read").execute({}, context());
    const payload = describe.mock.calls[0]![0] as FakeDescribeInput;
    expect(payload.fileId).toBe("fe-sheet");
  });

  it("非 .xlsx 目标报 INVALID_TARGET（不会把 Word 当表格打开）", async () => {
    const { bridge, describe } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess("智能家居行业调研报告.docx");
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "sheets_agent_read").execute({}, context())).rejects.toThrow(
      /INVALID_TARGET: sheets_agent_read 只支持 \.xlsx/,
    );
    expect(catalogContentOf).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });

  it("没有 activeFile 也没传 fileId 时给出可执行指引（指向 file_search）", async () => {
    const { bridge, describe } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "sheets_agent_read").execute({}, context({}, false))).rejects.toThrow(
      /NO_ACTIVE_FILE: .*file_search/,
    );
    expect(describe).not.toHaveBeenCalled();
  });

  it("bridge 失败带上文件名，便于模型如实说明", async () => {
    const { bridge, describe } = bridgeHarness();
    describe.mockRejectedValueOnce(new Error("sheet session crashed"));
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "sheets_agent_read").execute({}, context())).rejects.toThrow(
      /《智能家居预算\.xlsx》无法执行：sheet session crashed/,
    );
  });
});

describe("sheets_agent_edit：活工作簿工具调用（headless 编辑）", () => {
  it("元数据通道下发 calls，透传 Room/工作区、version 与逐条结果", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const calls = [
      { id: "c1", name: "read_range", input: { sheetId: "sheet-1", range: "A1:F5" } },
      {
        id: "c2",
        name: "propose_operations",
        input: { operations: [{ type: "setCell", sheetId: "sheet-1", cell: "B2", value: 42 }], summary: "改 B2" },
      },
    ];
    const result = await toolOf(plugin, "sheets_agent_edit").execute({ calls }, context());

    expect(catalogContentOf).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    const payload = apply.mock.calls[0]![0] as FakeApplyInput;
    expect(payload).toMatchObject({
      kind: "spreadsheet",
      fileId: "fe-sheet",
      roomId: "room-9",
      workspaceId: "ws-7",
      calls,
    });
    expect(result.structuredContent).toMatchObject({
      fileId: "fe-sheet",
      ok: true,
      version: "fver-2",
      nextAction: "report_result",
      hint: expect.stringContaining("修改已生效并保存"),
    });
    // 多调用结果按原顺序全部保留。
    expect(result.structuredContent.results).toEqual([
      { id: "c1", name: "read_range", output: "read_range ok", mutated: true },
      { id: "c2", name: "propose_operations", output: "propose_operations ok", mutated: true },
    ]);
  });

  it("未打开（无 activeFile）时显式 fileId 仍然可编辑——headless 编辑的前提", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "sheets_agent_edit").execute(
      { fileId: "fe-sheet", calls: [{ id: "c1", name: "read_range", input: { range: "A1:B2" } }] },
      context({}, false),
    );
    expect(apply).toHaveBeenCalledOnce();
    expect(result.structuredContent.fileId).toBe("fe-sheet");
  });

  it("逐条失败（isError）转成“只重试失败调用”的提示，成功条目仍透传", async () => {
    const { bridge, apply } = bridgeHarness();
    apply.mockResolvedValueOnce({
      ok: true,
      version: "fver-2",
      results: [
        { id: "c1", name: "read_range", output: "A1:B2", mutated: false },
        { id: "c2", name: "propose_operations", output: "sheetId not found", isError: true },
      ],
    });
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "sheets_agent_edit").execute({
      calls: [
        { id: "c1", name: "read_range", input: { range: "A1:B2" } },
        { id: "c2", name: "propose_operations", input: { operations: [], summary: "x" } },
      ],
    }, context());
    expect(result.structuredContent.hint).toContain("部分调用失败");
    expect(result.structuredContent.results).toHaveLength(2);
    expect((result.structuredContent.results as Array<{ isError?: boolean }>)[1]!.isError).toBe(true);
  });

  it("宿主级 error 原样透传（ok=false + error），不假装成功", async () => {
    const { bridge, apply } = bridgeHarness();
    apply.mockResolvedValueOnce({ ok: false, error: "workbook is open with unsaved edits" });
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "sheets_agent_edit").execute(
      { calls: [{ id: "c1", name: "read_range", input: { range: "A1:B2" } }] },
      context(),
    );
    expect(result.structuredContent).toMatchObject({
      fileId: "fe-sheet",
      ok: false,
      error: "workbook is open with unsaved edits",
    });
    expect(result.structuredContent.hint).toContain("修改已生效并保存");
  });

  it("calls 为空在网关侧直接拒绝，不打 bridge", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "sheets_agent_edit").execute({ calls: [] }, context())).rejects.toThrow(
      /INVALID_REQUEST: calls 必须是非空数组/,
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("非 .xlsx 目标报 INVALID_TARGET", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess("智能家居行业调研报告.docx");
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "sheets_agent_edit").execute(
      { calls: [{ id: "c1", name: "read_range", input: { range: "A1:B2" } }] },
      context(),
    )).rejects.toThrow(/INVALID_TARGET: sheets_agent_edit 只支持 \.xlsx/);
    expect(catalogContentOf).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("不支持 dry-run：calls 原样转发，网关不注入 dryRun", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const calls = [{
      id: "c1",
      name: "propose_operations",
      input: { operations: [{ type: "setCell", sheetId: "sheet-1", cell: "B2", value: 1 }], summary: "改 B2" },
    }];
    await toolOf(plugin, "sheets_agent_edit").execute({ fileId: "fe-sheet", calls }, context());
    const payload = apply.mock.calls[0]![0] as FakeApplyInput;
    expect(payload.calls).toEqual(calls);
    expect(JSON.stringify(payload)).not.toContain("dryRun");
  });
});

describe("sheets_agent_* 工具描述：headless 与写路径契约", () => {
  it("描述明确“不必打开/headless/版本自动更新”，并指向 file_search 与 propose_operations", () => {
    const { bridge } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const read = toolOf(plugin, "sheets_agent_read");
    const edit = toolOf(plugin, "sheets_agent_edit");

    expect(read.title).toContain("任意 Excel");
    expect(read.description).toContain("不需要文件在界面上打开");
    expect(read.description).toContain("headless");
    expect(read.description).toContain("file_search");

    expect(edit.title).toContain("任意 Excel");
    expect(edit.description).toContain("不需要文件在界面上打开");
    expect(edit.description).toContain("headless");
    expect(edit.description).toContain("自动保存并更新文件版本");
    expect(edit.description).toContain("propose_operations");
    expect(edit.description).toContain("唯一的写路径");
    expect(edit.description).toContain("不支持 dry-run");
    expect(edit.description).toContain("FILE_UNSAVED");
    // 不允许再要求“文件必须以可编辑方式打开”。
    expect(edit.description).not.toContain("文件必须以可编辑方式打开");
  });
});