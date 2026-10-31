import type { StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { describe, expect, it } from "vitest";
import { SLIDES_TOOL_NAMES, officePlugin } from "../src/modules/documents/capabilities/office-plugin.js";
import {
  createSlidesPlannerAgentTools,
  createSlidesBuilderAgentTools,
  createSlidesLayouterAgentTools,
} from "../src/modules/subagents/slides-agent-tools.js";

function tool(name: string): PiAgentRuntimeTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: "{}" }),
  };
}

function runInput(phase?: string): StartRuntimeRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    runtimeSessionRef: null,
    prompt: "prompt",
    pageLabel: "Subagent: Slides Planner",
    // 去 Room：slides 子 run 不再绑定房间（字段仍必填，单工作区写 null）。
    roomId: null,
    toolsEnabled: true,
    ...(phase ? { runtimeMetadata: { subagentInput: { phase } } } : {}),
  };
}

const PLANNER_DOCUMENT_TOOLS = [
  ...SLIDES_TOOL_NAMES.map(tool),
  tool("document_list"), tool("document_read"),
  tool("office_create"), tool("sheets_create"),
  tool("document_write_begin"), tool("document_patch_begin"),
];

const PLANNER_WORKSPACE_TOOLS = [tool("workspace_files_list"), tool("send_notification")];

const PLANNER_READ_FILE_TEXT = async (fileEntryId: string) =>
  fileEntryId === "file-1" ? { text: "一二三四五六七八九十".repeat(1_000), filename: "锥光 BP-1020.md" } : null;

describe("createSlidesPlannerAgentTools（slides-planner 工具面）", () => {
  it("只放行读取/联网/素材/配图预热类；slides 四件套、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesPlannerAgentTools({
      documentTools: PLANNER_DOCUMENT_TOOLS,
      webSearchTools: [tool("web_search"), tool("agent_dispatch"), tool("agent_catalog"), tool("send_notification")],
      workspaceFileTools: PLANNER_WORKSPACE_TOOLS,
      readWorkspaceFileText: PLANNER_READ_FILE_TEXT,
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "document_list",
      "document_read",
      "slides_image_prewarm",
      "web_search",
      "workspace_file_read",
      "workspace_files_list",
    ]);
  });

  it("空依赖时只含配图预热（token 注册表寻址，装配零依赖）", () => {
    expect(createSlidesPlannerAgentTools({ documentTools: [], webSearchTools: [] })
      .map((item) => item.name)).toEqual(["slides_image_prewarm"]);
  });

  it("工作区文件读取：draft 单次限 8k 字符并给 nextOffset，arrange 拒读，未知文件报错", async () => {
    const tools = createSlidesPlannerAgentTools({
      documentTools: [],
      webSearchTools: [],
      workspaceFileTools: PLANNER_WORKSPACE_TOOLS,
      readWorkspaceFileText: PLANNER_READ_FILE_TEXT,
    });
    const wrapped = tools.find((item) => item.name === "workspace_file_read")!;
    const page1 = JSON.parse((await wrapped.execute(runInput("draft"), { fileEntryId: "file-1" })).content) as {
      text: string;
      totalCharacters: number;
      truncated: boolean;
      nextOffset?: number;
    };
    expect(page1.text.length).toBe(8_000);
    expect(page1.truncated).toBe(true);
    expect(page1.nextOffset).toBe(8_000);
    expect(page1.totalCharacters).toBe(10_000);

    const arrange = JSON.parse((await wrapped.execute(runInput("arrange"), { fileEntryId: "file-1" })).content) as {
      skipped?: boolean;
    };
    expect(arrange.skipped).toBe(true);

    const missing = JSON.parse((await wrapped.execute(runInput("draft"), { fileEntryId: "nope" })).content) as {
      error?: string;
    };
    expect(missing.error).toContain("workspace_files_list");
  });

  it("文档读取：draft 单次限 8k 字符，arrange 阶段直接拒读", async () => {
    const documentRead: PiAgentRuntimeTool = {
      name: "document_read",
      label: "read",
      description: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, params) => ({ content: JSON.stringify(params) }),
    };
    const tools = createSlidesPlannerAgentTools({
      documentTools: [tool("document_list"), documentRead],
      webSearchTools: [],
    });
    const wrapped = tools.find((item) => item.name === "document_read")!;
    const draft = JSON.parse((await wrapped.execute(runInput("draft"), { documentId: "doc-1", limit: 99_999 })).content) as {
      limit: number;
      offset: number;
    };
    expect(draft).toMatchObject({ limit: 8_000, offset: 0 });

    const arrange = JSON.parse((await wrapped.execute(runInput("arrange"), { documentId: "doc-1" })).content) as {
      skipped?: boolean;
    };
    expect(arrange.skipped).toBe(true);
  });
});

