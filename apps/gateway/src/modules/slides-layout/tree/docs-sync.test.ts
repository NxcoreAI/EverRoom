import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPONENT_NAMES } from "./components/index.js";

/**
 * 文档漂移守卫：权威正文（docs/slides-layout-tree-spec.zh-CN.md）里的组件名集合
 * 必须与引擎 COMPONENT_NAMES 逐字一致。
 *
 * 组件名在文档里有两处机械可读的表：
 * - `## 组件清单`：37 个名字的完整清单（漏一个、多一个都算漂移）
 * - `## 组件参数`：每个名字都有一行参数说明（名字在集合里但没参数行，也算漏）
 * 两处都按「表格首列是一个反引号包起来的标识符」解析。
 */
const SPEC_PATH = join(__dirname, "../../../../../../docs/slides-layout-tree-spec.zh-CN.md");

function readSpec(): string {
  return readFileSync(SPEC_PATH, "utf8");
}

/** 取 `## <heading>` 之后的正文，到下一个二级标题为止。 */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`权威正文缺少「## ${heading}」小节`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** 表格首列是 `name` 的行 → 名字列表。 */
function firstColumnNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/.exec(line.trim());
    if (match) names.push(match[1]!);
  }
  return names;
}

/** 用途分类表的组件列（第 3 列，「文档」列之后）里的全部反引号名；条件列的提及不计入。 */
function purposeColumnNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|");
    const componentCell = cells[3] ?? "";
    for (const match of componentCell.matchAll(/`([A-Za-z][A-Za-z0-9]*)`/gu)) {
      names.push(match[1]!);
    }
  }
  return names;
}

const ENGINE_NAMES = [...COMPONENT_NAMES].sort();

describe("布局语法文档与引擎组件清单同步", () => {
  it("组件清单恰好覆盖 COMPONENT_NAMES：无遗漏、无引擎外名字", () => {
    const listed = firstColumnNames(section(readSpec(), "组件清单"));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.sort()).toEqual(ENGINE_NAMES);
  });

  it("组件参数表逐个给出参数：不多不少", () => {
    const documented = firstColumnNames(section(readSpec(), "组件参数"));
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(ENGINE_NAMES);
  });

  it("清单数量与引擎一致（27 核心 + 10 原子 = 37）", () => {
    expect(ENGINE_NAMES).toHaveLength(37);
  });

  it("用途分类恰好 10 类，覆盖全部组件：无重复、无遗漏、无引擎外名字", () => {
    const spec = readSpec();
    const table = section(spec, "按展示用途选组件");
    const rows = table.split("\n").filter((line) => line.trim().startsWith("|") && !/^\|\s*---/.test(line.trim()) && !line.includes("展示用途"));
    expect(rows).toHaveLength(10);
    const classified = purposeColumnNames(table);
    expect(new Set(classified).size).toBe(classified.length);
    expect([...new Set(classified)].sort()).toEqual(ENGINE_NAMES);
  });

  it("生成后的主技能（SKILL.md）包含用途索引", () => {
    const skill = readFileSync(
      join(__dirname, "../../../../../../agents/slides-layouter/skills/layout-tree-skill/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("## 按展示用途选组件");
    expect(skill).toContain("导航与章节组织");
  });
});
