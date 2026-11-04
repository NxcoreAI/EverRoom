import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { assignContentSources, checkSemanticStoryboard, semanticHash, SEMANTIC_PAGE_SCHEMA } from "../src/modules/subagents/slides-semantic-contract.js";
import { checkSemanticBindings, checkSemanticRendered } from "../src/modules/subagents/slides-semantic-bindings.js";
import { assembleSemanticPlan } from "../src/modules/subagents/slides-semantic-stage.js";
import { parseDraftMarkdown, renderDraftMarkdown } from "../src/modules/subagents/slides-draft-doc.js";
import { decidePageImages } from "../src/modules/subagents/slides-page-images-stage.js";
import { semanticCases, semanticDrafts } from "./fixtures/slides-semantic.js";

describe("semantic content contract", () => {
  it.each(semanticCases)("validates $name without inferring a form", ({ page, sources }) => {
    expect(checkSemanticStoryboard([page], sources)).toMatchObject({ passed: true, errors: [] });
  });
  it("preserves distinct relationships for equally sized point lists", () => {
    expect(semanticCases[0]!.page.blocks).toHaveLength(semanticCases[1]!.page.blocks.length);
    expect(semanticCases[0]!.page.relations[0]!.type).toBe("parallel");
    expect(semanticCases[1]!.page.relations[0]!.type).toBe("compares");
  });
  it("pins stable source IDs to the confirmed snapshot and invalidates edited sources", () => {
    const draft = semanticDrafts[0]!.pages;
    expect(assignContentSources(draft, "doc")).toEqual(assignContentSources(draft, "doc"));
    expect(assignContentSources([{ ...draft[0], title: "Changed" }], "doc")[0]!.id).not.toBe(assignContentSources(draft, "doc")[0]!.id);
  });
  it.each(semanticDrafts)("preserves the complete evaluation draft including multiline data: $name", draft => {
    const pages = parseDraftMarkdown(renderDraftMarkdown({ title: draft.name, pages: draft.pages }), { preserveContent: true });
    expect(pages).toEqual(draft.pages);
  });
  it("keeps long confirmed drafts without truncating points or data", () => {
    const points = Array.from({ length: 12 }, () => "long content ".repeat(40));
    const pages = parseDraftMarkdown(`## Title\n${points.map(p => `- ${p}`).join("\n")}\n数据：${"9 ".repeat(1200)}`, { preserveContent: true })!;
    expect(pages[0]!.points).toEqual(points.map(s => s.trim()));
    expect(pages[0]!.data!.length).toBeGreaterThan(2000);
  });
  it.each(["source", "relation", "omission", "numbers", "quote", "order"])("rejects invalid %s", defect => {
    const fixture = structuredClone(semanticCases[defect === "quote" ? 11 : 1]!);
    const { page } = fixture;
    if (defect === "source") page.blocks[0]!.sourceRefs = ["unknown"];
    if (defect === "relation") page.relations[0]!.refs = ["missing", "block-1"];
    if (defect === "omission") { page.blocks.pop(); page.omissions.push({ sourceRef: fixture.sources.at(-1)!.id, reason: "too long", disposition: "omitted" }); }
    if (defect === "numbers") Object.assign(page.blocks[1]!, { text: "交付时间为 999 天" });
    if (defect === "quote") Object.assign(page.blocks[1]!, { text: "改变了引用" });
    if (defect === "order") page.id = "changed";
    expect(checkSemanticStoryboard([page], fixture.sources).passed).toBe(false);
  });
  it("verbatimRefs tolerate wrapping quotes on the source value", () => {
    const draft = { title: "愿景", points: ['"从敦煌飞天到莱特破云，飞行始终是人类文明的终极浪漫"'] };
    const sources = assignContentSources([draft], "doc");
    const title = sources.find((source) => source.kind === "title")!;
    const quote = sources.find((source) => source.kind === "point-1")!;
    const page = {
      id: sources[0]!.pageId,
      sourceRefs: sources.map((source) => source.id),
      role: "content" as const,
      message: "愿景",
      blocks: [
        { id: "b-title", type: "text" as const, text: title.value, sourceRefs: [title.id], priority: "primary" as const, mustShow: true },
        { id: "b-quote", type: "quotation" as const, text: "从敦煌飞天到莱特破云，飞行始终是人类文明的终极浪漫", sourceRefs: [quote.id], priority: "primary" as const, mustShow: true },
      ],
      relations: [],
      focusRefs: ["b-title"],
      constraints: { verbatimRefs: [quote.id] },
      notes: "",
      omissions: [],
    };
    expect(checkSemanticStoryboard([page], sources)).toMatchObject({ passed: true, errors: [] });
  });

  it("citation links are annotations, not slide content: URL numbers and date-range hyphens are ignored", () => {
    const draft = {
      title: "团队",
      data: "任职 2012-2014 年，CAAC 委任工程代表（全国不超过 1000 人）^[Nexwing_BP](everroom://room/x?preview=999-88)",
    };
    const sources = assignContentSources([draft], "doc");
    const title = sources.find((source) => source.kind === "title")!;
    const data = sources.find((source) => source.kind === "data")!;
    expect(data.value).not.toContain("everroom://");
    expect(data.value).not.toContain("999");
    const page = {
      id: sources[0]!.pageId,
      sourceRefs: sources.map((source) => source.id),
      role: "content" as const,
      message: "团队",
      blocks: [
        { id: "b-title", type: "text" as const, text: title.value, sourceRefs: [title.id], priority: "primary" as const, mustShow: true },
        { id: "b-range", type: "text" as const, text: "任职 2012–2014 年", sourceRefs: [data.id], priority: "primary" as const, mustShow: true },
        { id: "b-people", type: "text" as const, text: "全国不超过 1000 人", sourceRefs: [data.id], priority: "supporting" as const, mustShow: true },
      ],
      relations: [],
      focusRefs: ["b-title"],
      constraints: { verbatimRefs: [] },
      notes: "",
      omissions: [],
    };
    expect(checkSemanticStoryboard([page], sources)).toMatchObject({ passed: true, errors: [] });
  });

  it("requires all confirmed numeric data, including values not selected as the focus", () => {
    const fixture = structuredClone(semanticCases[6]!);
    (fixture.page.blocks[1] as any).rows.pop();
    expect(checkSemanticStoryboard([fixture.page], fixture.sources).errors.join(" ")).toContain("数据缺失");
  });
  it("rejects a changed metric unit even if the number is unchanged", () => {
    const fixture = structuredClone(semanticCases[7]!);
    (fixture.page.blocks[1] as any).unit = "小时";
    expect(checkSemanticStoryboard([fixture.page], fixture.sources).errors.join(" ")).toContain("单位不符");
  });
  it("generated agent schemas share the authoritative page schema", () => {
    const schema = (agent: string, direction: string) => JSON.parse(readFileSync(resolve("../../agents", agent, "schemas", `${direction}.schema.json`), "utf8"));
    const authoritative = JSON.parse(JSON.stringify(SEMANTIC_PAGE_SCHEMA)) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    // planner 的 submit schema 故意放宽 optional 字段：模型常省略空数组/把 role/message
    // 写在 page 级（2026-10-23 实测 submit 反复失败）；网关归位后再用权威 schema 严格校验。
    // 字段定义必须与权威 schema 完全一致，必填项只能是权威必填的子集。
    const plannerContent = schema("slides-planner", "output").properties.pages.items.properties.content as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(JSON.parse(JSON.stringify(plannerContent.properties))).toEqual(authoritative.properties);
    expect(plannerContent.required ?? []).toEqual(
      (plannerContent.required ?? []).filter((field) => authoritative.required.includes(field)),
    );
    expect(plannerContent.required).not.toContain("role");
    expect(schema("slides-layouter", "input").properties.content).toEqual(JSON.parse(JSON.stringify(SEMANTIC_PAGE_SCHEMA)));
    expect(schema("slides-editor", "output").properties.pages.items).toEqual(JSON.parse(JSON.stringify(SEMANTIC_PAGE_SCHEMA)));
    const ajv = new Ajv({ strict: false });
    for (const agent of ["slides-planner", "slides-editor", "slides-layouter"]) for (const direction of ["input", "output"]) expect(() => ajv.compile(schema(agent, direction))).not.toThrow();
  });
  it("planner submit schema tolerates page-level role/message and omitted optional arrays", () => {
    const schema = JSON.parse(readFileSync(resolve("../../agents", "slides-planner", "schemas", "output.schema.json"), "utf8"));
    const validate = new Ajv({ strict: false }).compile(schema);
    const content = structuredClone(semanticCases[0]!.page) as unknown as Record<string, unknown>;
    for (const field of ["role", "message", "relations", "focusRefs", "constraints", "notes", "omissions"]) delete content[field];
    expect(validate({
      phase: "arrange",
      title: "标题",
      summary: "完成",
      pages: [{ title: "页面", density: "sparse", role: "content", message: "页面结论", content }],
    })).toBe(true);
    // 精简 schema 后仍保留 arrange 的页级必填：density/content 缺一不可。
    expect(validate({
      phase: "arrange",
      title: "标题",
      summary: "完成",
      pages: [{ title: "页面", content }],
    })).toBe(false);
    expect(validate({
      phase: "arrange",
      title: "标题",
      summary: "完成",
      pages: [{ title: "页面", density: "sparse" }],
    })).toBe(false);
    // draft 只要求 title：points/data/notes 均为可选。
    expect(validate({
      phase: "draft",
      title: "标题",
      summary: "完成",
      pages: [{ title: "封面", points: ["一句话"] }, { title: "数据页", data: "营收 1 亿" }],
    })).toBe(true);
    expect(validate({
      phase: "draft",
      title: "标题",
      summary: "完成",
      pages: [{ points: ["缺少标题"] }],
    })).toBe(false);
  });

  it("accepts full semantic drafts and enforces semantic arrange/repair input", () => {
    const ajv = new Ajv({ strict: false });
    const schema = (agent: string) => JSON.parse(readFileSync(resolve("../../agents", agent, "schemas/input.schema.json"), "utf8"));
    const validate = ajv.compile(schema("slides-planner"));
    const draftPages = [{ title: "标题", points: Array(12).fill("完整内容") }];
    // draft 阶段不带语义字段：宽松 draftPages 合法。
    expect(validate({ instruction: "生成", roomId: "room", phase: "draft", draftPages })).toBe(true);
    // 网关预取的文档正文随 draft 输入下发（sourceDocuments），必须过输入 schema。
    expect(validate({
      instruction: "生成",
      roomId: "room",
      phase: "draft",
      sourceDocuments: [{
        documentId: "doc-1",
        title: "27 页大纲",
        version: 2,
        markdown: "## 封面\n- 标题",
        markdownTotalCharacters: 2,
      }],
    })).toBe(true);
    expect(validate({
      instruction: "生成",
      roomId: "room",
      phase: "draft",
      sourceDocuments: [{ documentId: "doc-1", title: "x", version: 2 }],
    })).toBe(false);
    // arrange 阶段必带 contentMode+sources（唯一内容路径，无回退）。
    expect(validate({ instruction: "生成", roomId: "room", phase: "arrange", draftPages })).toBe(false);
    expect(validate({ instruction: "生成", roomId: "room", phase: "arrange", draftPages, contentMode: "semantic-v3", sources: assignContentSources(draftPages, "d") })).toBe(true);
    const editor = ajv.compile(schema("slides-editor"));
    // 修复器没有可选模式：缺语义字段一律拒绝。
    expect(editor({ instruction: "修复", roomId: "r", draftPages: [] })).toBe(false);
  });
  it("exposes Editor tool argument properties to providers and still validates the selected version", () => {
    const schema = JSON.parse(readFileSync(resolve("../../agents/slides-editor/schemas/output.schema.json"), "utf8"));
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["schemaVersion", "pages"]));
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate({ schemaVersion: "storyboard/v3", pages: [semanticCases[0]!.page] })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ schemaVersion: "storyboard/v2", pages: [semanticCases[0]!.page] })).toBe(false);
    expect(validate({ schemaVersion: "storyboard/v3", pages: Array(5).fill(semanticCases[0]!.page) })).toBe(false);
  });
});