describe("createSlidesBuilderAgentTools（slides-builder 工具面）", () => {
  it("只放行 PPT 四件套；检索、写入、调度、通知类一律拒绝", () => {
    const tools = createSlidesBuilderAgentTools({
      documentTools: PLANNER_DOCUMENT_TOOLS,
    });
    expect(tools.map((item) => item.name).sort()).toEqual([
      "slides_create",
      "slides_edit",
      "slides_read",
      "slides_set_page",
    ]);
  });

  it("空依赖时返回空数组", () => {
    expect(createSlidesBuilderAgentTools({ documentTools: [] })).toEqual([]);
  });
});

describe("createSlidesPlannerAgentTools（网关预取协同）", () => {
  it("网关预取在 sourceDocuments 里的文档：planner 再读直接跳过，不重复占上下文", async () => {
    let executed = 0;
    const documentRead: PiAgentRuntimeTool = {
      name: "document_read",
      label: "read",
      description: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        executed += 1;
        return { content: JSON.stringify({ markdown: "正文" }) };
      },
    };
    const tools = createSlidesPlannerAgentTools({
      documentTools: [documentRead],
      webSearchTools: [],
    });
    const wrapped = tools.find((item) => item.name === "document_read")!;
    const prefetched = {
      ...runInput("draft"),
      runtimeMetadata: {
        subagentInput: {
          phase: "draft",
          sourceDocuments: [
            { documentId: "doc-prefetched", title: "大纲", version: 1, markdown: "正文", markdownTotalCharacters: 2 },
          ],
        },
      },
    };
    const skipped = JSON.parse((await wrapped.execute(prefetched, { documentId: "doc-prefetched" })).content) as {
      skipped?: boolean;
      reason?: string;
    };
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toContain("sourceDocuments");
    expect(executed).toBe(0);

    // 未预取的文档仍正常读取。
    const read = JSON.parse((await wrapped.execute(prefetched, { documentId: "doc-other" })).content) as {
      markdown?: string;
    };
    expect(read.markdown).toBe("正文");
    expect(executed).toBe(1);

    // 预取时被预算截断的文档不拦：planner 还需要用 offset/limit 读剩余部分。
    const truncatedPrefetch = {
      ...runInput("draft"),
      runtimeMetadata: {
        subagentInput: {
          phase: "draft",
          sourceDocuments: [{
            documentId: "doc-truncated",
            title: "超长文档",
            version: 1,
            markdown: "前 40k",
            markdownTotalCharacters: 90_000,
            truncated: true,
          }],
        },
      },
    };
    await wrapped.execute(truncatedPrefetch, { documentId: "doc-truncated", offset: 40_000 });
    expect(executed).toBe(2);
  });

  it("分批编排时预热工具直接跳过，不把无效 token 变成失败轮次", async () => {
    const tools = createSlidesPlannerAgentTools({ documentTools: [], webSearchTools: [] });
    const prewarm = tools.find((item) => item.name === "slides_image_prewarm")!;
    const input = {
      ...runInput("arrange"),
      runtimeMetadata: { subagentInput: { phase: "arrange", arrangeBatch: { index: 0 } } },
    };
    const result = JSON.parse((await prewarm.execute(input, { prewarmToken: "none", pageIndex: 1, imagePrompt: "画面" })).content) as {
      skipped?: boolean;
    };
    expect(result.skipped).toBe(true);
  });
});

describe("createSlidesLayouterAgentTools（validate 收口）", () => {
  it("同一 run 连续 5 轮不收敛后网关收下当前树并提示提交", async () => {
    const tool = createSlidesLayouterAgentTools()[0]!;
    const input = { ...runInput(), runId: "validate-forced-run" };
    for (let round = 1; round <= 4; round += 1) {
      const outcome = JSON.parse((await tool.execute(input, { token: "unknown-token", tree: {} })).content) as {
        ok: boolean;
        round?: number;
      };
      expect(outcome.ok).toBe(false);
      expect(outcome.round).toBe(round);
    }
    const forced = JSON.parse((await tool.execute(input, { token: "unknown-token", tree: {} })).content) as {
      ok: boolean;
      forcedSubmission?: boolean;
      warning?: string;
    };
    expect(forced).toMatchObject({ ok: true, forcedSubmission: true });
    expect(forced.warning).toContain("subagent_submit_result");
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
