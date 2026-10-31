import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  officePlugin,
  type DocumentIllustrationPorts,
  type OfficeFileAccess,
} from "../src/modules/documents/capabilities/office-plugin.js";
import type { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";
import type {
  DocumentCapabilityTool,
  DocumentExecutionContext,
} from "../src/modules/documents/capabilities/types.js";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fixture-png-body"),
]);
const PNG_BASE64 = PNG_BYTES.toString("base64");

let workDir = "";
let pngPath = "";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "word-agent-ops-"));
  pngPath = join(workDir, "scene.png");
  await writeFile(pngPath, PNG_BYTES);
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

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

const OPS_OUTPUT = JSON.stringify({
  results: [
    { index: 0, op: "table.insertRow", ok: true },
    { index: 1, op: "table.setCell", ok: true },
  ],
  saved: true,
});

function bridgeHarness(): {
  bridge: OfficeBridgeClient;
  apply: ReturnType<typeof vi.fn>;
  describe: ReturnType<typeof vi.fn>;
} {
  const apply = vi.fn(async (input: FakeApplyInput) => ({
    ok: true,
    results: input.calls.map((call) => ({
      id: call.id,
      name: call.name,
      output: OPS_OUTPUT,
      mutated: true,
    })),
  }));
  const describe = vi.fn(async (_input: FakeDescribeInput) => ({
    context: "doc-context",
    tools: [],
    guides: {},
    operationsGuide: "table.insertRow {blockIndex, afterRow} …",
    documentState: { tables: 1, sections: 2, comments: 0, fields: 0, sources: 0, revisions: 0 },
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
function fileAccess(originalName = "智能家居行业调研报告.docx"): {
  access: OfficeFileAccess;
  catalogContentOf: ReturnType<typeof vi.fn>;
} {
  const catalogContentOf = vi.fn(async () => {
    throw new Error("word_agent_* 不应读取 docx 字节");
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

function illustrationPorts(): DocumentIllustrationPorts {
  return {
    generate: vi.fn(async () => ({ contentHash: "b".repeat(64) })),
    read: vi.fn(async () => ({ buffer: PNG_BYTES, mime: "image/png" })),
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
    ? { ...base, activeFile: { fileId: "fe-1", title: "智能家居行业调研报告.docx", kind: "docx" } }
    : base;
}

function toolOf(plugin: ReturnType<typeof officePlugin>, name: string): DocumentCapabilityTool {
  const tool = plugin.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("word_agent_ops：结构化操作通道", () => {
  it("把 ops 作为单条 apply_operations 下发，并透传 Room/工作区与逐条结果", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const ops = [
      { op: "table.insertRow", blockIndex: 4, afterRow: 1, cells: ["涂鸦智能", "IoT 模组"] },
      { op: "table.setCell", blockIndex: 4, row: 2, col: 3, text: "高" },
    ];
    const result = await toolOf(plugin, "word_agent_ops").execute({ ops }, context());

    // 元数据通道：不读 docx 字节。
    expect(catalogContentOf).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    const payload = apply.mock.calls[0]![0] as FakeApplyInput;
    expect(payload.kind).toBe("docx");
    expect(payload.fileId).toBe("fe-1");
    expect(payload.roomId).toBe("room-9");
    expect(payload.workspaceId).toBe("ws-7");
    // 一次 bridge 调用 = 一个 apply_operations 工具调用。
    expect(payload.calls).toEqual([{ id: "ops-1", name: "apply_operations", input: { ops } }]);

    expect(result.structuredContent).toMatchObject({
      fileId: "fe-1",
      ok: true,
      mutated: true,
      nextAction: "report_result",
    });
    // output 是 JSON 时额外给出结构化 result，模型不用自己解析字符串。
    expect(result.structuredContent.output).toBe(OPS_OUTPUT);
    expect(result.structuredContent.result).toEqual(JSON.parse(OPS_OUTPUT));
    expect(result.structuredContent).not.toHaveProperty("error");
  });

  it("dryRun=true 原样下发给渲染层（只校验不落盘），返回值标注 dryRun", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_agent_ops").execute(
      { ops: [{ op: "table.autoFit", blockIndex: 4 }], dryRun: true },
      context(),
    );
    const input = (apply.mock.calls[0]![0] as FakeApplyInput).calls[0]!.input;
    expect(input.dryRun).toBe(true);
    expect(result.structuredContent).toMatchObject({ dryRun: true, ok: true, nextAction: "report_result" });
  });

  it("per-op 失败（isError）转成 fix_and_retry，并保留 output 里的逐条原因", async () => {
    const { bridge, apply } = bridgeHarness();
    apply.mockResolvedValueOnce({
      ok: true,
      results: [{
        id: "ops-1",
        name: "apply_operations",
        output: "op[1] table.splitCell failed: cell is not merged",
        isError: true,
      }],
    });
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_agent_ops").execute(
      { ops: [{ op: "table.splitCell", blockIndex: 4 }] },
      context(),
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      nextAction: "fix_and_retry",
      error: "op[1] table.splitCell failed: cell is not merged",
    });
    expect(result.structuredContent.hint).toMatch(/只重试失败的操作/);
  });

  it("宿主级 error 且没有结果行时也算失败", async () => {
    const { bridge, apply } = bridgeHarness();
    apply.mockResolvedValueOnce({ ok: false, error: "editor session crashed" });
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_agent_ops").execute(
      { ops: [{ op: "table.autoFit", blockIndex: 4 }] },
      context(),
    );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      nextAction: "fix_and_retry",
      error: "editor session crashed",
    });
  });

  it("ops 为空 / 超过 50 条 / 不是对象时在网关侧直接拒绝，不打 bridge", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const tool = toolOf(plugin, "word_agent_ops");

    await expect(tool.execute({ ops: [] }, context())).rejects.toThrow(/INVALID_REQUEST: ops 必须是非空数组/);
    await expect(tool.execute({ ops: "table.autoFit" }, context())).rejects.toThrow(/INVALID_REQUEST: ops 必须是非空数组/);
    await expect(tool.execute(
      { ops: Array.from({ length: 51 }, () => ({ op: "table.autoFit" })) },
      context(),
    )).rejects.toThrow(/最多 50 条/);
    await expect(tool.execute(
      { ops: [{ op: "table.autoFit" }, "nope"] },
      context(),
    )).rejects.toThrow(/ops\[1\] 不是操作对象/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("非 .docx 目标报 INVALID_TARGET（不会把 Excel 当 Word 打开）", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess("预算.xlsx");
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "word_agent_ops").execute(
      { ops: [{ op: "table.autoFit", blockIndex: 1 }] },
      context(),
    )).rejects.toThrow(/INVALID_TARGET: word_agent_ops 只支持 \.docx/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("没有 activeFile 也没传 fileId 时给出可执行指引（指向 file_search）", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await expect(toolOf(plugin, "word_agent_ops").execute(
      { ops: [{ op: "table.autoFit" }] },
      context({}, false),
    )).rejects.toThrow(/NO_ACTIVE_FILE: .*file_search/);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("word_agent_read / word_agent_edit / word_agent_illustration：元数据目标解析", () => {
  it("word_agent_read 不读字节，透传 Room/工作区并返回 operationsGuide/documentState", async () => {
    const { bridge, describe } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_agent_read").execute({}, context());

    expect(catalogContentOf).not.toHaveBeenCalled();
    const payload = describe.mock.calls[0]![0] as FakeDescribeInput;
    expect(payload).toMatchObject({ kind: "docx", fileId: "fe-1", roomId: "room-9", workspaceId: "ws-7" });
    expect(result.structuredContent).toMatchObject({
      fileId: "fe-1",
      operationsGuide: "table.insertRow {blockIndex, afterRow} …",
    });
    expect(result.structuredContent.documentState).toEqual(
      expect.objectContaining({ tables: 1, sections: 2 }),
    );
    expect(result.structuredContent.hint).toContain("word_agent_ops");
  });

  it("word_agent_edit 不读字节，把 Room/工作区随工具调用一起下发", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_agent_edit").execute({
      calls: [{ id: "c1", name: "insert_content", input: { afterIndex: 1, html: "<p>hi</p>" } }],
    }, context());

    expect(catalogContentOf).not.toHaveBeenCalled();
    const payload = apply.mock.calls[0]![0] as FakeApplyInput;
    expect(payload).toMatchObject({ kind: "docx", fileId: "fe-1", roomId: "room-9", workspaceId: "ws-7" });
    expect(result.structuredContent).toMatchObject({ fileId: "fe-1", nextAction: "report_result" });
  });

  it("word_agent_illustration 同样只走元数据（生图字节经 bridge 下发，不读 docx）", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access, catalogContentOf } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access, illustrationPorts());
    const result = await toolOf(plugin, "word_agent_illustration").execute(
      { prompt: "smart home scene", afterIndex: 3 },
      context(),
    );

    expect(catalogContentOf).not.toHaveBeenCalled();
    const payload = apply.mock.calls[0]![0] as FakeApplyInput;
    expect(payload).toMatchObject({ kind: "docx", fileId: "fe-1", roomId: "room-9", workspaceId: "ws-7" });
    expect(payload.calls[0]!.name).toBe("insert_image_base64");
    expect(result.structuredContent).toMatchObject({ fileId: "fe-1", applied: true });
  });

  it("未打开（无 activeFile）时显式 fileId 仍然可用——headless 编辑的前提", async () => {
    const { bridge, describe } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_agent_read").execute(
      { fileId: "fe-1" },
      context({}, false),
    );
    expect(describe).toHaveBeenCalledOnce();
    expect(result.structuredContent.fileId).toBe("fe-1");
  });
});