describe("content bindings", () => {
  const page = semanticCases[0]!.page;
  const tree = () => ({ nodes: page.blocks.map(b => ({ type: "text", text: (b as any).text })) });
  const result = { designIntent: "标题引导，两项收益保持并列", bindings: page.blocks.map((b, i) => ({ blockId: b.id, paths: [`nodes/${i}`] })) };
  it("accepts actual payload bindings", () => expect(checkSemanticBindings(page, tree(), result)).toEqual([]));
  it("rejects fabricated paths and declaration-only coverage", () => {
    const fake = tree(); fake.nodes[1]!.text = "其他内容";
    expect(checkSemanticBindings(page, fake, result).join(" ")).toContain("载荷缺失");
    expect(checkSemanticBindings(page, { nodes: [] }, result).join(" ")).toContain("路径不存在");
  });
  it("cannot prove coverage with notes or component names", () => {
    const fake = { nodes: [{ type: "shape", notes: "并列收益部署更快维护更简单", name: "并列收益部署更快维护更简单" }] };
    expect(checkSemanticBindings(page, fake, result).length).toBeGreaterThan(0);
  });
  it("checks compiled payload after component expansion", () => {
    expect(checkSemanticRendered(page, { elements: [{ type: "text", text: page.message }] }).join(" ")).toContain("必留内容缺失");
  });
  it("accepts comparison and quotation component payloads beyond pointList fields", () => {
    const t = { nodes: [{ type: "text", text: page.message }, { type: "component", name: "comparison", sides: [{ title: "收益", points: ["部署更快", "维护更简单"] }] }] };
    const r = { designIntent: "并列表达", bindings: [{ blockId: "block-0", paths: ["nodes/0"] }, { blockId: "block-1", paths: ["nodes/1"] }, { blockId: "block-2", paths: ["nodes/1"] }] };
    expect(checkSemanticBindings(page, t, r)).toEqual([]);
    const quote = structuredClone(semanticCases[11]!.page);
    (quote.blocks[1] as any).attribution = "产品团队";
    expect(checkSemanticBindings(quote, { nodes: [{ type: "text", text: quote.message }, { type: "component", name: "quote", text: "质量是产品的一部分。", author: "产品团队" }] }, {
      designIntent: "原文与作者", bindings: quote.blocks.map((b, i) => ({ blockId: b.id, paths: [`nodes/${i}`] })),
    })).toEqual([]);
  });
  it("preserves table cell associations, not just the set of numbers", () => {
    const tablePage = semanticCases[6]!.page;
    const table = tablePage.blocks[1] as any;
    const t = { nodes: [{ type: "text", text: tablePage.message }, { type: "table", rows: [table.headers, ...table.rows].map((r: any[]) => r.map(text => ({ text: String(text) }))) }] };
    const r = { designIntent: "完整表格", bindings: tablePage.blocks.map((b, i) => ({ blockId: b.id, paths: [`nodes/${i}`] })) };
    expect(checkSemanticBindings(tablePage, t, r)).toEqual([]);
    t.nodes[1]!.rows![1]!.reverse();
    expect(checkSemanticBindings(tablePage, t, r).join(" ")).toContain("顺序改变");
  });
});

