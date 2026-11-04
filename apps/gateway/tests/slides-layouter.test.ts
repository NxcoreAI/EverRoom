import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlidesLayouterAgentTools, createSlidesTreeResultValidator, validateLayoutTree } from "../src/modules/subagents/slides-agent-tools.js";
import { registerDeckLayoutContext, dropDeckLayoutContext } from "../src/modules/slides-layout/deck-contract-context.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";
import type { SemanticPage } from "../src/modules/subagents/slides-semantic-contract.js";

const AGENT_DIR = join(import.meta.dirname, "../../../agents/slides-layouter");

const GOOD_PAGE = {
  version: 2,
  role: "content",
  composition: "editorial",
  nodes: [
    { type: "image", url: "https://example.com/craft.jpg", slot: { col: [1, 6], row: [1, 8] } },
    { type: "text", token: "h1", text: "四段低温萃取", slot: { col: [7, 12], row: [1, 2] } },
    {
      type: "component",
      name: "pointList",
      items: [{ label: "冷萃", body: "全程 8℃ 以下" }, { label: "锁香", body: "锁住茶氨酸" }],
      slot: { col: [7, 12], row: [3, 6] },
    },
    { type: "text", token: "caption", text: "来源：工艺手册", slot: { col: [7, 12], row: [7, 7] } },
  ],
};

describe("validateLayoutTree", () => {
  const token = "test-deck-token-0001";

  it("未注册 token 报 schema 缺陷", () => {
    const outcome = validateLayoutTree("nope", GOOD_PAGE);
    expect(outcome.ok).toBe(false);
    expect(outcome.defects[0]!.type).toBe("schema");
    expect(outcome.defects[0]!.detail).toMatch(/token 未注册/);
  });

  it("注册契约后好树 ok=true", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, GOOD_PAGE);
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(true);
    expect(outcome.defects).toEqual([]);
    expect(outcome.stats.elements).toBeGreaterThan(3);
  });

  it("结构坏树转 schema 缺陷并保留自纠文案", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, { direction: "row", children: [{ foo: 1 }] });
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(false);
    expect(outcome.defects[0]!.type).toBe("schema");
    expect(outcome.defects[0]!.detail).toMatch(/V2_INVALID|LAYOUT_TREE_INVALID|version/);
  });

  it("溢出树转 overflow 缺陷带 hint", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, {
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{ type: "text", token: "body", text: "内容很长".repeat(400), slot: { col: [1, 3], row: [1, 2] } }],
    });
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(false);
    expect(outcome.defects.some((d) => d.type === "overflow")).toBe(true);
    expect(outcome.defects.find((d) => d.type === "overflow")!.hint.length).toBeGreaterThan(4);
  });
});

describe("slides-layouter 工具面", () => {
  it("工具面只剩确定性校验（预览工具已摘除，视觉自审由网关回投渲染图完成）", async () => {
    const tools = createSlidesLayouterAgentTools();
    expect(tools.map((t) => t.name)).toEqual(["slides_layout_validate"]);
    const token = "tool-deck-token-0002";
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const result = await tools[0]!.execute({} as never, { token, tree: GOOD_PAGE });
    dropDeckLayoutContext(token);
    expect(JSON.parse(result.content).ok).toBe(true);
  });
});

describe("slides-layouter agent 包完整性", () => {
  it("agent.yaml 声明技能与输入输出 schema", () => {
    const yaml = readFileSync(join(AGENT_DIR, "agent.yaml"), "utf8");
    expect(yaml).toMatch(/^id: slides-layouter$/m);
    expect(yaml).toMatch(/mode: dispatch_only/);
    expect(yaml).toMatch(/^\s+- \.\/skills\/layout-tree-skill$/m);
    expect(yaml).toMatch(/inputSchema: \.\/schemas\/input\.schema\.json/);
    expect(yaml).toMatch(/outputSchema: \.\/schemas\/output\.schema\.json/);
  });

  it("两份 schema 是合法 JSON 且必填齐备", () => {
    const input = JSON.parse(readFileSync(join(AGENT_DIR, "schemas/input.schema.json"), "utf8"));
    const output = JSON.parse(readFileSync(join(AGENT_DIR, "schemas/output.schema.json"), "utf8"));
    expect(input.required).toContain("deckToken");
    // blocked 分支是无解页的出口（内容契约连续失败后由 validator 引导到这里），必须合法且不带 tree。
    const branches = output.oneOf as Array<{ properties: { status: { const: string } }; required: string[] }>;
    expect(output.required).toEqual(["status"]);
    expect(branches.find(b => b.properties.status.const === "done")!.required).toContain("tree");
    expect(branches.find(b => b.properties.status.const === "blocked")!.required)
      .toEqual(expect.arrayContaining(["reason", "attempts", "requestedAction"]));
  });

  it("SKILL.md 带 frontmatter（缺 --- 会被注册器整包拒绝）", () => {
    const skill = readFileSync(join(AGENT_DIR, "skills/layout-tree-skill/SKILL.md"), "utf8");
    expect(/^---\r?\n[\s\S]*?\r?\n---/.test(skill)).toBe(true);
    expect(skill).toMatch(/^name: layout-tree-skill$/m);
  });
});

