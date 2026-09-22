import { describe, expect, it, vi } from "vitest";

import { OfficeBridgeClient } from "../src/modules/documents/capabilities/office-bridge-client.js";
import { officePlugin } from "../src/modules/documents/capabilities/office-plugin.js";
import type { DocumentExecutionContext } from "../src/modules/documents/capabilities/types.js";

function createHarness() {
  const bridge = new OfficeBridgeClient({ baseUrl: "http://127.0.0.1:9", token: "test-token" });
  const generate = vi.spyOn(bridge, "generate").mockResolvedValue({
    fileEntryId: "fe-1",
    fileVersionId: "fv-1",
    jobId: "job-1",
    contentHash: "hash-1",
    blobDeduped: false,
    versionDeduped: false,
    roomRequested: true,
    originalName: "out.pptx",
  });
  const readDeck = vi.spyOn(bridge, "readDeck").mockResolvedValue({
    outline: "Page 1\n  t1 | text | 季度回顾",
    opVocabulary: "setText: 修改文本…",
  });
  const editDeck = vi.spyOn(bridge, "editDeck").mockResolvedValue({
    ok: true,
    applied: true,
    records: [{ op: "setText", created: ["t1"] }],
    saved: true,
    outline: "Page 1\n  t1 | text | 年度回顾",
  });
  const plugin = officePlugin(bridge);
  const tools = new Map(plugin.tools.map((tool) => [tool.name, tool]));
  return { generate, readDeck, editDeck, plugin, tools };
}

const context: DocumentExecutionContext = { agentSessionId: "session-1", runId: "run-1", roomId: "room-1" };

