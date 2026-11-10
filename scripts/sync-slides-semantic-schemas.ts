import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SEMANTIC_PAGE_SCHEMA, CONTENT_SOURCE_SCHEMA } from "../apps/gateway/src/modules/subagents/slides-semantic-contract.js";

// semantic-v3 是唯一内容路径：本脚本把语义契约同步进 agent schema，不再生成任何 legacy 条件。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const mode = { type: "string", const: "semantic-v3" };
const sources = { type: "array", minItems: 1, maxItems: 512, items: CONTENT_SOURCE_SCHEMA };
/** 保真版草稿页：用户确认后的完整内容（页数上限 32，单字段放宽）。 */
const draftPageItem = { type: "object", properties: {
  title: { type: "string", maxLength: 8000 }, points: { type: "array", maxItems: 128, items: { type: "string", maxLength: 8000 } },
  data: { type: "string", maxLength: 8000 }, materialHints: { type: "string", maxLength: 8000 }, notes: { type: "string", maxLength: 16000 },
}, required: ["title"], additionalProperties: false };
function update(agent: string, direction: string, edit: (schema: any) => void) {
  const path = resolve(root, `agents/${agent}/schemas/${direction}.schema.json`);
  const old = readFileSync(path, "utf8");
  const schema = JSON.parse(old);
  edit(schema);
  const next = JSON.stringify(schema, null, 2) + "\n";
  if (next === old) return;
  if (check) throw new Error(`Semantic schema drift: ${path}`);
  writeFileSync(path, next);
}
update("slides-planner", "input", s => {
  Object.assign(s.properties, { contentMode: mode, sources });
  // arrange 恒带语义契约；draft 阶段不带这两个字段。
  s.allOf = [{ if: { properties: { phase: { const: "arrange" } }, required: ["phase"] },
    then: { required: ["contentMode", "sources", "draftPages"], properties: { draftPages: { type: "array", minItems: 1, maxItems: 32, items: draftPageItem } } } }];
  delete s.$defs?.legacyDraftPage;
  s.properties.draftPages = { type: "array", minItems: 1, maxItems: 32, items: draftPageItem };
});
update("slides-planner", "output", s => {
  s.properties.pages.items.properties.content = SEMANTIC_PAGE_SCHEMA;
  // arrange 页必带语义 content（draft 页不带）；把 arrange 分支的必填写清楚。
  const items = s.properties.pages.items;
  const arrangeItems = { ...items, required: [...(items.required ?? ["title"]), "role", "density", "content"] };
  s.allOf = [
    { if: { properties: { phase: { const: "draft" } }, required: ["phase"] }, then: { properties: { pages: s.properties.pages } } },
    { if: { properties: { phase: { const: "arrange" } }, required: ["phase"] }, then: { properties: { pages: { ...s.properties.pages, items: arrangeItems } } } },
  ];
});
update("slides-editor", "input", s => {
  Object.assign(s.properties, { contentMode: mode, sources });
  s.properties.draftPages.minItems = 0;
  // 修复器没有可选模式：语义修复字段全部必填。
  s.required = ["instruction", "roomId", "draftPages", "contentMode", "sources", "priorStoryboard", "repairPageIds", "defects"];
  delete s.allOf;
});
update("slides-editor", "output", s => {
  // 只接受 storyboard/v3（编辑器是语义修复器，旧批量压缩契约已删除）。
  s.type = "object";
  s.properties = {
    schemaVersion: { type: "string", const: "storyboard/v3" },
    pages: { type: "array", minItems: 1, maxItems: 4, items: SEMANTIC_PAGE_SCHEMA },
  };
  s.required = ["schemaVersion", "pages"];
  s.additionalProperties = false;
  delete s.anyOf;
});
update("slides-layouter", "input", s => {
  s.properties.content = SEMANTIC_PAGE_SCHEMA;
  s.properties.materials.maxItems = 8;
  Object.assign(s.properties.neighbors.items.properties, { role: { type: "string" }, message: { type: "string", maxLength: 8000 } });
});
update("slides-layouter", "output", s => Object.assign(s.properties, {
  designIntent: { type: "string", minLength: 1, maxLength: 1000 },
  bindings: { type: "array", maxItems: 64, items: {
    type: "object", properties: { blockId: { type: "string", minLength: 1, maxLength: 128 }, paths: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", pattern: "^nodes/\\d+(?:/children/\\d+)*$" } } }, required: ["blockId", "paths"], additionalProperties: false,
  } },
}));
