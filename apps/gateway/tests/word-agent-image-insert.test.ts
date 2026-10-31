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
  workDir = await mkdtemp(join(tmpdir(), "word-agent-image-"));
  pngPath = join(workDir, "scene.png");
  await writeFile(pngPath, PNG_BYTES);
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

interface FakeAgentCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function fileAccess(originalName = "智能家居调研报告.docx"): OfficeFileAccess {
  return {
    catalogEntry: () => ({
      id: "fe-1",
      originalName,
      displayName: null,
      currentVersionId: "fver-1",
      contentHash: "a".repeat(64),
    }),
    catalogContentOf: async () => ({
      buffer: Buffer.from("fake-docx"),
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: originalName,
    }),
  };
}

function bridgeHarness(): {
  bridge: OfficeBridgeClient;
  apply: ReturnType<typeof vi.fn>;
} {
  const apply = vi.fn(async (input: { calls: FakeAgentCall[] }) => ({
    ok: true,
    results: input.calls.map((call) => ({
      id: call.id,
      name: call.name,
      output: `ran ${call.name}`,
      mutated: true,
    })),
  }));
  return {
    bridge: { applyAgentArtifactTools: apply } as unknown as OfficeBridgeClient,
    apply,
  };
}

function context(): DocumentExecutionContext {
  return {
    agentSessionId: "session-1",
    runId: "run-1",
    roomId: null,
    activeFile: { fileId: "fe-1", title: "智能家居调研报告.docx", kind: "docx" },
  };
}

function toolOf(plugin: ReturnType<typeof officePlugin>, name: string): DocumentCapabilityTool | undefined {
  return plugin.tools.find((tool) => tool.name === name);
}

describe("word_agent_edit：insert_image_base64 的 path 由网关解析成字节", () => {
  it("path 读盘 → base64 + 嗅探 mime，其余参数（afterIndex/maxWidthPx/label）原样下发", async () => {
    const { bridge, apply } = bridgeHarness();
    const plugin = officePlugin(bridge, null, null, () => fileAccess());
    const result = await toolOf(plugin, "word_agent_edit")!.execute({
      calls: [{
        id: "img-1",
        name: "insert_image_base64",
        input: { path: pngPath, afterIndex: 3, maxWidthPx: 900, label: "智能家居场景" },
      }],
    }, context());

    expect(apply).toHaveBeenCalledTimes(1);
    const forwarded = (apply.mock.calls[0]![0] as { calls: FakeAgentCall[] }).calls;
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.input).toEqual({
      base64: PNG_BASE64,
      mime: "image/png",
      afterIndex: 3,
      maxWidthPx: 900,
      label: "智能家居场景",
    });
    expect(forwarded[0]!.input).not.toHaveProperty("path");
    expect(result.structuredContent).toMatchObject({ fileId: "fe-1", ok: true });
    expect((result.structuredContent.results as Array<{ isError?: boolean }>)[0]!.isError).toBeUndefined();
  });

  it("path 解析失败只影响该条调用：同批其它调用照常执行，结果顺序与请求一致", async () => {
    const { bridge, apply } = bridgeHarness();
    const plugin = officePlugin(bridge, null, null, () => fileAccess());
    const result = await toolOf(plugin, "word_agent_edit")!.execute({
      calls: [
        { id: "read-1", name: "read_blocks", input: { start: 0, end: 2 } },
        { id: "img-1", name: "insert_image_base64", input: { path: join(workDir, "missing.png") } },
        { id: "ins-1", name: "insert_content", input: { afterIndex: 1, html: "<p>hi</p>" } },
      ],
    }, context());

    expect(apply).toHaveBeenCalledTimes(1);
    const forwarded = (apply.mock.calls[0]![0] as { calls: FakeAgentCall[] }).calls;
    expect(forwarded.map((call) => call.id)).toEqual(["read-1", "ins-1"]);
    const rows = result.structuredContent.results as Array<{ id: string; output?: string; isError?: boolean }>;
    expect(rows.map((row) => row.id)).toEqual(["read-1", "img-1", "ins-1"]);
    expect(rows[1]!.isError).toBe(true);
    expect(rows[1]!.output).toMatch(/找不到图片文件/);
    expect(result.structuredContent.hint).toMatch(/部分调用失败/);
  });

  it("三者都没给时报 INVALID_REQUEST（提示 path/url/base64）", async () => {
    const { bridge, apply } = bridgeHarness();
    const plugin = officePlugin(bridge, null, null, () => fileAccess());
    const result = await toolOf(plugin, "word_agent_edit")!.execute({
      calls: [{ id: "img-1", name: "insert_image_base64", input: {} }],
    }, context());
    expect(apply).not.toHaveBeenCalled();
    const rows = result.structuredContent.results as Array<{ output?: string; isError?: boolean }>;
    expect(rows[0]!.isError).toBe(true);
    expect(rows[0]!.output).toMatch(/path|url|base64/);
  });
});

