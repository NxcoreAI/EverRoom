import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { describe, expect, it } from "vitest";
import { SLIDES_TOOL_NAMES, officePlugin } from "../src/modules/documents/capabilities/office-plugin.js";
import { createSlidesWriterAgentTools } from "../src/modules/subagents/slides-writer-tools.js";

function tool(name: string): PiAgentRuntimeTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: "{}" }),
  };
}

describe("createSlidesWriterAgentTools（slides-writer 工具面）", () => {
  it("只放行 PPT 四件套 + 检索/读取/联网类；写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesWriterAgentTools({
      roomTools: [
        tool("memory_search"), tool("conversation_search"), tool("room_context_get"),
        tool("room_task_create"),
      ],
      documentTools: [
        ...SLIDES_TOOL_NAMES.map(tool),
        tool("context_room_list"), tool("context_room_document_list"), tool("context_room_document_read"),
        tool("context_room_office_create"), tool("context_room_sheets_create"),
        tool("context_room_write_begin"), tool("context_room_patch_begin"),
      ],
      webSearchTools: [tool("web_search"), tool("agent_dispatch"), tool("agent_catalog"), tool("send_notification")],
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "context_room_document_list",
      "context_room_document_read",
      "context_room_list",
      "context_room_slides_create",
      "context_room_slides_edit",
      "context_room_slides_read",
      "context_room_slides_set_page",
      "conversation_search",
      "memory_search",
      "room_context_get",
      "web_search",
    ]);
  });

  it("空依赖时返回空数组", () => {
    expect(createSlidesWriterAgentTools({ roomTools: [], documentTools: [], webSearchTools: [] })).toEqual([]);
  });
});

describe("SLIDES_TOOL_NAMES（主 Agent 剔除清单 ↔ 插件工具清单同步）", () => {
  it("officePlugin 注册的工具覆盖全部四个名字（改名/增删时清单不失真）", () => {
    const plugin = officePlugin(null as never);
    const registered = plugin.tools.map((item) => item.name);
    for (const name of SLIDES_TOOL_NAMES) {
      expect(registered).toContain(name);
    }
  });
});
