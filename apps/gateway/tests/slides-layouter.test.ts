import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlidesLayouterAgentTools, validateLayoutTree } from "../src/modules/subagents/slides-agent-tools.js";
import { registerDeckLayoutContext, dropDeckLayoutContext } from "../src/modules/slides-layout/deck-contract-context.js";
import { contractFromStyleParams } from "../src/modules/slides-layout/tree/layout-contract.js";

const AGENT_DIR = join(import.meta.dirname, "../../../agents/slides-layouter");

const GOOD_TREE = {
  role: "content",
  title: "冷萃工艺保留茶香本味",
  direction: "row",
  weights: [1.6, 1],
  children: [
    { type: "image", url: "https://example.com/craft.jpg" },
    {
      direction: "column",
      gapScale: 1.5,
      children: [
        { type: "text", variant: "heading", text: "四段低温萃取" },
        { type: "text", variant: "body", text: "全程 8℃ 以下冷萃 12 小时\n锁住茶氨酸与芳香物质", bullet: true },
      ],
    },
  ],
};

describe("validateLayoutTree", () => {
  const token = "test-deck-token-0001";

  it("未注册 token 报 schema 缺陷", () => {
    const outcome = validateLayoutTree("nope", GOOD_TREE);
    expect(outcome.ok).toBe(false);
    expect(outcome.defects[0]!.type).toBe("schema");
    expect(outcome.defects[0]!.detail).toMatch(/token 未注册/);
  });

  it("注册契约后好树 ok=true", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, GOOD_TREE);
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(true);
    expect(outcome.defects).toEqual([]);
    expect(outcome.stats.leaves).toBe(3);
  });

  it("结构坏树转 schema 缺陷并保留自纠文案", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, { direction: "row", children: [{ foo: 1 }] });
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(false);
    expect(outcome.defects[0]!.type).toBe("schema");
    expect(outcome.defects[0]!.detail).toMatch(/LAYOUT_TREE_INVALID/);
  });

  it("溢出树转 overflow 缺陷带 hint", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, {
      direction: "column",
      children: [{ type: "text", variant: "body", text: "内容很长".repeat(400) }],
    });
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(false);
    expect(outcome.defects.some((d) => d.type === "overflow")).toBe(true);
    expect(outcome.defects.find((d) => d.type === "overflow")!.hint.length).toBeGreaterThan(4);
  });
});

describe("slides-layouter 工具面", () => {
  it("工具面只有 slides_layout_validate 且执行返回 JSON", async () => {
    const tools = createSlidesLayouterAgentTools();
    expect(tools.map((t) => t.name)).toEqual(["slides_layout_validate"]);
    const token = "tool-deck-token-0002";
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const result = await tools[0]!.execute({} as never, { token, tree: GOOD_TREE });
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
    expect(output.required).toEqual(["status", "tree"]);
  });

  it("SKILL.md 带 frontmatter（缺 --- 会被注册器整包拒绝）", () => {
    const skill = readFileSync(join(AGENT_DIR, "skills/layout-tree-skill/SKILL.md"), "utf8");
    expect(/^---\r?\n[\s\S]*?\r?\n---/.test(skill)).toBe(true);
    expect(skill).toMatch(/^name: layout-tree-skill$/m);
  });
});

describe("技能语法示例与网关归一一致", () => {
  it("SKILL.md 的根节点示例通过归一与校验", () => {
    const token = "skill-grammar-token-003";
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const outcome = validateLayoutTree(token, {
      role: "content",
      title: "页标题（进固定标题带）",
      dark: false,
      direction: "row",
      weights: [1.6, 1],
      gapScale: 1.5,
      pad: 16,
      children: GOOD_TREE.children,
    });
    dropDeckLayoutContext(token);
    expect(outcome.ok).toBe(true);
  });
});
