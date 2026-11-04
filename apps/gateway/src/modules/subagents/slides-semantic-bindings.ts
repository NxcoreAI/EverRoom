import type { SemanticPage } from "./slides-semantic-contract.js";
import { payloadStrings } from "./slides-semantic-contract.js";
import { normalizeSpeakerNotes } from "../slides-layout/tree/v2/schema.js";

export interface ContentBinding { blockId: string; paths: string[] }
const compact = (value: string) => value.replace(/\s+/gu, "");

/** Only rendered fields count: notes, IDs, shape names and arbitrary metadata cannot prove coverage. */
export function visiblePayload(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(visiblePayload);
  const node = value as Record<string, unknown>;
  if (node.type === "chart") return [
    ...scalarPayload(node.categories),
    ...(Array.isArray(node.series) ? node.series.flatMap((s: { name?: string; values?: number[] }) => [...scalarPayload(s.name), ...scalarPayload(s.values)]) : []),
  ];
  if (node.type === "component") {
    const options = new Set(["type", "name", "style", "slot", "bleed", "direction", "axis", "connector", "layout", "form", "featured", "marker", "fill", "avatar", "monochrome", "numbered", "highlight", "icon", "notes"]);
    return Object.entries(node).flatMap(([key, item]) => options.has(key) ? [] : componentPayload(item));
  }
  const fields = new Set(["text", "label", "body", "value", "unit", "caption", "attribution", "title", "headers", "rows", "labels", "categories", "values", "url"]);
  return Object.entries(node).flatMap(([key, item]) => {
    if (key === "notes" || key === "speakerNotes" || key === "style") return [];
    if (fields.has(key)) return scalarPayload(item);
    if (["children", "nodes", "items", "series", "runs", "paragraphs"].includes(key)) return visiblePayload(item);
    return [];
  });
}
function scalarPayload(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarPayload);
  return visiblePayload(value);
}
function componentPayload(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(componentPayload);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => ["notes", "style", "icon"].includes(key) ? [] : componentPayload(item));
}
function nodeAt(tree: unknown, path: string): unknown {
  if (!/^nodes\/\d+(?:\/children\/\d+)*$/u.test(path)) return undefined;
  return path.split("/").reduce<unknown>((node, key) => node && typeof node === "object"
    ? (node as Record<string, unknown>)[key] : undefined, tree);
}

export function checkSemanticBindings(page: SemanticPage, tree: unknown, result: Record<string, unknown>, availableAssets?: string[]): string[] {
  const errors: string[] = [];
  if (typeof result.designIntent !== "string" || !result.designIntent.trim()) errors.push("缺少 designIntent");
  const bindings = Array.isArray(result.bindings) ? result.bindings : [];
  const ids = new Set(page.blocks.map(b => b.id));
  const byBlock = new Map<string, string[]>();
  for (const raw of bindings) {
    const binding = raw as Partial<ContentBinding> | null;
    if (!binding || !ids.has(binding.blockId ?? "") || !Array.isArray(binding.paths) || !binding.paths.length || binding.paths.some(p => typeof p !== "string")) {
      errors.push("无效内容绑定"); continue;
    }
    if (byBlock.has(binding.blockId!)) errors.push(`重复绑定 ${binding.blockId}`);
    byBlock.set(binding.blockId!, binding.paths);
    for (const path of binding.paths) if (!nodeAt(tree, path)) errors.push(`绑定路径不存在 ${path}`);
  }
  const allVisible = visiblePayload(tree).map(compact).join("");
  if (!allVisible.includes(compact(page.message))) errors.push("页面 message 未展示");
  for (const block of page.blocks) {
    const paths = byBlock.get(block.id);
    if (!paths) { if (block.mustShow) errors.push(`必留内容未绑定 ${block.id}`); continue; }
    const payloads = paths.flatMap(path => visiblePayload(nodeAt(tree, path))).map(compact);
    const payload = payloads.join("");
    for (const expected of payloadStrings(block)) {
      const found = typeof expected === "string" && /^-?\d+(?:\.\d+)?$/u.test(expected)
        ? payloads.includes(expected) : payload.includes(compact(expected));
      if (!found) errors.push(`绑定载荷缺失 ${block.id}: ${expected.slice(0, 80)}`);
    }
    const nodes = paths.map(path => nodeAt(tree, path) as Record<string, unknown> | undefined);
    if (block.type === "table" && !nodes.some(n => n?.type === "table" && JSON.stringify((n.rows as Array<Array<{ text: string }>>).map(row => row.map(c => c.text))) === JSON.stringify([block.headers, ...block.rows].map(row => row.map(String))))) errors.push(`表格行列或单元格顺序改变 ${block.id}`);
    if (block.type === "chart" && !nodes.some(n => n?.type === "chart" && JSON.stringify(n.categories) === JSON.stringify(block.labels) && JSON.stringify((n.series as Array<{ name: string; values: number[] }>).map(s => [s.name, s.values])) === JSON.stringify(block.series.map(s => [s.name, s.values])))) errors.push(`图表分类或序列对应关系改变 ${block.id}`);
    if (block.type === "image") {
      if (availableAssets && !availableAssets.includes(block.assetRef)) errors.push(`必需图片不可用 ${block.id}`);
      if (block.fit === "contain" && !paths.some(path => (nodeAt(tree, path) as Record<string, unknown> | undefined)?.fit === "contain")) errors.push(`图片必须完整呈现 ${block.id}`);
    }
  }
  return errors;
}

/** Components may normalize unused fields or truncate their own items; verify the compiled visible payload too. */
export function checkSemanticRendered(page: SemanticPage, spec: { elements: unknown[]; notes?: string }): string[] {
  const payload = visiblePayload(spec.elements).map(compact);
  const joined = payload.join("");
  const errors: string[] = [];
  if (!joined.includes(compact(page.message))) errors.push("编译后 message 缺失");
  for (const block of page.blocks.filter(b => b.mustShow)) {
    for (const expected of payloadStrings(block)) {
      const found = /^-?\d+(?:\.\d+)?$/u.test(expected) ? payload.includes(expected) : joined.includes(compact(expected));
      if (!found) errors.push(`编译后必留内容缺失 ${block.id}: ${expected.slice(0, 60)}`);
    }
  }
  // 讲稿按 schema 归一后的口径比较（trim + 2000 字上限）；模型改写/追加由提交期 validator 纠正，
  // 这里仍保留闸门，防止落页侧编译把讲稿弄丢。2026-10-24：严格 !== 让「标注为」一字之差永久拒收。
  const expectedNotes = page.notes ? normalizeSpeakerNotes(page.notes) : "";
  if (expectedNotes && spec.notes !== expectedNotes) {
    errors.push(`讲稿未完整保留（期望 ${expectedNotes.length} 字，实际 ${spec.notes?.length ?? 0} 字）`);
  }
  return errors;
}
