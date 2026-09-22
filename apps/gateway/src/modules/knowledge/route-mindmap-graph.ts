/**
 * 写作路线导图：树操作与素材纯函数（聚焦改版 2026-09）。
 *
 * 职责边界（照 mindmap-projection 旧模式）：
 * - 本文件只做树查找/挂接、agent 输出防御解析、三图谱素材文本化，不碰数据库、不调 LLM；
 * - 取数、subagent 派发与落表在 route-mindmap-service.ts；
 * - RouteNode 与 apps/desktop/src/shared/knowledge.ts 的 DTO 逐字段同形（跨进程契约双份维护）。
 */

import { createHash } from "node:crypto";
import type { ProjectionGraph } from "./emergence-projection.js";

/** 提示词/输出契约版本；行为变更时 +1。 */
export const ROUTE_PROMPT_VERSION = 2;

export const ROUTE_ROOT_REF = "route:root";

/** 全图深度上限（含根；根下最多三层选项，第四层为末梢不再续生）。 */
export const ROUTE_MAX_DEPTH = 4;

/** 路线节点：ref 由服务端按层级赋（route:b{i}、route:b{i}-{j}…），agent 只产 label/note。 */
export interface RouteNode {
  ref: string;
  label: string;
  note: string | null;
  children?: RouteNode[];
}

export interface RouteGraph {
  root: RouteNode;
}

export class RouteParseError extends Error {}

const LABEL_MAX = 40;
const NOTE_MAX = 60;
/** 每层路线选项数（与 agent output schema 一致的防御边界：首层 3-5、深化层 2-3，防御按下限 2 放行）。 */
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 5;

/** 子节点 ref：route:b{i}、route:b{i}-{j}…（首段带 b 前缀，后续纯序号）。 */
export function childRef(parentRef: string, childIndex: number): string {
  const suffix = `b${childIndex}`;
  return parentRef === ROUTE_ROOT_REF ? `route:${suffix}` : `${parentRef}-${childIndex}`;
}

/** 深度优先找节点。 */
export function findNode(root: RouteNode, ref: string): RouteNode | null {
  if (root.ref === ref) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, ref);
    if (hit) return hit;
  }
  return null;
}

/** 根→目标节点的 ref 链（含两端）；不在树中返回 null。 */
export function pathTo(root: RouteNode, ref: string): string[] | null {
  if (root.ref === ref) return [root.ref];
  for (const child of root.children ?? []) {
    const sub = pathTo(child, ref);
    if (sub) return [root.ref, ...sub];
  }
  return null;
}

/** 按已选路径取 label 链（渲染端路径链 / doc-writer instruction 共用）。 */
export function labelsOfPath(root: RouteNode, refs: readonly string[]): string[] {
  const labels: string[] = [];
  let cursor: RouteNode | null = root;
  for (const ref of refs) {
    const next: RouteNode | null = cursor && cursor.ref === ref ? cursor : (cursor?.children ?? []).find((child) => child.ref === ref) ?? null;
    if (!next) break;
    labels.push(next.label);
    cursor = next;
  }
  return labels;
}

/** 防御解析 subAgent 提交的路线选项（outputSchema 之外的第二道闸，兼容手工调用）。 */
export function parseRouteOptions(raw: unknown): Array<{ label: string; note: string | null }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RouteParseError("route result is not an object");
  }
  const source = raw as Record<string, unknown>;
  const rawOptions = Array.isArray(source.options) ? source.options : [];
  const options: Array<{ label: string; note: string | null }> = [];
  const seen = new Set<string>();
  for (const item of rawOptions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim().slice(0, LABEL_MAX) : "";
    if (!label || seen.has(label)) continue;
    const note = typeof record.note === "string" && record.note.trim() ? record.note.trim().slice(0, NOTE_MAX) : null;
    options.push({ label, note });
    seen.add(label);
    if (options.length >= OPTIONS_MAX) break;
  }
  if (options.length < OPTIONS_MIN) {
    throw new RouteParseError(`route options below minimum: ${options.length}`);
  }
  return options;
}

/** 把 options 挂到目标节点（沿用已有子级时不调用）。 */
export function attachChildren(target: RouteNode, options: ReadonlyArray<{ label: string; note: string | null }>): RouteNode[] {
  const base = target.children?.length ?? 0;
  const children = options.map((option, index) => ({
    ref: childRef(target.ref, base + index),
    label: option.label,
    note: option.note,
  }));
  target.children = [...(target.children ?? []), ...children];
  return children;
}

// ───────────────────────── 三图谱素材文本化 ─────────────────────────

const MATERIAL_MAX = 60_000;

/**
 * 关系板块三套图谱（roomGraph/entityFacts/linkGraph）投影 → agent 素材文本。
 * wiki 源按效果稿排除；空图返回 null（调用方落 failed「没有可用素材」）。
 */
export function materializeGraphMaterial(graph: ProjectionGraph): { text: string; truncated: boolean } | null {
  const nodes = [...graph.nodes.values()].filter((node) => node.sourceGraph !== "wiki");
  if (nodes.length === 0) return null;

  const entityEdges = graph.edges
    .filter((edge) => edge.relationType === "提及" && edge.confidence !== null)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const salientEntities = new Set(entityEdges.map((edge) => edge.to));

  const rooms: string[] = [];
  const entities: string[] = [];
  const facts: string[] = [];
  const docs: string[] = [];
  const label = (id: string): string => graph.nodes.get(id)?.label ?? id;
  for (const node of nodes) {
    if (node.nodeType === "room") rooms.push(node.label);
    else if (node.nodeType === "entity" || salientEntities.has(node.id)) entities.push(node.label);
    else if (node.nodeType === "fact") facts.push(node.label);
    else if (node.nodeType === "document") docs.push(node.label);
  }

  const relationEdges = graph.edges
    .filter((edge) => {
      const from = graph.nodes.get(edge.from);
      return from?.nodeType === "room" && from?.sourceGraph === "roomGraph";
    })
    .slice(0, 40);
  const referencePairs = graph.edges
    .filter((edge) => edge.relationType === "引用")
    .slice(0, 60);

  const parts: string[] = [];
  if (rooms.length > 1) parts.push(`【关联 Room】${rooms.slice(0, 30).join("、")}`);
  if (relationEdges.length > 0) {
    parts.push(`【Room 关系】${relationEdges
      .map((edge) => `${label(edge.from)}—${edge.relationType}—${label(edge.to)}`)
      .join("；")}`);
  }
  if (entities.length > 0) parts.push(`【实体】${[...new Set(entities)].slice(0, 60).join("、")}`);
  if (facts.length > 0) parts.push(`【事实】${[...new Set(facts)].slice(0, 60).map((fact) => `· ${fact}`).join("\n")}`);
  if (docs.length > 0) parts.push(`【已有文档】${docs.slice(0, 60).join("、")}`);
  if (referencePairs.length > 0) {
    parts.push(`【文档引用】${referencePairs
      .map((edge) => `${label(edge.from)} → ${label(edge.to)}`)
      .join("；")}`);
  }
  if (parts.length === 0) return null;
  const text = parts.join("\n");
  return {
    text: text.slice(0, MATERIAL_MAX),
    truncated: text.length > MATERIAL_MAX,
  };
}

export function routeContentHash(input: { title: string; description: string | null; material: string }): string {
  return createHash("sha256").update(`${input.title}\n${input.description ?? ""}\n${input.material}`).digest("hex");
}
