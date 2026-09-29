import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { describe, expect, it } from "vitest";
import { SLIDES_TOOL_NAMES, officePlugin } from "../src/modules/documents/capabilities/office-plugin.js";
import { createSlidesPlannerAgentTools, createSlidesBuilderAgentTools } from "../src/modules/subagents/slides-agent-tools.js";

function tool(name: string): PiAgentRuntimeTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: "{}" }),
  };
}

const PLANNER_ROOM_TOOLS = [
  tool("memory_search"), tool("conversation_search"), tool("room_context_get"), tool("room_task_create"),
];
const PLANNER_DOCUMENT_TOOLS = [
  ...SLIDES_TOOL_NAMES.map(tool),
  tool("context_room_list"), tool("context_room_document_list"), tool("context_room_document_read"),
  tool("context_room_office_create"), tool("context_room_sheets_create"),
  tool("context_room_write_begin"), tool("context_room_patch_begin"),
];

describe("createSlidesPlannerAgentTools（slides-planner 工具面）", () => {
  it("只放行检索/读取/联网/素材类；slides 四件套、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesPlannerAgentTools({
      roomTools: PLANNER_ROOM_TOOLS,
      documentTools: PLANNER_DOCUMENT_TOOLS,
      webSearchTools: [tool("web_search"), tool("agent_dispatch"), tool("agent_catalog"), tool("send_notification")],
      materialSearchTools: [tool("material_search"), tool("send_notification")],
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "context_room_document_list",
      "context_room_document_read",
      "context_room_list",
      "conversation_search",
      "material_search",
      "memory_search",
      "room_context_get",
      "web_search",
    ]);
  });

  it("空依赖时返回空数组", () => {
    expect(createSlidesPlannerAgentTools({ roomTools: [], documentTools: [], webSearchTools: [], materialSearchTools: [] })).toEqual([]);
  });
});

describe("createSlidesBuilderAgentTools（slides-builder 工具面）", () => {
  it("只放行 PPT 四件套；检索、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesBuilderAgentTools({
      documentTools: PLANNER_DOCUMENT_TOOLS,
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "context_room_slides_create",
      "context_room_slides_edit",
      "context_room_slides_read",
      "context_room_slides_set_page",
    ]);
  });

  it("空依赖时返回空数组", () => {
    expect(createSlidesBuilderAgentTools({ documentTools: [] })).toEqual([]);
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
