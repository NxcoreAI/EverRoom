import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { describe, expect, it } from "vitest";
import { createDocWriterAgentTools } from "../src/modules/subagents/doc-writer-tools.js";

function tool(name: string): PiAgentRuntimeTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: "{}" }),
  };
}

describe("createDocWriterAgentTools（doc-writer 素材自取工具面）", () => {
  it("只放行检索/读取/分析/联网类；写入、调度、通知类一律拒绝", () => {
    const tools = createDocWriterAgentTools({
      roomTools: [
        tool("memory_search"), tool("conversation_search"), tool("room_context_get"),
        tool("room_task_create"), tool("room_schedule_create"),
      ],
      documentTools: [
        tool("context_room_list"), tool("context_room_document_list"), tool("context_room_document_read"),
        tool("context_room_document_intent"),
        tool("context_room_write_begin"), tool("context_room_write_append"), tool("context_room_write_commit"),
        tool("context_room_patch_begin"), tool("context_room_patch_hunk"), tool("context_room_patch_commit"),
        tool("context_room_create"),
      ],
      analysisTools: [
        tool("agent_catalog"), tool("agent_dispatch"), tool("content_analysis"), tool("room_analysis"),
        tool("document_draft"), tool("document_analysis"),
      ],
      webSearchTools: [tool("web_search"), tool("send_notification")],
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "content_analysis",
      "context_room_document_list",
      "context_room_document_read",
      "context_room_list",
      "conversation_search",
      "memory_search",
      "room_analysis",
      "room_context_get",
      "web_search",
    ]);
  });

  it("空依赖时返回空数组（未配置联网/子 agent 时不注册空壳）", () => {
    expect(createDocWriterAgentTools({
      roomTools: [], documentTools: [], analysisTools: [], webSearchTools: [],
    })).toEqual([]);
  });
});
