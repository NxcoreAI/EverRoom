import { Type, type Static } from "@sinclair/typebox";
import { Ajv } from "ajv";
import { createHash } from "node:crypto";

const id = Type.String({ minLength: 1, maxLength: 128 });
const refs = Type.Array(id, { minItems: 1, maxItems: 128, uniqueItems: true });
const text = Type.String({ minLength: 1, maxLength: 8000 });
const cell = Type.Union([Type.String({ maxLength: 2000 }), Type.Number()]);
const common = {
  id, sourceRefs: refs,
  priority: Type.Union([Type.Literal("primary"), Type.Literal("supporting"), Type.Literal("detail")]),
  mustShow: Type.Boolean(),
};
const block = <T extends string, F extends import("@sinclair/typebox").TProperties>(type: T, fields: F) =>
  Type.Object({ ...common, type: Type.Literal(type), ...fields }, { additionalProperties: false });
export const SEMANTIC_BLOCK_SCHEMA = Type.Union([
  block("text", { text }),
  block("metric", { label: text, value: cell, unit: Type.Optional(text) }),
  block("quotation", { text, attribution: Type.Optional(text) }),
  block("table", { headers: Type.Array(cell, { minItems: 1, maxItems: 32 }), rows: Type.Array(Type.Array(cell, { minItems: 1, maxItems: 32 }), { minItems: 1, maxItems: 100 }) }),
  block("chart", { labels: Type.Array(text, { minItems: 1, maxItems: 100 }), series: Type.Array(Type.Object({ name: text, values: Type.Array(Type.Number(), { minItems: 1, maxItems: 100 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 12 }), unit: Type.Optional(text) }),
  block("image", { assetRef: text, alt: text, fit: Type.Union([Type.Literal("contain"), Type.Literal("cover")]) }),
]);
export const SEMANTIC_PAGE_SCHEMA = Type.Object({
  id, sourceRefs: refs,
  role: Type.Union(["cover", "toc", "section", "content", "data", "table", "flow", "quote", "closing"].map(v => Type.Literal(v))),
  message: text,
  blocks: Type.Array(SEMANTIC_BLOCK_SCHEMA, { minItems: 1, maxItems: 64 }),
  relations: Type.Array(Type.Object({
    type: Type.Union(["supports", "compares", "precedes", "causes", "contains", "parallel", "navigates"].map(v => Type.Literal(v))),
    refs, basis: text,
  }, { additionalProperties: false }), { maxItems: 64 }),
  focusRefs: refs,
  constraints: Type.Object({ verbatimRefs: Type.Array(id, { maxItems: 128 }) }, { additionalProperties: false }),
  notes: Type.String({ maxLength: 16000 }),
  omissions: Type.Array(Type.Object({ sourceRef: id, reason: text, disposition: Type.Union([Type.Literal("notes"), Type.Literal("omitted")]) }, { additionalProperties: false }), { maxItems: 128 }),
}, { additionalProperties: false });

export type SemanticPage = Static<typeof SEMANTIC_PAGE_SCHEMA>;
export type SemanticBlock = SemanticPage["blocks"][number];
export interface ContentSource { id: string; pageId: string; kind: string; value: string; mustShow: boolean }
export const CONTENT_SOURCE_SCHEMA = Type.Object({ id, pageId: id, kind: id, value: text, mustShow: Type.Boolean() }, { additionalProperties: false });
export interface SemanticStoryboard { schemaVersion: "storyboard/v3"; title: string; pages: SemanticPage[]; sources: ContentSource[] }
export interface SemanticReport { contract: "storyboard/v3"; pageCount: number; passed: boolean; errors: string[]; warnings: string[] }

const validate = new Ajv({ allErrors: true, strict: false }).compile(SEMANTIC_PAGE_SCHEMA);
export const semanticHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * 草稿文档里的 `^[label](everroom://...)` 是文档注解/回链，不是页内容。
 * 语义校验若把 URL 里的数字当正文数据，会要求输出复现 URL 编码串（2026-10-23
 * 实测：必留数据缺失 -9/88/55/-4/04 全部来自 citation 的 preview URL）。
 */
export function stripSourceCitations(value: string): string {
  return value
    .replace(/\^\[[^\]]*\]\((?:everroom:\/\/|https?:\/\/)[^)]*\)/gu, "")
    .replace(/everroom:\/\/\S+/gu, "")
    .trim();
}

/** IDs describe the confirmed source snapshot, never the rewritten output or arranged position. */
export function assignContentSources(pages: Array<{ title?: string; points?: string[]; data?: string; notes?: string; materialHints?: string }>, documentId: string): ContentSource[] {
  return pages.flatMap((page, index) => {
    const pageId = `source-${semanticHash({ documentId, index, page }).slice(0, 20)}`;
    const values = [
      { kind: "title", value: page.title, mustShow: true },
      ...(page.points ?? []).map((value, i) => ({ kind: `point-${i + 1}`, value, mustShow: true })),
      { kind: "data", value: page.data, mustShow: true },
      { kind: "notes", value: page.notes, mustShow: false },
      { kind: "materialHints", value: page.materialHints, mustShow: false },
    ];
    return values.flatMap(({ value, ...entry }) => {
      if (typeof value !== "string") return [];
      const clean = stripSourceCitations(value);
      return clean ? [{ ...entry, value: clean, pageId, id: `${pageId}:${entry.kind}` }] : [];
    });
  });
}

export function payloadStrings(block: SemanticBlock): string[] {
  switch (block.type) {
    case "text": return [block.text];
    case "metric": return [block.label, String(block.value), ...(block.unit ? [block.unit] : [])];
    case "quotation": return [block.text, ...(block.attribution ? [block.attribution] : [])];
    case "table": return [...block.headers, ...block.rows.flat()].map(String);
    case "chart": return [...block.labels, ...block.series.flatMap(s => [s.name, ...s.values.map(String)]), ...(block.unit ? [block.unit] : [])];
    case "image": return [block.assetRef];
  }
}
/** 文本中的数字（日期区间 2012-2014 里的连字符不算负号；citation URL 由来源清洗负责剥离）。 */
export const numbersInText = (value: string): string[] => value.match(/(?<![\d.])-?\d+(?:[.,]\d+)*(?:%|％)?/gu) ?? [];
const numbers = numbersInText;

/**
 * 逐字来源的候选文本：来源原文可能带包裹引号（`"原话"`、`「原话」`），
 * 引用 block 只放内文是正常写法，不应判为"未完整展示"（2026-10-23 实测
 * 愿景页因 source 带引号而反复修复失败）。
 */
function verbatimCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates = new Set([trimmed]);
  const pairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]];
  for (const [left, right] of pairs) {
    if (trimmed.length >= 2 && trimmed.startsWith(left) && trimmed.endsWith(right)) {
      candidates.add(trimmed.slice(1, -1).trim());
      break;
    }
  }
  return [...candidates];
}