describe("word_agent_ops：object.image.replace 的图片来源由网关解析", () => {
  it("path 读盘 → 下发的 op 带 base64/mime 且不再有 path", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const ops = [
      { op: "object.image.replace", blockIndex: 7, path: pngPath, label: "场景图" },
    ];
    const result = await toolOf(plugin, "word_agent_ops").execute({ ops }, context());

    expect(apply).toHaveBeenCalledOnce();
    const forwardedOps = (apply.mock.calls[0]![0] as FakeApplyInput).calls[0]!.input.ops as Array<Record<string, unknown>>;
    expect(forwardedOps).toHaveLength(1);
    expect(forwardedOps[0]).toEqual({
      op: "object.image.replace",
      blockIndex: 7,
      label: "场景图",
      base64: PNG_BASE64,
      mime: "image/png",
    });
    expect(forwardedOps[0]).not.toHaveProperty("path");
    expect(result.structuredContent).toMatchObject({ ok: true, nextAction: "report_result" });
  });

  it("同批其它 op 原样转发；非图片 op 不会被改写成 base64", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await toolOf(plugin, "word_agent_ops").execute({
      ops: [
        { op: "table.autoFit", blockIndex: 3 },
        { op: "object.image.replace", blockIndex: 5, path: pngPath },
        { op: "object.image.crop", blockIndex: 5, rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
      ],
    }, context());
    const forwardedOps = (apply.mock.calls[0]![0] as FakeApplyInput).calls[0]!.input.ops as Array<Record<string, unknown>>;
    expect(forwardedOps[0]).toEqual({ op: "table.autoFit", blockIndex: 3 });
    expect(forwardedOps[1]).toMatchObject({ op: "object.image.replace", base64: PNG_BASE64, mime: "image/png" });
    expect(forwardedOps[2]).toEqual({
      op: "object.image.crop",
      blockIndex: 5,
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
    });
  });

  it("图片来源解析失败：整批不下发，返回 per-call 失败结果（fix_and_retry）", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    const result = await toolOf(plugin, "word_agent_ops").execute({
      ops: [
        { op: "table.autoFit", blockIndex: 3 },
        { op: "object.image.replace", blockIndex: 5, path: join(workDir, "missing.png") },
      ],
    }, context());

    expect(apply).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      ok: false,
      isError: true,
      nextAction: "fix_and_retry",
    });
    expect(result.structuredContent.output).toMatch(/ops\[1\] object\.image\.replace 的图片来源无法解析/);
    expect(result.structuredContent.error).toContain("找不到图片文件");
    // 未解析的 path 不会被转发给桌面端。
    expect(result.structuredContent).not.toHaveProperty("result");
  });

  it("headerFooter.insertImage 的 path 也由网关解析成 base64/mime", async () => {
    const { bridge, apply } = bridgeHarness();
    const { access } = fileAccess();
    const plugin = officePlugin(bridge, null, null, () => access);
    await toolOf(plugin, "word_agent_ops").execute({
      ops: [
        { op: "headerFooter.insertImage", kind: "header", path: pngPath, align: "right", widthPx: 120 },
      ],
    }, context());
    const forwardedOps = (apply.mock.calls[0]![0] as FakeApplyInput).calls[0]!.input.ops as Array<Record<string, unknown>>;
    expect(forwardedOps[0]).toEqual({
      op: "headerFooter.insertImage",
      kind: "header",
      align: "right",
      widthPx: 120,
      base64: PNG_BASE64,
      mime: "image/png",
    });
    expect(forwardedOps[0]).not.toHaveProperty("path");
  });
});
