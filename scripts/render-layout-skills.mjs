#!/usr/bin/env node
/**
 * 幻灯片布局技能生成器（零依赖 Node ESM）。
 *
 * 输入：
 *   docs/slides-layout-tree-spec.zh-CN.md                 权威正文（唯一语法真源）
 *   agents/<agent>/skills/layout-tree-skill/appendix.md   该 agent 的增量章节（顶部注释给 description）
 *
 * 输出（按需加载：SKILL.md 常读；design-guide 语义布局时读；components/* 命中类别才读）：
 *   agents/<agent>/skills/layout-tree-skill/SKILL.md              基础语法 + 用途索引 + appendix
 *   agents/<agent>/skills/layout-tree-skill/design-guide.md       设计指引（内容关系、构图、空间分配）
 *   agents/<agent>/skills/layout-tree-skill/components/<文档>.md  按展示用途拆分的组件参数
 *
 * 用法：
 *   node scripts/render-layout-skills.mjs            生成（覆盖磁盘文件）
 *   node scripts/render-layout-skills.mjs --check    只比对，不一致时打印差异摘要并以退出码 1 结束
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = join(ROOT, "docs", "slides-layout-tree-spec.zh-CN.md");
const SKILL_DIR = join("skills", "layout-tree-skill");
const AGENTS = ["slides-layouter"];
const FALLBACK_DESCRIPTION = "幻灯片布局叶子语法——v2 是唯一写入格式；只设计单页，坐标由引擎计算";

/** 读文本，统一行尾，去掉末尾空白行。 */
function readNormalized(path) {
  if (!existsSync(path)) throw new Error(`缺少输入文件：${relative(ROOT, path)}`);
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/** appendix 顶部注释里的 description；没有就用常量。 */
function parseAppendix(raw) {
  const match = /^\s*<!--\s*description:\s*([\s\S]*?)\s*-->\s*/.exec(raw);
  if (!match) return { description: FALLBACK_DESCRIPTION, body: raw };
  const description = match[1].replace(/\s+/g, " ").trim();
  if (!description) return { description: FALLBACK_DESCRIPTION, body: raw.slice(match[0].length) };
  return { description, body: raw.slice(match[0].length).replace(/^\s+/, "") };
}

/** 表格 → { header: 表头+分隔两行（无表头时 null）， rows: 数据行原始文本 }。 */
function splitTable(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
  const isSeparator = (line) => line.split("|").slice(1, -1)
    .every((cell) => cell.trim() === "" || /^:?-{2,}:?$/.test(cell.trim()));
  const separatorIndex = lines.findIndex(isSeparator);
  if (separatorIndex <= 0) return { header: null, rows: lines };
  return { header: lines.slice(separatorIndex - 1, separatorIndex + 1), rows: lines.slice(separatorIndex + 1) };
}

/** 行 → 单元格数组。 */
function cellsOf(line) {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** 文本里反引号包裹的名字。 */
function backtickedNames(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** 行首格里的组件名：优先反引号名；裸名（如 `chevron / pyramid`）按分隔符拆。 */
function firstCellNames(line) {
  const cell = cellsOf(line)[0] ?? "";
  const ticked = backtickedNames(cell);
  if (ticked.length > 0) return ticked;
  return cell.split(/[\/、,，\s]+/).map((name) => name.trim()).filter(Boolean);
}

/** 数据行 → { name, line }；行首格没有组件名的行丢弃。 */
function namedRows(rows) {
  return rows
    .map((line) => ({ name: firstCellNames(line)[0] ?? null, line }))
    .filter((row) => row.name !== null);
}

/** 行首格组件名与集合有交集才保留（一行可覆盖多个组件）。 */
function rowsMentioning(rows, names) {
  return rows.filter((line) => firstCellNames(line).some((name) => names.has(name)));
}

/** 按 `## ` 标题切权威正文；标题 → 正文（不含标题行）。 */
function splitSections(spec) {
  const sections = new Map();
  let title = "";
  let buffer = [];
  for (const line of spec.split("\n")) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (title) sections.set(title, buffer.join("\n").trim());
      title = match[1];
      buffer = [];
    } else if (title) {
      buffer.push(line);
    }
  }
  if (title) sections.set(title, buffer.join("\n").trim());
  return sections;
}

function sectionOrThrow(sections, title) {
  const body = sections.get(title);
  if (body === undefined) throw new Error(`权威正文缺少章节：## ${title}`);
  return body;
}

/** 组件参数区：核心/原子两张表 + 各自的导语。 */
function parseParamsSection(body) {
  const coreAt = body.indexOf("### 27 个核心组件");
  const atomAt = body.indexOf("### 10 个页面原子");
  if (coreAt < 0 || atomAt < 0 || atomAt <= coreAt) throw new Error("权威正文「组件参数」缺少核心/原子分节");
  const coreBlock = body.slice(coreAt, atomAt);
  const atomBlock = body.slice(atomAt);
  const coreHeading = coreBlock.slice(0, coreBlock.indexOf("\n")).trim();
  const coreTable = splitTable(coreBlock);
  const atomHeading = atomBlock.slice(0, atomBlock.indexOf("\n")).trim();
  const atomLines = atomBlock.split("\n").slice(1);
  const firstRow = atomLines.findIndex((line) => line.trim().startsWith("|"));
  const atomIntro = firstRow > 0 ? atomLines.slice(0, firstRow).join("\n").trim() : "";
  const atomTable = splitTable(atomLines.slice(firstRow < 0 ? 0 : firstRow).join("\n"));
  return {
    intro: body.slice(0, coreAt).trim(),
    coreHeading,
    coreHeader: coreTable.header,
    coreRows: namedRows(coreTable.rows),
    atomHeading,
    atomIntro,
    atomHeader: atomTable.header,
    atomRows: namedRows(atomTable.rows),
  };
}

/** 组件样式区按 **小节** 切块。 */
function parseStyleSection(body) {
  const cut = (marker) => {
    const at = body.indexOf(marker);
    if (at < 0) throw new Error(`权威正文「组件样式」缺少小节：${marker}`);
    return at;
  };
  const variantsAt = cut("**组件专属变体**");
  const tokensAt = cut("**styleTokens 语义**");
  const subsetAt = cut("**组件语义子集**");
  const variantsTable = splitTable(body.slice(variantsAt, tokensAt));
  const subsetTable = splitTable(body.slice(subsetAt));
  return {
    shared: body.slice(0, variantsAt).trim(),
    variantsHead: body.slice(variantsAt, body.indexOf("\n", variantsAt)).trim(),
    variantsHeader: variantsTable.header,
    variantsRows: variantsTable.rows,
    tokens: body.slice(tokensAt, subsetAt).trim(),
    subsetIntro: body.slice(subsetAt, body.indexOf("|", subsetAt)).trim(),
    subsetHeader: subsetTable.header,
    subsetRows: subsetTable.rows,
  };
}

function emitTable(header, rows) {
  if (rows.length === 0) return null;
  return [...(header ?? []), ...rows].join("\n");
}

function renderSkill(agent) {
  const skillDir = join(ROOT, "agents", agent, SKILL_DIR);
  const appendixPath = join(skillDir, "appendix.md");
  const { description, body } = parseAppendix(readNormalized(appendixPath));
  if (!body) throw new Error(`${relative(ROOT, appendixPath)} 除了 description 注释之外没有正文`);
  const spec = readNormalized(SPEC_PATH);
  const sections = splitSections(spec);

  const indexAt = spec.indexOf("## 按展示用途选组件");
  const designAt = spec.indexOf("## 设计指引（语义内容布局）");
  const styleAt = spec.indexOf("## 组件样式（style）与 styleTokens");
  const hardAt = spec.indexOf("## Composition 硬约束（validate 会拒收）");
  if (indexAt < 0 || designAt < 0 || styleAt < 0 || hardAt < 0
    || !(indexAt < designAt && designAt < styleAt && styleAt < hardAt)) {
    throw new Error("权威正文章节顺序不符合预期（用途索引 → 设计指引 → 组件样式 → Composition 硬约束）");
  }
  const core = [spec.slice(0, indexAt).trimEnd(), "", spec.slice(hardAt)].join("\n");
  const indexSection = spec.slice(indexAt, designAt).trim();
  const designSection = sectionOrThrow(sections, "设计指引（语义内容布局）");

  // ── 用途索引：用途 → { doc, components[] } ──────────────────────────────
  const categories = splitTable(indexSection).rows.map((line) => {
    const cells = cellsOf(line);
    const purpose = cells[0];
    const doc = (cells[1] ?? "").replace(/`/g, "");
    const components = backtickedNames(cells[2] ?? "");
    if (!purpose || !/^[\w-]+\.md$/.test(doc) || components.length === 0) {
      throw new Error(`用途索引行不完整：${line}`);
    }
    return { purpose, doc, components };
  });
  if (categories.length !== 10) throw new Error(`用途索引应有 10 个类别，实际 ${categories.length}`);

  // ── 一致性：索引 / 清单 / 参数三处对得上，且每个组件只属一个类别 ─────────
  const indexOwner = new Map();
  for (const category of categories) {
    for (const name of category.components) {
      if (indexOwner.has(name)) throw new Error(`组件 ${name} 同时出现在「${indexOwner.get(name)}」与「${category.purpose}」`);
      indexOwner.set(name, category.purpose);
    }
  }
  const inventory = new Set(namedRows(splitTable(sectionOrThrow(sections, "组件清单")).rows).map((row) => row.name));
  const params = parseParamsSection(sectionOrThrow(sections, "组件参数"));  const paramNames = new Set([...params.coreRows, ...params.atomRows].map((row) => row.name));
  const indexNames = new Set(indexOwner.keys());
  const diff = (a, b) => [...a].filter((name) => !b.has(name));
  for (const [label, other] of [["组件参数", paramNames], ["组件清单", inventory]]) {
    if (diff(indexNames, other).length || diff(other, indexNames).length) {
      throw new Error(`用途索引与${label}不一致：索引多出 ${diff(indexNames, other)}，${label}多出 ${diff(other, indexNames)}`);
    }
  }

  const style = parseStyleSection(sectionOrThrow(sections, "组件样式（style）与 styleTokens"));

  const pointer = "语义布局任务先读 `skills/layout-tree-skill/design-guide.md`（内容关系、构图与空间分配；同一对话读一次即可）。使用 component 前按上方索引读对应类别的 `skills/layout-tree-skill/components/<文档>`，核对该组件的参数、容量和实际支持的 style；同一类别同一对话读一次即可。两者均由权威正文生成；基础节点页无需加载。";

  const outputs = [{
    path: join(skillDir, "SKILL.md"),
    text: [
      "---",
      "name: layout-tree-skill",
      `description: ${description}`,
      "---",
      "",
      core,
      "",
      indexSection,
      "",
      pointer,
      "",
      "---",
      "",
      body,
      "",
    ].join("\n"),
  }, {
    path: join(skillDir, "design-guide.md"),
    text: [
      "# 布局设计指引（语义内容布局）",
      "",
      "由 scripts/render-layout-skills.mjs 从 docs/slides-layout-tree-spec.zh-CN.md 生成；变更在权威正文维护。任务流程与提交契约由 SYSTEM.md 负责。",
      "",
      designSection.replace(/^## 设计指引（语义内容布局）[^\n]*\n+/, ""),
      "",
    ].join("\n"),
  }];
  for (const category of categories) {
    const names = new Set(category.components);
    const coreRows = params.coreRows.filter((row) => names.has(row.name)).map((row) => row.line);
    const atomRows = params.atomRows.filter((row) => names.has(row.name)).map((row) => row.line);
    if (coreRows.length + atomRows.length !== names.size) {
      throw new Error(`类别「${category.purpose}」参数行数与组件数不一致`);
    }
    const blocks = [
      `# 组件参考 · ${category.purpose}`,
      "由 scripts/render-layout-skills.mjs 从 docs/slides-layout-tree-spec.zh-CN.md 生成；语法变更在权威正文维护。本文件只覆盖本用途类别的组件，全部用途索引见 SKILL.md「按展示用途选组件」。",
      style.shared,
      rowsMentioning(style.variantsRows, names).length > 0 ? [
        style.variantsHead,
        emitTable(style.variantsHeader, rowsMentioning(style.variantsRows, names)),
      ].join("\n\n") : null,
      style.tokens,
      style.subsetIntro,
      emitTable(style.subsetHeader, rowsMentioning(style.subsetRows, names)),
      "## 参数",
      params.intro,
      coreRows.length > 0 ? [params.coreHeading, emitTable(params.coreHeader, coreRows)].join("\n\n") : null,
      atomRows.length > 0 ? [params.atomHeading, params.atomIntro, emitTable(params.atomHeader, atomRows)].join("\n\n") : null,
    ];
    outputs.push({
      path: join(skillDir, "components", category.doc),
      text: blocks.filter((block) => block !== null).join("\n\n") + "\n",
    });
  }
  return outputs;
}

/** 差异摘要：首个不同的行、行数。 */
function summarizeDiff(expected, actual) {
  const want = expected.split("\n");
  const got = actual.split("\n");
  const limit = Math.max(want.length, got.length);
  const lines = [`行数：期望 ${want.length} 行，实际 ${got.length} 行`];
  for (let i = 0; i < limit; i += 1) {
    if (want[i] === got[i]) continue;
    lines.push(`首个差异在第 ${i + 1} 行`);
    lines.push(`  期望：${(want[i] ?? "（文件结束）").slice(0, 160)}`);
    lines.push(`  实际：${(got[i] ?? "（文件结束）").slice(0, 160)}`);
    break;
  }
  return lines.join("\n");
}

const checkOnly = process.argv.includes("--check");
const failures = [];

for (const agent of AGENTS) {
  const outputs = renderSkill(agent);
  const generatedDir = join(ROOT, "agents", agent, SKILL_DIR, "components");
  const expectedPaths = new Set(outputs.map(({ path }) => path));
  if (!checkOnly) {
    mkdirSync(generatedDir, { recursive: true });
    // 清掉不在期望清单里的旧文件（类别改名后的残留）。
    if (existsSync(generatedDir)) {
      for (const entry of readdirSync(generatedDir)) {
        const entryPath = join(generatedDir, entry);
        if (entryPath.endsWith(".md") && !expectedPaths.has(entryPath)) rmSync(entryPath);
      }
    }
  }
  for (const { path, text } of outputs) {
    const relativePath = relative(ROOT, path);
    if (checkOnly) {
      const actual = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : "";
      if (actual === text) {
        console.log(`ok   ${relativePath}`);
        continue;
      }
      failures.push(`${relativePath}\n${summarizeDiff(text, actual)}`);
      continue;
    }
    writeFileSync(path, text, "utf8");
    console.log(`生成 ${relativePath}`);
  }
}

if (checkOnly) {
  if (failures.length === 0) {
    console.log("生成物与权威正文一致。");
    process.exit(0);
  }
  console.error("生成物与权威正文不一致，请运行 node scripts/render-layout-skills.mjs：");
  for (const failure of failures) console.error(`\n${failure}`);
  process.exit(1);
}