describe("技能语法示例与网关归一一致", () => {
  it("SKILL.md 的 hero-data 示例通过归一与校验", () => {
    const skill = readFileSync(join(AGENT_DIR, "skills/layout-tree-skill/SKILL.md"), "utf8");
    const section = skill.slice(skill.indexOf("## 示例（hero-data）"));
    const block = section.slice(section.indexOf("```json") + "```json".length, section.indexOf("```", section.indexOf("```json") + 3));
    const example = JSON.parse(block);
    const token = "skill-grammar-token-003";
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, example);
    dropDeckLayoutContext(token);
    expect(outcome.defects).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it("v1 树在校验阶段就被拒（布局只有 v2 一种格式）", () => {
    const token = "v1-reject-token-004";
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, {
      role: "content",
      direction: "row",
      children: [{ type: "text", variant: "body", text: "v1 语法" }],
    });
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(false);
    expect(outcome.defects[0]!.detail).toMatch(/v1 树/);
  });

  it("必留文本里的「→」不再被误判 emoji（2026-10-24 落页死锁）", () => {
    const token = "arrow-token-005";
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, {
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{ type: "text", token: "h1", text: "Road／Gravel → XC／MTB／Folding", slot: { col: [1, 12], row: [1, 2] } }],
    });
    dropDeckLayoutContext(token);
    expect(outcome.defects.filter((d) => d.type === "emoji")).toEqual([]);
  });
});

describe("slides-layouter 提交期内容契约", () => {
  const token = "validator-notes-token-006";
  const content: SemanticPage = {
    id: "page-1",
    sourceRefs: ["source-1"],
    role: "content",
    message: "讲稿测试页",
    blocks: [{
      id: "b1", sourceRefs: ["source-1"], priority: "primary", mustShow: true,
      type: "text", text: "讲稿测试页",
    }],
    relations: [],
    focusRefs: ["source-1"],
    constraints: { verbatimRefs: [] },
    notes: "这是讲稿原文。",
    omissions: [],
  };
  const pageTree = () => ({
    version: 2 as const,
    role: "content",
    composition: "swiss",
    nodes: [{ type: "text", token: "h1", text: "讲稿测试页", slot: { col: [1, 8], row: [1, 2] } }],
  });
  const doneResult = () => ({
    status: "done",
    tree: pageTree() as Record<string, unknown>,
    notes: "交付完成",
    designIntent: "单标题页",
    bindings: [{ blockId: "b1", paths: ["nodes/0"] }],
  });

  it("讲稿以 content.notes 为准：模型改写/追加会被纠正而不是永久拒收", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const validator = createSlidesTreeResultValidator();
    const submitted = doneResult();
    submitted.tree.notes = "这是讲稿原文，标注为改写版。";
    expect(() => validator({ content, deckToken: token }, submitted)).not.toThrow();
    expect(submitted.tree.notes).toBe(content.notes);
    dropDeckLayoutContext(token);
  });

  it("连续 3 次内容契约未通过后收口为 blocked，不再无限重交", () => {
    const validator = createSlidesTreeResultValidator();
    const invocationInput = { content, deckToken: token };
    const bad = () => {
      const submitted = doneResult();
      // message 未展示：绑定路径指向的节点文本与页面 message 不符
      submitted.tree = { ...pageTree(), nodes: [{ type: "text", token: "h1", text: "别的标题", slot: { col: [1, 8], row: [1, 2] } }] } as unknown as Record<string, unknown>;
      return submitted;
    };
    expect(() => validator(invocationInput, bad())).toThrow(/subagent_result_content_invalid/);
    expect(() => validator(invocationInput, bad())).toThrow(/subagent_result_content_invalid/);
    expect(() => validator(invocationInput, bad())).toThrow(/subagent_result_content_unrecoverable.*blocked/s);
  });
});
