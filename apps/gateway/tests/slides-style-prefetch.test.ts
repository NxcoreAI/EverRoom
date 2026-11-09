import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import type { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";
import type { SlidesStyleStageDeps } from "../src/modules/subagents/slides-style-stage.js";
import type { SlidesStyleImageGenerator } from "../src/modules/slides-style/image-gen.js";
import { SlidesStyleSessionStore } from "../src/modules/slides-style/style-session.js";
import type { DatabaseClient } from "../src/infrastructure/database/client.js";
import { createDatabase } from "../src/infrastructure/database/client.js";

/**
 * 风格预热（styler ∥ 大纲）的回归钉子。
 *
 * 背景（2026-10-21 实测）：用户读完草稿平均 511s（P50，50 个真实会话）。
 * 风格方向与纵览图只依赖用户那句需求，不依赖草稿正文，所以这段等待是"白给"的
 * 并行窗口——草稿一落文档就开跑风格，后续 style 调用直接命中 images_ready 复用分支。
 *
 * 这个文件钉住两件事：
 * 1. 草稿阶段确实把风格跑掉了（否则省不下时间）；
 * 2. 用户紧接着调 style 时**不重跑生图**（否则白烧一套配额，比不预热更糟）。
 */
// 去 Room：run 只有 runId/sessionId——无 roomId、无 availableRooms。
const run = { runId: "run-1", sessionId: "session-1" };

const planFixture = {
  phase: "draft",
  title: "季度汇报",
  pages: [
    { title: "封面", points: ["季度汇报"] },
    { title: "业绩", role: "data", points: ["营收增长"], data: "Q1: 1.2 亿" },
    { title: "计划", points: ["三线扩张"] },
  ],
  warnings: [],
};

const directionOutput = {
  task: "direction",
  candidates: [
    { label: "深空科技", imagePrompt: `一张深色科技风 PPT 风格参考图，16:9 横版，深炭黑底亮青主色。${"细节".repeat(30)}` },
    { label: "冷灰商务", imagePrompt: `一张浅色商务风 PPT 风格参考图，16:9 横版，灰白底藏蓝主色。${"细节".repeat(30)}` },
    { label: "暖调编辑", imagePrompt: `一张暖色人文风 PPT 风格参考图，16:9 横版，米白底赭棕主色。${"细节".repeat(30)}` },
  ],
};

function registryWith(agentIds: string[]): SubagentRegistry {
  const ids = agentIds.includes("slides-editor") ? agentIds : [...agentIds, "slides-editor"];
  return {
    get: (id: string) => (ids.includes(id) ? { id } : null),
    listAvailable: () => [],
    listAll: () => [],
  } as unknown as SubagentRegistry;
}

function invocation(overrides: Partial<SubagentInvocation>): SubagentInvocation {
  return {
    id: "invocation-1",
    agentDefinitionId: "slides-planner",
    agentRevisionId: "revision-1",
    source: "primary_agent",
    parentSessionId: "session-1",
    parentRunId: "run-1",
    task: "演示文稿内容草稿",
    input: null,
    status: "completed",
    result: { text: "" },
    errorCode: null,
    errorMessage: null,
    createdAt: "",
    startedAt: "",
    completedAt: "",
    ...overrides,
  } as SubagentInvocation;
}

describe("风格预热：styler 在用户阅读草稿的窗口里先跑完", () => {
  const databases: DatabaseClient[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    databases.splice(0).forEach((database) => database.sqlite.close());
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-style-prefetch-test-"));
    directories.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    databases.push(database);

    const generateImages = vi.fn(async (input: { candidates: Array<{ prompt: string }>; idempotencyKey: string }) =>
      input.candidates.map((candidate, index) => ({
        contentHash: `${input.idempotencyKey}:${String(index)}`.padEnd(64, "0").slice(0, 64),
        fileEntryId: `entry-${String(index)}`,
        index,
      })));

    const deps: SlidesStyleStageDeps = {
      sessions: new SlidesStyleSessionStore(database.db),
      images: { generateOverviewImages: generateImages } as unknown as SlidesStyleImageGenerator,
      vlm: {
        model: "test-vlm",
        analyze: async () => ({ serif: false, weight: "bold", geometric: "neutral", rounded: false }),
      },
      readMaterialBytes: async () => ({ buffer: Buffer.from("png"), mime: "image/png" }),
      demoRenderer: { renderPptx: async () => { throw new Error("office_bridge_unavailable"); } },
      saveDemoPng: async () => ({ contentHash: "d".repeat(64), fileEntryId: "demo-entry" }),
      resolveDraftDocument: () => ({ markdown: "## 封面\n- 季度汇报\n\n## 业绩\n数据：bar | 营收: 1\n" }),
    } as unknown as SlidesStyleStageDeps;

    const dispatch = vi.fn(async (input: { agentId: string; input?: { task?: string } }) => {
      if (input.agentId === "slides-planner") {
        return invocation({ task: "演示文稿内容草稿", result: { text: "", structuredOutput: planFixture } });
      }
      if (input.agentId === "slides-styler") {
        // 预热只走到 direction；settle 是用户挑完图之后才发生，这里不该出现。
        return invocation({ agentDefinitionId: "slides-styler", task: "纵览图生图提示词", result: { text: "", structuredOutput: directionOutput } });
      }
      throw new Error(`unexpected agent ${input.agentId}`);
    });
    const orchestrator = { dispatch } as unknown as SubagentOrchestrator & { dispatch: typeof dispatch };

    const createSlidesDraftDocument = vi.fn(async () => ({ documentId: "doc-draft-1", title: "季度汇报" }));
    const tools = createSubagentPiTools(registryWith(["slides-planner", "slides-builder"]), orchestrator, {
      slidesStyle: deps,
      createSlidesDraftDocument,
    });
    return { tools, dispatch, generateImages };
  }

  it("草稿落地即预热风格，随后 style 调用复用候选、不重复生图", async () => {
    const { tools, dispatch, generateImages } = await setup();
    const slidesDraft = tools.find((tool) => tool.name === "slides_draft")!;

    // ① 草稿阶段：planner 出稿 → 落文档 → 顺手把风格跑掉。
    const draftResult = await slidesDraft.execute(
      { ...run } as never,
      { task: "draft", instruction: "做一份商务科技风的季度汇报", title: "季度汇报" } as never,
      undefined,
      vi.fn(),
    );
    expect(JSON.parse(draftResult.content as string)).toMatchObject({ status: "draft_ready", documentId: "doc-draft-1" });

    // 预热是后台跑的：等它落定（真实场景里这是用户读草稿的那几分钟）。
    await vi.waitFor(() => expect(generateImages).toHaveBeenCalledTimes(1));
    const directionCalls = dispatch.mock.calls.filter(
      (call) => (call[0] as { agentId: string }).agentId === "slides-styler",
    );
    expect(directionCalls).toHaveLength(1);

    // ② 用户确认草稿 → 走 style：应该直接拿到 images_ready，不再派 styler、不再生图。
    const styleResult = await slidesDraft.execute(
      { ...run } as never,
      { task: "style", instruction: "做一份商务科技风的季度汇报", draftDocumentId: "doc-draft-1" } as never,
      undefined,
      vi.fn(),
    );
    const payload = JSON.parse(styleResult.content as string) as { status: string; styleSessionId: string; candidates: number };
    expect(payload.status).toBe("style_images_ready");
    expect(payload.candidates).toBe(3);

    const stylerCalls = dispatch.mock.calls.filter(
      (call) => (call[0] as { agentId: string }).agentId === "slides-styler",
    );
    expect(stylerCalls).toHaveLength(1);
    expect(generateImages).toHaveBeenCalledTimes(1);
  });
});