/** Validates declared relationships and source accounting; semantic equivalence remains a visual/agent review responsibility. */
export function checkSemanticStoryboard(pages: unknown[], sources: ContentSource[]): SemanticReport {
  const errors: string[] = [];
  const known = new Map(sources.map(s => [s.id, s]));
  const covered = new Set<string>();
  const shown = new Set<string>();
  const pageIds = new Set<string>();
  for (const [index, raw] of pages.entries()) {
    const prefix = `第 ${index + 1} 页`;
    if (!validate(raw)) { errors.push(`${prefix}: ${new Ajv().errorsText(validate.errors)}`); continue; }
    const page = raw as SemanticPage;
    if (pageIds.has(page.id)) errors.push(`${prefix}: 重复页面 ID ${page.id}`);
    pageIds.add(page.id);
    const expectedPageId = [...new Set(sources.map(s => s.pageId))][index];
    if (page.id !== expectedPageId) errors.push(`${prefix}: 页面 ID 或页序改变，应为 ${expectedPageId}`);
    const ids = new Set(page.blocks.map(b => b.id));
    if (ids.size !== page.blocks.length) errors.push(`${prefix}: 重复 block ID`);
    const pageSources = new Set(page.sourceRefs);
    for (const ref of page.sourceRefs) if (!known.has(ref) || known.get(ref)?.pageId !== page.id) errors.push(`${prefix}: 未知或跨页来源 ${ref}`);
    for (const ref of [...page.focusRefs, ...page.relations.flatMap(r => r.refs)]) if (!ids.has(ref)) errors.push(`${prefix}: 未知 block ${ref}`);
    for (const relation of page.relations) if (relation.refs.length < 2) errors.push(`${prefix}: 关系至少包含两个 block`);
    for (const block of page.blocks) {
      for (const ref of block.sourceRefs) {
        if (!known.has(ref) || !pageSources.has(ref)) errors.push(`${prefix}: block ${block.id} 来源无效 ${ref}`);
        if (block.mustShow) covered.add(ref);
        if (block.mustShow) shown.add(ref);
        if (known.get(ref)?.mustShow && !block.mustShow) errors.push(`${prefix}: 必留来源 ${ref} 不能降为可省略`);
      }
      if (block.type === "table" && block.rows.some(r => r.length !== block.headers.length)) errors.push(`${prefix}: 表格行列不一致`);
      if (block.type === "chart" && block.series.some(s => s.values.length !== block.labels.length)) errors.push(`${prefix}: 图表序列长度不一致`);
      const original = block.sourceRefs.map(ref => known.get(ref)?.value ?? "").join("\n");
      if (block.type !== "image") for (const n of numbers(payloadStrings(block).join("\n"))) {
        if (!numbers(original).includes(n)) errors.push(`${prefix}: block ${block.id} 数值 ${n} 无来源`);
      }
      if (block.type === "quotation" && !original.includes(block.text)) errors.push(`${prefix}: 引用不符原文`);
      if (block.type === "metric" && block.unit) {
        const sourceText = original.replace(/\s+/gu, "");
        if (!sourceText.includes(`${block.value}${block.unit}`)) errors.push(`${prefix}: 指标 ${block.id} 数值或单位不符来源`);
      }
    }
    for (const ref of page.constraints.verbatimRefs) {
      const source = known.get(ref);
      const candidates = source ? verbatimCandidates(source.value) : [];
      if (!source || !page.blocks.some(b => b.mustShow && b.sourceRefs.includes(ref)
        && payloadStrings(b).some(text => candidates.some(candidate => text.includes(candidate))))) {
        errors.push(`${prefix}: 原文必留 ${ref} 未完整展示`);
      }
    }
    for (const omission of page.omissions) {
      const source = known.get(omission.sourceRef);
      if (!source || !pageSources.has(omission.sourceRef)) errors.push(`${prefix}: 遗漏记录来源无效`);
      else if (source.mustShow) errors.push(`${prefix}: 必留内容 ${source.id} 不能移到讲稿或删除`);
      else if (omission.disposition === "notes" && !page.notes.includes(source.value)) errors.push(`${prefix}: 讲稿未包含 ${source.id}`);
      covered.add(omission.sourceRef);
    }
  }
  for (const source of sources) {
    if (!covered.has(source.id)) errors.push(`来源未交代: ${source.id}`);
    if (source.mustShow && !shown.has(source.id)) errors.push(`必留来源未展示: ${source.id}`);
    if (source.mustShow) {
      const output = pages.filter(p => validate(p)).flatMap(p => (p as SemanticPage).blocks.filter(b => b.mustShow && b.sourceRefs.includes(source.id)).flatMap(payloadStrings)).join("\n");
      for (const n of numbers(source.value)) if (!numbers(output).includes(n)) errors.push(`必留数据缺失 ${n}: ${source.id}`);
    }
  }
  if (pages.length !== new Set(sources.map(s => s.pageId)).size) errors.push("确认草稿页数发生变化");
  if (!pages.length) errors.push("内容页为空");
  return { contract: "storyboard/v3", pageCount: pages.length, passed: errors.length === 0, errors: [...new Set(errors)], warnings: [] };
}
