import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  compareParagraphs,
  summarizeParagraphCompare,
} from "../src/modules/files/paragraph-compare.js";
import {
  officePlugin,
  type OfficeFileAccess,
} from "../src/modules/documents/capabilities/office-plugin.js";
import type { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";
import type {
  DocumentCapabilityTool,
  DocumentExecutionContext,
} from "../src/modules/documents/capabilities/types.js";

/** 最小合法 docx：readDocxParagraphs 只读 word/document.xml。 */
async function docxBuffer(paragraphs: string[]): Promise<Buffer> {
  const escapeXml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`).join("")
    + "<w:sectPr/></w:body></w:document>",
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

interface FakeFile {
  buffer: Buffer;
  originalName: string;
}

function fileAccessFor(
  files: Record<string, FakeFile>,
  options: { contentOf?: (id: string) => Promise<{ buffer: Buffer; mime: string; filename: string } | null> } = {},
): OfficeFileAccess {
  return {
    catalogEntry: (id) => {
      const file = files[id];
      if (!file) return null;
      return {
        id,
        originalName: file.originalName,
        displayName: null,
        currentVersionId: "fver-1",
        contentHash: "a".repeat(64),
      };
    },
    catalogContentOf: options.contentOf ?? (async (id) => {
      const file = files[id];
      if (!file) return null;
      return { buffer: file.buffer, mime: "application/octet-stream", filename: file.originalName };
    }),
  };
}

function context(activeFileId?: string): DocumentExecutionContext {
  return {
    agentSessionId: "session-1",
    runId: "run-1",
    roomId: "room-9",
    workspaceId: "ws-7",
    ...(activeFileId
      ? { activeFile: { fileId: activeFileId, title: "基准.docx", kind: "docx" } }
      : {}),
  };
}

function toolOf(plugin: ReturnType<typeof officePlugin>, name: string): DocumentCapabilityTool {
  const tool = plugin.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

const fakeBridge = {} as unknown as OfficeBridgeClient;

describe("compareParagraphs（与 UI 的审阅→比较同语义）", () => {
  it("完全一致时全部 same", () => {
    const entries = compareParagraphs(["a", "b"], ["a", "b"]);
    expect(entries.every((entry) => entry.kind === "same")).toBe(true);
    expect(summarizeParagraphCompare(entries)).toEqual({ same: 2, changed: 0, added: 0, removed: 0, total: 2 });
  });

  it("新增一段", () => {
    const entries = compareParagraphs(["a", "c"], ["a", "b", "c"]);
    expect(entries.map((entry) => entry.kind)).toEqual(["same", "added", "same"]);
    expect(entries[1]!.right).toBe("b");
  });

  it("删除一段", () => {
    const entries = compareParagraphs(["a", "b", "c"], ["a", "c"]);
    expect(entries.map((entry) => entry.kind)).toEqual(["same", "removed", "same"]);
    expect(entries[1]!.left).toBe("b");
  });

  it("相邻的删除+新增合并成 changed（左旧右新）", () => {
    const entries = compareParagraphs(["标题", "旧内容", "结尾"], ["标题", "新内容", "结尾"]);
    expect(entries.map((entry) => entry.kind)).toEqual(["same", "changed", "same"]);
    expect(entries[1]).toMatchObject({ left: "旧内容", right: "新内容" });
  });

  it("空文档边界", () => {
    expect(compareParagraphs([], [])).toEqual([]);
    expect(compareParagraphs([], ["x"])[0]!.kind).toBe("added");
    expect(compareParagraphs(["x"], [])[0]!.kind).toBe("removed");
  });
});

describe("word_compare 工具", () => {
  it("对比两份 docx：left=基准、right=对比，返回 summary 与 entries", async () => {
    const left = await docxBuffer(["标题", "旧内容", "结尾"]);
    const right = await docxBuffer(["标题", "新内容", "结尾", "新增段落"]);
    const access = fileAccessFor({
      "fe-left": { buffer: left, originalName: "报告-旧.docx" },
      "fe-right": { buffer: right, originalName: "报告-新.docx" },
    });
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    const result = await toolOf(plugin, "word_compare").execute(
      { otherFileId: "fe-right" },
      context("fe-left"),
    );

    const payload = result.structuredContent as {
      fileId: string;
      otherFileId: string;
      summary: Record<string, number>;
      entries: Array<{ kind: string; left?: string; right?: string }>;
      truncated: boolean;
      identical: boolean;
      nextAction: string;
    };
    // fileId 省略 = 当前浏览文件；title 用文件库显示名。
    expect(payload.fileId).toBe("fe-left");
    expect(payload.otherFileId).toBe("fe-right");
    expect(payload.summary).toEqual({ same: 2, changed: 1, added: 1, removed: 0, total: 4 });
    expect(payload.entries.map((entry) => entry.kind)).toEqual(["same", "changed", "same", "added"]);
    expect(payload.entries[1]).toEqual({ kind: "changed", left: "旧内容", right: "新内容" });
    expect(payload.entries[3]).toEqual({ kind: "added", right: "新增段落" });
    expect(payload.truncated).toBe(false);
    expect(payload.identical).toBe(false);
    expect(payload.nextAction).toBe("report_result");
  });

  it("显式 fileId + 完全一致时 identical=true", async () => {
    const same = await docxBuffer(["一", "二", "三"]);
    const access = fileAccessFor({
      "fe-a": { buffer: same, originalName: "a.docx" },
      "fe-b": { buffer: same, originalName: "b.docx" },
    });
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    const result = await toolOf(plugin, "word_compare").execute(
      { fileId: "fe-a", otherFileId: "fe-b" },
      context(),
    );
    expect(result.structuredContent).toMatchObject({
      fileId: "fe-a",
      otherFileId: "fe-b",
      summary: { same: 3, changed: 0, added: 0, removed: 0, total: 3 },
      identical: true,
    });
    expect((result.structuredContent.hint as string)).toContain("完全一致");
  });

  it("maxEntries 截断 entries 但 summary 计数保持全量", async () => {
    const left = await docxBuffer(["公共", "旧一", "旧二", "旧三", "旧四"]);
    const right = await docxBuffer(["公共", "新一", "新二", "新三", "新四"]);
    const access = fileAccessFor({
      "fe-left": { buffer: left, originalName: "旧.docx" },
      "fe-right": { buffer: right, originalName: "新.docx" },
    });
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    const result = await toolOf(plugin, "word_compare").execute(
      { otherFileId: "fe-right", maxEntries: 2 },
      context("fe-left"),
    );
    const payload = result.structuredContent as {
      entries: unknown[];
      truncated: boolean;
      summary: { total: number };
    };
    expect(payload.entries).toHaveLength(2);
    expect(payload.truncated).toBe(true);
    // summary.total 是完整对齐条目数，不受 entries 截断影响。
    expect(payload.summary.total).toBeGreaterThan(payload.entries.length);
  });

  it("错误：缺 otherFileId / 和自己比 / 非 docx / 文件不存在", async () => {
    const docx = await docxBuffer(["x"]);
    const access = fileAccessFor({
      "fe-a": { buffer: docx, originalName: "a.docx" },
      "fe-xlsx": { buffer: docx, originalName: "表.xlsx" },
    });
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    const tool = toolOf(plugin, "word_compare");

    await expect(tool.execute({}, context("fe-a")))
      .rejects.toThrow(/INVALID_REQUEST: otherFileId 必填/);
    await expect(tool.execute({ otherFileId: "fe-a" }, context("fe-a")))
      .rejects.toThrow(/无法和自己对比/);
    await expect(tool.execute({ otherFileId: "fe-xlsx" }, context("fe-a")))
      .rejects.toThrow(/INVALID_TARGET: word_compare 对比文档只支持 \.docx/);
    await expect(tool.execute({ otherFileId: "fe-missing" }, context("fe-a")))
      .rejects.toThrow(/FILE_NOT_FOUND: 对比文件 fe-missing/);
  });

  it("错误：文档超过处理上限（单份 >25MB）", async () => {
    const docx = await docxBuffer(["x"]);
    const huge = Buffer.alloc(25 * 1024 * 1024 + 1);
    const access = fileAccessFor({
      "fe-left": { buffer: docx, originalName: "a.docx" },
      "fe-big": { buffer: huge, originalName: "大文件.docx" },
    });
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    await expect(toolOf(plugin, "word_compare").execute(
      { otherFileId: "fe-big" },
      context("fe-left"),
    )).rejects.toThrow(/FILE_TOO_LARGE: 《大文件\.docx》25\.0MB 超过处理上限/);
  });

  it("错误：段落数过多（LCS 对齐单元超上限）时给出可执行提示", async () => {
    const many = Array.from({ length: 2_100 }, (_, index) => `段落 ${index}`);
    const left = await docxBuffer(many);
    const right = await docxBuffer(many.map((text) => `${text} 改`));
    const access = fileAccessFor({
      "fe-left": { buffer: left, originalName: "a.docx" },
      "fe-right": { buffer: right, originalName: "b.docx" },
    });
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    await expect(toolOf(plugin, "word_compare").execute(
      { otherFileId: "fe-right" },
      context("fe-left"),
    )).rejects.toThrow(/FILE_TOO_LARGE: 两份文档段落数过多/);
  });

  it("非 docx 的左侧文档被拒绝", async () => {
    const docx = await docxBuffer(["x"]);
    const access = fileAccessFor({ "fe-xlsx": { buffer: docx, originalName: "表.xlsx" } });
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    await expect(toolOf(plugin, "word_compare").execute(
      { otherFileId: "fe-xlsx" },
      context("fe-xlsx"),
    )).rejects.toThrow(/INVALID_TARGET: word_compare 左侧文档只支持 \.docx/);
  });

  it("bytes 读取经 catalogContentOf（两文件各一次）", async () => {
    const left = await docxBuffer(["甲"]);
    const right = await docxBuffer(["乙"]);
    const contentOf = vi.fn(async (id: string) => ({
      buffer: id === "fe-left" ? left : right,
      mime: "application/octet-stream",
      filename: id,
    }));
    const access = fileAccessFor(
      { "fe-left": { buffer: left, originalName: "a.docx" }, "fe-right": { buffer: right, originalName: "b.docx" } },
      { contentOf },
    );
    const plugin = officePlugin(fakeBridge, null, null, () => access);
    await toolOf(plugin, "word_compare").execute({ otherFileId: "fe-right" }, context("fe-left"));
    expect(contentOf).toHaveBeenCalledTimes(2);
    expect(contentOf.mock.calls.map((call) => call[0]).sort()).toEqual(["fe-left", "fe-right"]);
  });
});