describe("semantic assembly", () => {
  const fixture = semanticCases[0]!;
  const plan = () => ({ title: "Deck", contentContext: { mode: "semantic-v3", revision: 1, sources: fixture.sources, sourceHash: semanticHash(fixture.sources) }, pages: [{ title: fixture.page.message, content: structuredClone(fixture.page) }] });
  it("assembles without a second understanding invocation or a deterministic skeleton", async () => {
    const repair = vi.fn();
    const result = await assembleSemanticPlan({ plan: plan(), instruction: "讲清收益", roomId: "room", repair });
    expect(repair).not.toHaveBeenCalled();
    expect(result.storyboard.schemaVersion).toBe("storyboard/v3");
    expect((result.plan.pages as any[])[0]).not.toHaveProperty("skeleton");
    expect(result.draftHash).toMatch(/^semantic-v3:/);
  });
  it("bounds repair to two rounds and never falls back to form mapping", async () => {
    const input = plan(); input.pages[0]!.content.blocks = [];
    const repair = vi.fn(async () => ({ status: "completed", result: { structuredOutput: { schemaVersion: "storyboard/v3", pages: [] } } }) as any);
    await expect(assembleSemanticPlan({ plan: input, instruction: "修复", roomId: "r", repair })).rejects.toThrow("semantic_content_invalid");
    expect(repair).toHaveBeenCalledTimes(2);
  });
  it("canonicalizes an invented page ID only when all provenance belongs to its confirmed position", async () => {
    const input = plan(); input.pages[0]!.content.id = "page-1-content";
    const repair = vi.fn();
    const result = await assembleSemanticPlan({ plan: input, instruction: "生成", roomId: "r", repair });
    expect(result.storyboard.pages[0]!.id).toBe(fixture.page.id);
    expect(result.report.warnings).toHaveLength(1);
    expect(repair).not.toHaveBeenCalled();
    expect(input.pages[0]!.content.id).toBe("page-1-content");
  });
  it("does not canonicalize an invented identity with unknown block provenance", async () => {
    const input = plan(); input.pages[0]!.content.id = "invented";
    input.pages[0]!.content.blocks[0]!.sourceRefs = ["unknown"];
    const repair = vi.fn(async (_input: Record<string, any>) => ({ status: "failed" }) as any);
    await expect(assembleSemanticPlan({ plan: input, instruction: "修复", roomId: "r", repair })).rejects.toThrow("semantic_content_invalid");
    expect(repair.mock.calls[0]![0].priorStoryboard.pages[0].id).toBe("invented");
  });
  it("scopes feedback and sources to four pages and repairs all eight within two rounds", async () => {
    const sources = assignContentSources(Array.from({ length: 8 }, () => fixture.draft), "draft");
    const sourceIds = [...new Set(sources.map(s => s.pageId))];
    const valid = sourceIds.map(id => {
      const refs = sources.filter(s => s.pageId === id).map(s => s.id);
      return { ...structuredClone(fixture.page), id, sourceRefs: refs, blocks: fixture.page.blocks.map((b, i) => ({ ...b, sourceRefs: [refs[i]!] })) };
    });
    const pages = structuredClone(valid); pages.forEach(p => { p.blocks = []; });
    const repair = vi.fn(async (input: Record<string, any>) => {
      const ids = input.repairPageIds as string[];
      expect(input.sources.every((s: any) => ids.includes(s.pageId))).toBe(true);
      expect(ids.every(id => input.defects.some((d: string) => d.startsWith(`[${id}]`)))).toBe(true);
      expect(input.defects).toHaveLength(12);
      return { status: "completed", result: { structuredOutput: { schemaVersion: "storyboard/v3", pages: valid.filter(p => ids.includes(p.id)) } } } as any;
    });
    await assembleSemanticPlan({ plan: { title: "Deck", pages: pages.map(content => ({ content })), contentContext: { mode: "semantic-v3", revision: 1, sources, sourceHash: semanticHash(sources) } }, instruction: "修复", roomId: "r", repair });
    expect(repair.mock.calls.map(([input]) => input.repairPageIds)).toEqual([sourceIds.slice(0, 4), sourceIds.slice(4)]);
  });
  it("rejects reordered known identities instead of silently rewriting them", async () => {
    const sources = assignContentSources([fixture.draft, fixture.draft], "draft");
    const sourceIds = [...new Set(sources.map(s => s.pageId))];
    const pages = sourceIds.map(id => {
      const refs = sources.filter(s => s.pageId === id).map(s => s.id);
      return { ...structuredClone(fixture.page), id, sourceRefs: refs, blocks: fixture.page.blocks.map((b, i) => ({ ...b, sourceRefs: [refs[i]!] })) };
    }).reverse();
    const repair = vi.fn(async (_input: Record<string, any>) => ({ status: "failed" }) as any);
    await expect(assembleSemanticPlan({ plan: { title: "Deck", pages: pages.map(content => ({ content })), contentContext: { mode: "semantic-v3", revision: 1, sources, sourceHash: semanticHash(sources) } }, instruction: "修复", roomId: "r", repair })).rejects.toThrow("semantic_content_invalid");
    expect(repair.mock.calls[0]![0].priorStoryboard.pages.map((p: any) => p.id)).toEqual([...sourceIds].reverse());
  });
  it("accepts a named-page repair and pins persisted mode across restart", async () => {
    const input = plan(); input.pages[0]!.content.blocks = [];
    const repair = vi.fn(async () => ({ status: "completed", result: { structuredOutput: { schemaVersion: "storyboard/v3", pages: [fixture.page, { ...fixture.page, id: "outside-scope" }] } } }) as any);
    const result = await assembleSemanticPlan({ plan: JSON.parse(JSON.stringify(input)), instruction: "修复", roomId: "r", repair });
    expect(result.storyboard.pages).toEqual([fixture.page]);
    expect(repair).toHaveBeenCalledTimes(1);
  });
  it("retains the saved contract when image confirmation resumes without images", async () => {
    const saved = plan();
    const session = { id: "images", roomId: "r", draftDocumentId: "d", stage: "confirm", plan: JSON.parse(JSON.stringify(saved)), pages: [] };
    const outcome = await decidePageImages({ roomId: "r", draftDocumentId: "d", decision: "skip" }, { sessions: { byDraftId: () => session } as any, images: {} as any });
    expect(outcome.kind).toBe("build");
    if (outcome.kind === "build") {
      expect(outcome.plan.contentContext).toEqual(saved.contentContext);
      expect((await assembleSemanticPlan({ plan: outcome.plan, instruction: "keep", roomId: "r", repair: vi.fn() })).report.passed).toBe(true);
    }
  });
  it("targets later-page defects instead of spending repair budget on the first four pages", async () => {
    const sources = assignContentSources(Array.from({ length: 8 }, () => fixture.draft), "draft");
    const sourceIds = [...new Set(sources.map(s => s.pageId))];
    const valid = sourceIds.map(id => {
      const refs = sources.filter(s => s.pageId === id).map(s => s.id);
      return { ...structuredClone(fixture.page), id, sourceRefs: refs, blocks: fixture.page.blocks.map((b, i) => ({ ...b, sourceRefs: [refs[i]!] })) };
    });
    const pages = structuredClone(valid); pages[7]!.blocks.pop();
    const repair = vi.fn(async (_input: Record<string, unknown>) => ({ status: "completed", result: { structuredOutput: { schemaVersion: "storyboard/v3", pages: [valid[7]] } } }) as any);
    await assembleSemanticPlan({ plan: { title: "Deck", pages: pages.map(content => ({ content })), contentContext: { mode: "semantic-v3", revision: 1, sources, sourceHash: semanticHash(sources) } }, instruction: "修复", roomId: "r", repair });
    expect(repair.mock.calls[0]![0].repairPageIds).toEqual([sourceIds[7]]);
  });
});