describe("word_agent_illustration：宿主生图后一步插入", () => {
  function illustrationPorts(overrides: Partial<DocumentIllustrationPorts> = {}): DocumentIllustrationPorts {
    return {
      generate: vi.fn(async () => ({ contentHash: "b".repeat(64) })),
      read: vi.fn(async () => ({ buffer: PNG_BYTES, mime: "image/png" })),
      ...overrides,
    };
  }

  it("未注入生图端口时不暴露工具", () => {
    const { bridge } = bridgeHarness();
    const plugin = officePlugin(bridge, null, null, () => fileAccess());
    expect(toolOf(plugin, "word_agent_illustration")).toBeUndefined();
  });

  it("生成 + 读回字节 + 下发 insert_image_base64（afterIndex/maxWidthPx 生效）", async () => {
    const { bridge, apply } = bridgeHarness();
    const ports = illustrationPorts();
    const plugin = officePlugin(bridge, null, null, () => fileAccess(), ports);
    const tool = toolOf(plugin, "word_agent_illustration");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { prompt: "智能家居全屋场景", afterIndex: 5, maxWidthPx: 520, label: "场景示意图" },
      context(),
    );

    expect(ports.generate).toHaveBeenCalledTimes(1);
    expect((ports.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain("智能家居全屋场景");
    expect(ports.read).toHaveBeenCalledWith("b".repeat(64));
    expect(apply).toHaveBeenCalledTimes(1);
    const call = (apply.mock.calls[0]![0] as { calls: FakeAgentCall[] }).calls[0]!;
    expect(call.name).toBe("insert_image_base64");
    expect(call.input).toEqual({
      base64: PNG_BASE64,
      mime: "image/png",
      afterIndex: 5,
      maxWidthPx: 520,
      label: "场景示意图",
    });
    expect(result.structuredContent).toMatchObject({
      fileId: "fe-1",
      contentHash: "b".repeat(64),
      applied: true,
    });
  });

  it("生图不可用时报 ILLUSTRATION_UNAVAILABLE 并指路 path 兜底", async () => {
    const { bridge } = bridgeHarness();
    const ports = illustrationPorts({
      generate: vi.fn(async () => {
        throw new Error("生图中转会话不可用：需要已订阅账号且网关在线");
      }),
    });
    const plugin = officePlugin(bridge, null, null, () => fileAccess(), ports);
    const tool = toolOf(plugin, "word_agent_illustration");
    await expect(tool!.execute({ prompt: "场景" }, context())).rejects.toThrow(/ILLUSTRATION_UNAVAILABLE/);
    await expect(tool!.execute({ prompt: "场景" }, context())).rejects.toThrow(/insert_image_base64 \{path\}/);
  });

  it("渲染层插入失败时透出 INSERT_IMAGE_FAILED", async () => {
    const apply = vi.fn(async () => ({
      ok: true,
      results: [{ id: "illustration-1", name: "insert_image_base64", output: "afterIndex out of range", isError: true }],
    }));
    const bridge = { applyAgentArtifactTools: apply } as unknown as OfficeBridgeClient;
    const plugin = officePlugin(bridge, null, null, () => fileAccess(), illustrationPorts());
    const tool = toolOf(plugin, "word_agent_illustration");
    await expect(tool!.execute({ prompt: "场景" }, context())).rejects.toThrow(/INSERT_IMAGE_FAILED/);
  });

  it("prompt 为空时报 INVALID_REQUEST", async () => {
    const { bridge } = bridgeHarness();
    const plugin = officePlugin(bridge, null, null, () => fileAccess(), illustrationPorts());
    const tool = toolOf(plugin, "word_agent_illustration");
    await expect(tool!.execute({ prompt: "   " }, context())).rejects.toThrow(/prompt 不能为空/);
  });
});