describe("office 工具：PPT / Excel 扩展", () => {
  it("插件暴露五个工具：word / slides / sheets 生成 + slides 读 / 编辑", () => {
    const { tools } = createHarness();
    expect([...tools.keys()].sort()).toEqual([
      "context_room_office_create",
      "context_room_sheets_create",
      "context_room_slides_create",
      "context_room_slides_edit",
      "context_room_slides_read",
    ]);
  });

  it("slides：pages 对象 stringify 下发、format=pptx、幂等键前缀 agent-slides", async () => {
    const { tools, generate } = createHarness();
    const result = await tools.get("context_room_slides_create")!.execute(
      {
        title: "季度汇报",
        pages: [
          { background: "#FFFFFF", elements: [{ type: "text", x: 80, y: 80, w: 400, h: 80, paragraphs: [{ runs: [{ text: "标题", sizePt: 54, bold: true }] }] }] },
          '{"elements":[{"type":"text","x":1,"y":1,"w":10,"h":10,"paragraphs":[{"runs":[{"text":"b"}]}]}]}',
        ],
      },
      context,
    );
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0]![0];
    expect(input.format).toBe("pptx");
    expect(input.pages).toHaveLength(2);
    expect(input.pages![0]).toContain('"background":"#FFFFFF"');
    expect(input.pages![1]).toEqual('{"elements":[{"type":"text","x":1,"y":1,"w":10,"h":10,"paragraphs":[{"runs":[{"text":"b"}]}]}]}');
    expect(input.idempotencyKey!.startsWith("agent-slides:")).toBe(true);
    expect(result).toBeTruthy();
  });

  it("slides：pages 非数组 / 空数组 / 非法页 → INVALID_REQUEST", async () => {
    const { tools } = createHarness();
    const slides = tools.get("context_room_slides_create")!;
    await expect(slides.execute({ title: "t", pages: [] }, context)).rejects.toThrow("INVALID_REQUEST");
    await expect(slides.execute({ title: "t", pages: "nope" }, context)).rejects.toThrow("INVALID_REQUEST");
    await expect(slides.execute({ title: "t", pages: [{ elements: [] }, 42] }, context)).rejects.toThrow("第 2 页");
    await expect(slides.execute({ title: "t", pages: [{ elements: [] }], fileName: "a.docx" }, context)).rejects.toThrow(".pptx 结尾");
  });

  it("sheets：rows 二维数组透传（数字/布尔保留）、format=xlsx、幂等键前缀 agent-sheets", async () => {
    const { tools, generate } = createHarness();
    await tools.get("context_room_sheets_create")!.execute(
      {
        title: "预算",
        sheets: [{ name: "Q3", rows: [["项目", "金额"], ["咖啡", 12.5], ["启用", true]] }],
      },
      context,
    );
    const input = generate.mock.calls[0]![0];
    expect(input.format).toBe("xlsx");
    expect(input.sheets).toEqual([{ name: "Q3", rows: [["项目", "金额"], ["咖啡", 12.5], ["启用", true]] }]);
    expect(input.idempotencyKey!.startsWith("agent-sheets:")).toBe(true);
  });

  it("sheets：缺 rows / 行非数组 / 空 rows → INVALID_REQUEST；fileName 扩展名校验", async () => {
    const { tools } = createHarness();
    const sheets = tools.get("context_room_sheets_create")!;
    await expect(sheets.execute({ title: "t", sheets: [] }, context)).rejects.toThrow("INVALID_REQUEST");
    await expect(sheets.execute({ title: "t", sheets: [{ name: "x" }] }, context)).rejects.toThrow("rows");
    await expect(sheets.execute({ title: "t", sheets: [{ rows: ["nope"] }] }, context)).rejects.toThrow("不是数组");
    await expect(sheets.execute({ title: "t", sheets: [{ rows: [["a"]] }], fileName: "a.docx" }, context)).rejects.toThrow(".xlsx 结尾");
  });

  it("word：原行为不变（缺省 docx + html 必填 + 幂等键前缀 agent-word）", async () => {
    const { tools, generate } = createHarness();
    await tools.get("context_room_office_create")!.execute({ title: "报告", html: "<p>正文</p>" }, context);
    const input = generate.mock.calls[0]![0];
    expect(input.format).toBeUndefined();
    expect(input.html).toBe("<p>正文</p>");
    expect(input.idempotencyKey!.startsWith("agent-word:")).toBe(true);
  });

  it("五个工具都要求先选 Room", async () => {
    const { tools } = createHarness();
    const noRoom = { ...context, roomId: null };
    const args: Record<string, Record<string, unknown>> = {
      context_room_office_create: { title: "t", html: "<p>x</p>" },
      context_room_slides_create: { title: "t", pages: [{ elements: [] }] },
      context_room_sheets_create: { title: "t", sheets: [{ rows: [["a"]] }] },
      context_room_slides_read: { fileId: "file-1" },
      context_room_slides_edit: { fileId: "file-1", ops: [{ op: "setNotes" }] },
    };
    for (const [name, input] of Object.entries(args)) {
      await expect(tools.get(name)!.execute(input, noRoom)).rejects.toThrow("ROOM_SELECTION_REQUIRED");
    }
  });
});

