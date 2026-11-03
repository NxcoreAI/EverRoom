import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSlidesLayouterAgentTools, createSlidesTreeResultValidator, LAYOUTER_VALIDATE_TOOL, validateLayoutTree } from "../src/modules/subagents/slides-agent-tools.js";
import { registerDeckLayoutContext, dropDeckLayoutContext, getDeckLayoutContext } from "../src/modules/slides-layout/deck-contract-context.js";
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
    // 语义 content 必填：旧内容模式契约已删除，缺 content 的输入不合法。
    expect(input.required).toContain("content");
    // 旧模式专用字段已从 schema 移除，网关不得再注入。
    for (const legacyField of ["copy", "composition", "form", "skeleton", "units", "emphasis", "intent", "takeaway", "data", "budget", "points", "notes", "neighborSignatures", "title"]) {
      expect(input.properties).not.toHaveProperty(legacyField);
    }
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

describe("布局技能按需加载", () => {
  const skillDir = join(AGENT_DIR, "skills/layout-tree-skill");

  /** SKILL.md「按展示用途选组件」索引行 → { doc, components }。 */
  function categoryIndex(): Array<{ doc: string; components: string[] }> {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const at = skill.indexOf("## 按展示用途选组件");
    const end = skill.indexOf("## Composition 硬约束");
    expect(at).toBeGreaterThan(-1);
    const section = skill.slice(at, end > at ? end : undefined);
    const rows = section.split("\n").filter((line) => line.trim().startsWith("|"));
    return rows.slice(2).map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return {
        doc: (cells[2] ?? "").replace(/`/g, ""),
        components: [...(cells[3] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
      };
    }).filter((row) => row.components.length > 0);
  }

  it("旧模式契约与整册组件参考已删除；设计指引与类别文档存在", () => {
    expect(existsSync(join(skillDir, "legacy.md"))).toBe(false);
    expect(existsSync(join(skillDir, "components.md"))).toBe(false);
    expect(existsSync(join(skillDir, "design-guide.md"))).toBe(true);
    // SYSTEM.md 常驻提示保留「默认采用」规则，并给出按需读取路由。
    const system = readFileSync(join(AGENT_DIR, "SYSTEM.md"), "utf8");
    expect(system).toMatch(/默认采用它承载主内容/);
    expect(system).toMatch(/design-guide\.md/);
    expect(system).not.toMatch(/legacy\.md|旧内容模式/);
  });

  it("组件索引覆盖全部 37 个组件，每个只归属一个类别且类别文档含其参数", () => {
    const categories = categoryIndex();
    expect(categories).toHaveLength(10);
    const owner = new Map<string, string>();
    for (const { doc, components } of categories) {
      expect(doc).toMatch(/^[\w-]+\.md$/);
      const docText = readFileSync(join(skillDir, "components", doc), "utf8");
      for (const name of components) {
        expect(owner.has(name), `${name} 重复出现在 ${owner.get(name)} 与 ${doc}`).toBe(false);
        owner.set(name, doc);
        // 参数行以 | `name` | 出现在该类别文档里。
        expect(docText.includes(`| \`${name}\` |`), `${name} 缺参数行（${doc}）`).toBe(true);
      }
    }
    // 37 = 27 核心 + 10 原子，与权威正文组件清单一致（生成器已做三方一致性校验）。
    expect(owner.size).toBe(37);
    // 类别目录里没有索引之外的孤儿文档。
    const expectedDocs = new Set(categories.map((c) => c.doc));
    expect(readdirSync(join(skillDir, "components")).sort())
      .toEqual([...expectedDocs].sort());
  });

  it("SKILL.md 只留基础语法与索引：不内嵌整套组件参数", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toMatch(/按展示用途选组件/);
    expect(skill).toMatch(/design-guide\.md/);
    // 组件参数明细（如 timeline 的形态描述）留在类别文档里按需读取。
    expect(skill).not.toMatch(/轴线串节点/);
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

  it("提交树几何漂移在校验提交时被拒（validate 好树、重抄改槽位不再漏到落页）", () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const validator = createSlidesTreeResultValidator();
    // h1(40pt) 压进单行 61px：validate 同口径必报 overflow——模型若校验的是宽框版本、
    // 提交时重抄窄了，落页闸才发现就是「校验过了却没落成」。
    const drifted = doneResult();
    drifted.tree = {
      ...pageTree(),
      nodes: [{ type: "text", token: "h1", text: "讲稿测试页", slot: { col: [1, 12], row: [1, 1] } }],
    } as unknown as Record<string, unknown>;
    expect(() => validator({ content, deckToken: token }, drifted)).toThrow(/几何未过/);
    // 无漂移的提交照常通过。
    expect(() => validator({ content, deckToken: token }, doneResult())).not.toThrow();
    dropDeckLayoutContext(token);
  });

  it("树复用对账：validate 缓存通过树，原样提交免复检，漂移提交被点名", async () => {
    registerDeckLayoutContext(token, { contract: contractFromStyleParams(null), imageArs: new Map() });
    const context = getDeckLayoutContext(token)!;
    const validator = createSlidesTreeResultValidator();
    // 经真实 validate 工具走一遍：ok=true 时缓存归一树。
    const outcome = await LAYOUTER_VALIDATE_TOOL.execute({ runId: "run-x" } as never, { token, tree: pageTree() } as never);
    expect(JSON.parse(outcome.content).ok).toBe(true);
    expect(context.lastValidatedTreeJson).toBeTruthy();
    // 原样（含等价省略缺省字段）提交：对账命中，不误拒。
    expect(() => validator({ content, deckToken: token }, doneResult())).not.toThrow();
    // 漂移提交：对账未命中，错误点名「与最后校验通过的树不一致」。
    const drifted = doneResult();
    drifted.tree = {
      ...pageTree(),
      nodes: [{ type: "text", token: "h2", text: "讲稿测试页", slot: { col: [1, 8], row: [1, 2] } }],
    } as unknown as Record<string, unknown>;
    // h2 单行同样放得下（几何本身没问题），对账差异不构成拒收——几何过就放行。
    expect(() => validator({ content, deckToken: token }, drifted)).not.toThrow();
    // 几何也坏的漂移：拒收且信息指向原样重交。
    const driftedBad = doneResult();
    driftedBad.tree = {
      ...pageTree(),
      nodes: [{ type: "text", token: "h1", text: "讲稿测试页", slot: { col: [1, 8], row: [1, 1] } }],
    } as unknown as Record<string, unknown>;
    expect(() => validator({ content, deckToken: token }, driftedBad)).toThrow(/与最后校验通过的树不一致/);
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
