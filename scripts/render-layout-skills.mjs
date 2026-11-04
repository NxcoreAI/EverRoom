#!/usr/bin/env node
/**
 * 幻灯片布局技能生成器（零依赖 Node ESM）。
 *
 * 输入：
 *   docs/slides-layout-tree-spec.zh-CN.md                 权威正文（唯一语法真源）
 *   agents/<agent>/skills/layout-tree-skill/appendix.md   该 agent 的增量章节（顶部注释给 description）
 *
 * 输出：
 *   agents/<agent>/skills/layout-tree-skill/SKILL.md      基础语法 + 组件参考指针 + appendix
 *   agents/<agent>/skills/layout-tree-skill/components.md 组件样式、清单与详细参数
 *
 * 用法：
 *   node scripts/render-layout-skills.mjs            生成（覆盖磁盘文件）
 *   node scripts/render-layout-skills.mjs --check    只比对，不一致时打印差异摘要并以退出码 1 结束
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

function renderSkill(agent) {
  const skillDir = join(ROOT, "agents", agent, SKILL_DIR);
  const appendixPath = join(skillDir, "appendix.md");
  const { description, body } = parseAppendix(readNormalized(appendixPath));
  const spec = readNormalized(SPEC_PATH);
  if (!body) throw new Error(`${relative(ROOT, appendixPath)} 除了 description 注释之外没有正文`);
  const componentStart = spec.indexOf("## 组件样式（style）与 styleTokens");
  const componentEnd = spec.indexOf("## Composition 硬约束（validate 会拒收）");
  if (componentStart < 0 || componentEnd <= componentStart) {
    throw new Error("权威正文缺少组件参考分界章节");
  }
  const components = spec.slice(componentStart, componentEnd).trim();
  const core = [
    spec.slice(0, componentStart).trimEnd(),
    "",
    "使用 component 时，先读 `skills/layout-tree-skill/components.md`：按信息语义选择组件，再核对该组件的参数、容量和实际支持的 style。该参考由权威正文生成；基础节点页无需加载。",
    "",
    spec.slice(componentEnd),
  ].join("\n");
  return [{
    path: join(skillDir, "SKILL.md"),
    text: [
      "---",
      "name: layout-tree-skill",
      `description: ${description}`,
      "---",
      "",
      core,
      "",
      "---",
      "",
      body,
      "",
    ].join("\n"),
  }, {
    path: join(skillDir, "components.md"),
    text: [
      "# 布局组件参考",
      "",
      "由 scripts/render-layout-skills.mjs 从 docs/slides-layout-tree-spec.zh-CN.md 生成；语法变更在权威正文维护。",
      "",
      components,
      "",
    ].join("\n"),
  }];
}

/** 差异摘要：首个不同的行、行数、增删行数。 */
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

for (const { path, text } of AGENTS.flatMap(renderSkill)) {
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

if (checkOnly) {
  if (failures.length === 0) {
    console.log("生成物与权威正文一致。");
    process.exit(0);
  }
  console.error("生成物与权威正文不一致，请运行 node scripts/render-layout-skills.mjs：");
  for (const failure of failures) console.error(`\n${failure}`);
  process.exit(1);
}
