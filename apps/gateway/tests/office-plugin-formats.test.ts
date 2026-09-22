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
  const plugin = officePlugin(bridge);
  const tools = new Map(plugin.tools.map((tool) => [tool.name, tool]));
  return { generate, plugin, tools };
}

const context: DocumentExecutionContext = { agentSessionId: "session-1", runId: "run-1", roomId: "room-1" };

describe("office 工具：PPT / Excel 扩展", () => {
  it("插件暴露三个工具：word / slides / sheets", () => {
    const { tools } = createHarness();
    expect([...tools.keys()].sort()).toEqual([
      "context_room_office_create",
      "context_room_sheets_create",
      "context_room_slides_create",
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

  it("三个工具都要求先选 Room", async () => {
    const { tools } = createHarness();
    const noRoom = { ...context, roomId: null };
    for (const name of ["context_room_office_create", "context_room_slides_create", "context_room_sheets_create"]) {
      await expect(
        tools.get(name)!.execute(
          name === "context_room_slides_create" ? { title: "t", pages: [{ elements: [] }] }
            : name === "context_room_sheets_create" ? { title: "t", sheets: [{ rows: [["a"]] }] }
              : { title: "t", html: "<p>x</p>" },
          noRoom,
        ),
      ).rejects.toThrow("ROOM_SELECTION_REQUIRED");
    }
  });
});
