import { describe, expect, it, vi } from "vitest";
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";
import { semanticFixture } from "./fixtures/slides-semantic.js";
import { assignContentSources, semanticHash } from "../src/modules/subagents/slides-semantic-contract.js";
import { assembleSemanticPlan, SEMANTIC_MODE } from "../src/modules/subagents/slides-semantic-stage.js";
import { createSlidesTreeResultValidator } from "../src/modules/subagents/slides-agent-tools.js";

describe("semantic generation pipeline", () => {
  function harness(broken = false) {
    const draft = { title: "项目目录", points: ["市场与客户", "产品与交付"] };
    const sources = assignContentSources([draft], "draft");
    const content = semanticFixture(draft.title, draft.points, "navigates", "toc").page;
    content.id = sources[0]!.pageId;
    content.sourceRefs = sources.map(s => s.id);
    content.blocks.forEach((b, i) => b.sourceRefs = [sources[i]!.id]);
    const save = vi.fn();
    const generationConfig = vi.fn(() => ({ model: "model-a" }));
    const trash = vi.fn(async () => {});
    const fillPage = vi.fn(async () => ({ ok: true, applied: true }));
    const ajv = new Ajv({ strict: false });
    const schemas = Object.fromEntries(["slides-planner", "slides-layouter", "slides-editor"].map(agent => [agent, ajv.compile(JSON.parse(readFileSync(resolve("../../agents", agent, "schemas/input.schema.json"), "utf8")))]));
    const dispatch = vi.fn(async ({ agentId, input }: any) => {
      expect(schemas[agentId]!(input), JSON.stringify(schemas[agentId]!.errors)).toBe(true);
      if (agentId === "slides-planner") return { status: "completed", id: "planner", result: { structuredOutput: {
        phase: "arrange", title: "项目", pages: [{ title: content.message, role: "toc", points: draft.points, notes: "目录包含市场与客户、产品与交付。".repeat(5), content: broken ? undefined : content }], summary: "done",
      } } };
      if (agentId === "slides-editor") return { status: "failed", result: null };
      const tree = { version: 2, role: "toc", composition: "swiss", nodes: content.blocks.map((b, i) => ({
        type: "text", token: i === 0 ? "h1" : "body", text: (b as any).text, slot: { col: [1, 12], row: [i * 2 + 1, i * 2 + 2] },
      })) };
      return { status: "completed", id: "layout", result: { structuredOutput: { tree, designIntent: "主题与两项导航", bindings: content.blocks.map((b, i) => ({ blockId: b.id, paths: [`nodes/${i}`] })) } } };
    });
    const tool = createSubagentPiTools({ get: (id: string) => ({ id }) } as any, { dispatch } as any, {
      slidesEditor: { active: true, store: { save } as any, generationConfig },
      resolveDocumentForDraft: () => ({ document: { title: "项目" }, markdown: "## 项目目录\n- 市场与客户\n- 产品与交付" }) as any,
      trashSlidesDraftDocument: trash,
      slidesLayoutOffice: { bridge: { generate: async () => ({ fileEntryId: "deck" }), fillPage, renderPage: async () => "" }, readMaterialBlob: async () => null, fetchImageHead: async () => null } as any,
    }).find(t => t.name === "slides_draft")!;
    const execute = () => tool.execute({ runId: "run", sessionId: "session", roomId: "room" } as any, { task: "generate", instruction: "目录", draftDocumentId: "draft" });
    return { dispatch, save, trash, fillPage, execute, content, generationConfig };
  }
  it("passes source IDs into arrange and semantic content through to layout and persistence", async () => {
    const h = harness();
    const result = JSON.parse((await h.execute()).content);
    expect(result.status).toBe("completed");
    expect(h.dispatch.mock.calls.map(c => c[0].agentId)).toEqual(["slides-planner", "slides-layouter"]);
    expect(h.dispatch.mock.calls[0]![0].input).toMatchObject({ contentMode: "semantic-v3", sources: expect.any(Array) });
    expect(h.dispatch.mock.calls[1]![0].input).toMatchObject({ content: h.content, role: "toc" });
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ draftHash: expect.stringMatching(/^semantic-v3:/), storyboard: expect.objectContaining({ schemaVersion: "storyboard/v3" }) }));
    expect(h.fillPage).toHaveBeenCalledOnce();
  });
  it("fails explicitly when semantic arrange is missing instead of generating a legacy page", async () => {
    const h = harness(true);
    const result = JSON.parse((await h.execute()).content);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("slides_semantic_content_invalid");
    expect(result.contentError).toContain("semantic_content_invalid");
    expect(h.fillPage).not.toHaveBeenCalled();
    expect(h.trash).not.toHaveBeenCalled();
    expect(h.dispatch.mock.calls.some(c => c[0].agentId === "slides-layouter")).toBe(false);
  });
  it("确定性修复：讲稿补回来源原文、数值被模型改错时用来源原文恢复", async () => {
    const draft = { title: "团队", points: ["深度参与大疆0-1以及1-00过程"], notes: "原页说明。" };
    const sources = assignContentSources([draft], "doc");
    const byKind = (kind: string) => sources.find((source) => source.kind === kind)!;
    const content = {
      id: sources[0]!.pageId,
      sourceRefs: sources.map((source) => source.id),
      role: "content",
      message: "团队",
      blocks: [
        { id: "b1", type: "text", text: "团队", sourceRefs: [byKind("title").id], priority: "primary", mustShow: true },
        // 模型把原文 1-00 "顺手改错"为 1-100，引入来源里没有的 100。
        { id: "b2", type: "text", text: "深度参与大疆0-1以及1-100过程", sourceRefs: [byKind("point-1").id], priority: "primary", mustShow: true },
      ],
      relations: [],
      focusRefs: ["b1"],
      constraints: { verbatimRefs: [] },
      notes: "",
      omissions: [{ sourceRef: byKind("notes").id, reason: "版式说明", disposition: "notes" }],
    };
    const result = await assembleSemanticPlan({
      plan: {
        title: "团队",
        contentContext: { mode: SEMANTIC_MODE, revision: 1, sources, sourceHash: semanticHash(sources) },
        pages: [{ title: "团队", density: "standard", role: "content", content }],
      },
      instruction: "",
      roomId: "room",
      repair: async () => { throw new Error("unexpected repair"); },
    });
    expect(result.report.passed).toBe(true);
    const page = result.storyboard.pages[0]!;
    expect(page.notes).toContain(byKind("notes").value);
    const repairedBlock = page.blocks.find((block) => block.id === "b2") as { text?: string };
    expect(repairedBlock.text).toBe(byKind("point-1").value);
    expect(result.report.warnings.some((warning) => warning.includes("数值与来源不符"))).toBe(true);
  });

  it("page 级 role/message + 省略的可选数组在语义校验前被确定性归位", async () => {
    const draft = { title: "封面", points: ["一句话结论"] };
    // semanticFixture 内部用 draft.title 作为 documentId 生成 pageId，来源必须同口径。
    const sources = assignContentSources([draft], draft.title);
    const base = semanticFixture(draft.title, draft.points).page;
    const content = { ...base } as Record<string, unknown>;
    delete content.role;
    delete content.message;
    delete content.relations;
    delete content.focusRefs;
    delete content.constraints;
    delete content.notes;
    delete content.omissions;
    const result = await assembleSemanticPlan({
      plan: {
        title: "封面",
        contentContext: { mode: SEMANTIC_MODE, revision: 1, sources, sourceHash: semanticHash(sources) },
        pages: [{ title: "封面", density: "sparse", role: "cover", message: "一句话结论", content }],
      },
      instruction: "",
      roomId: "room",
      repair: async () => { throw new Error("unexpected repair"); },
    });
    expect(result.report.passed).toBe(true);
    const page = result.storyboard.pages[0]!;
    expect(page.role).toBe("cover");
    expect(page.message).toBe("一句话结论");
    expect(page.relations).toEqual([]);
    expect(page.omissions).toEqual([]);
    expect(page.constraints).toEqual({ verbatimRefs: [] });
    expect(page.notes).toBe("");
    expect(page.focusRefs).toHaveLength(1);
  });

  it("has no legacy fallback: the gateway always arranges with semantic sources", async () => {
    // legacy-v2 链路已删除：无论装配如何，arrange 恒带 contentMode+sources，落页只认语义内容。
    const h = harness();
    await h.execute();
    const arrange = h.dispatch.mock.calls.find(c => c[0].agentId === "slides-planner")![0].input;
    expect(arrange.contentMode).toBe("semantic-v3");
    expect(arrange.sources.length).toBeGreaterThan(0);
    const layout = h.dispatch.mock.calls.find(c => c[0].agentId === "slides-layouter")?.[0].input;
    expect(layout.content).toBeDefined();
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ storyboard: expect.objectContaining({ schemaVersion: "storyboard/v3" }) }));
  });
  it("keeps different model experiments under different persistence keys", async () => {
    const h = harness();
    await h.execute();
    h.generationConfig.mockReturnValue({ model: "model-b" });
    await h.execute();
    expect(h.save.mock.calls[0]![0].draftHash).not.toBe(h.save.mock.calls[1]![0].draftHash);
  });
  it("rejects semantic submit without a tree or without actual content bindings", () => {
    const validate = createSlidesTreeResultValidator();
    const { content } = harness();
    expect(() => validate({ content }, {})).toThrow("缺少布局树");
    expect(() => validate({ content }, { tree: { version: 2, role: "toc", composition: "swiss", nodes: [{ type: "text", token: "h1", text: "其他标题", slot: { col: [1, 12], row: [1, 2] } }] } })).toThrow("content_invalid");
  });
});