describe("office 工具：PPT 编辑（slides read / edit）", () => {
  it("slides_read：转发 fileId，返回 outline + opVocabulary + nextAction=edit", async () => {
    const { tools, readDeck } = createHarness();
    const result = await tools.get("context_room_slides_read")!.execute({ fileId: "file-9" }, context);
    expect(readDeck).toHaveBeenCalledWith("file-9");
    expect(result.structuredContent).toEqual({
      fileId: "file-9",
      outline: "Page 1\n  t1 | text | 季度回顾",
      opVocabulary: "setText: 修改文本…",
      nextAction: "edit",
    });
  });

  it("slides_read：省略 fileId → 'active'（当前打开的那个 PPT）", async () => {
    const { tools, readDeck } = createHarness();
    const result = await tools.get("context_room_slides_read")!.execute({}, context);
    expect(readDeck).toHaveBeenCalledWith("active");
    expect(result.structuredContent).toMatchObject({ fileId: "active", nextAction: "edit" });
  });

  it("slides_read：只读打开（editable:false）→ 透传标记 + nextAction=guide_reopen_editable", async () => {
    const { tools, readDeck } = createHarness();
    readDeck.mockResolvedValueOnce({ outline: "Page 1…", opVocabulary: "…", editable: false });
    const result = await tools.get("context_room_slides_read")!.execute({ fileId: "file-9" }, context);
    expect(result.structuredContent).toMatchObject({
      editable: false,
      nextAction: "guide_reopen_editable",
    });
  });

  it("slides_read：桌面端未返回大纲 → OFFICE_EDIT_FAILED", async () => {
    const { tools, readDeck } = createHarness();
    readDeck.mockResolvedValueOnce({ outline: "", opVocabulary: "" });
    await expect(
      tools.get("context_room_slides_read")!.execute({ fileId: "file-9" }, context),
    ).rejects.toThrow("OFFICE_EDIT_FAILED");
  });

  it("slides_edit：透传 ops/isolation/dryRun，返回事务结果与新 outline", async () => {
    const { tools, editDeck } = createHarness();
    const ops = [{ op: "setText", target: { id: "t1" }, text: "年度回顾" }];
    const result = await tools.get("context_room_slides_edit")!.execute(
      { fileId: "file-9", ops, isolation: "per_op", dryRun: false },
      context,
    );
    expect(editDeck).toHaveBeenCalledWith({ fileId: "file-9", ops, isolation: "per_op", dryRun: false });
    expect(result.structuredContent).toMatchObject({
      fileId: "file-9",
      applied: true,
      saved: true,
      records: [{ op: "setText", created: ["t1"] }],
      outline: "Page 1\n  t1 | text | 年度回顾",
      nextAction: "report_result",
    });
  });

  it("slides_edit：不带 isolation/dryRun 时不下发这两个字段", async () => {
    const { tools, editDeck } = createHarness();
    const ops = [{ op: "deleteSlide", target: { slide: 1 } }];
    await tools.get("context_room_slides_edit")!.execute({ fileId: "file-9", ops }, context);
    expect(editDeck).toHaveBeenCalledWith({ fileId: "file-9", ops });
  });

  it("slides_edit：未生效 → failures 透传 + nextAction=fix_ops_and_retry", async () => {
    const { tools, editDeck } = createHarness();
    editDeck.mockResolvedValueOnce({
      ok: true,
      applied: false,
      failures: [{ index: 0, error: "未知元素 id: tX（用法：…）" }],
      saved: true,
    });
    const result = await tools.get("context_room_slides_edit")!.execute(
      { fileId: "file-9", ops: [{ op: "setText" }] },
      context,
    );
    expect(result.structuredContent).toMatchObject({
      applied: false,
      failures: [{ index: 0, error: "未知元素 id: tX（用法：…）" }],
      nextAction: "fix_ops_and_retry",
    });
  });

  it("slides_edit：宿主级失败（ok:false）→ OFFICE_EDIT_FAILED", async () => {
    const { tools, editDeck } = createHarness();
    editDeck.mockResolvedValueOnce({ ok: false, error: "PPT 未在 Room 中打开" });
    await expect(
      tools.get("context_room_slides_edit")!.execute({ fileId: "file-9", ops: [{ op: "setNotes" }] }, context),
    ).rejects.toThrow("OFFICE_EDIT_FAILED: PPT 未在 Room 中打开");
  });

  it("slides_edit：ops 非数组 / 空数组 → INVALID_REQUEST", async () => {
    const { tools, editDeck } = createHarness();
    const edit = tools.get("context_room_slides_edit")!;
    await expect(edit.execute({ fileId: "file-9" }, context)).rejects.toThrow("INVALID_REQUEST");
    await expect(edit.execute({ fileId: "file-9", ops: [] }, context)).rejects.toThrow("INVALID_REQUEST");
    await expect(edit.execute({ fileId: "file-9", ops: "nope" }, context)).rejects.toThrow("INVALID_REQUEST");
    expect(editDeck).not.toHaveBeenCalled();
  });

  it("slides_edit：未识别的 isolation 不下发，atomic/per_op 原样透传", async () => {
    const { tools, editDeck } = createHarness();
    const ops = [{ op: "setNotes", target: { slide: 0 }, text: "x" }];
    await tools.get("context_room_slides_edit")!.execute(
      { fileId: "file-9", ops, isolation: "loose" },
      context,
    );
    expect(editDeck).toHaveBeenCalledWith({ fileId: "file-9", ops });
    await tools.get("context_room_slides_edit")!.execute(
      { fileId: "file-9", ops, isolation: "atomic" },
      context,
    );
    expect(editDeck).toHaveBeenLastCalledWith({ fileId: "file-9", ops, isolation: "atomic" });
  });
});
