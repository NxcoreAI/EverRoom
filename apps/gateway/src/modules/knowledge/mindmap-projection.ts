/**
 * 聚焦思维导图投影（思路板块聚焦模式改造）：把 mindmap-creator subAgent
 * 提交的 JSON 树确定性映射成 EmergenceProjectionResult，喂给渲染层现成的
 * G6 聚焦树（FocusTreeCanvas 消费 nodes/edges/focusRootRef，零改动）。
 *
 * 职责边界（照 emergence-projection 模式）：
 * - 本文件只做树校验与投影塑形，不碰数据库、不调 LLM；
 * - 取数、subagent 派发与落表在 mindmap-service.ts；
 * - 输出 EmergenceProjectionResult 与 apps/desktop/src/shared/knowledge.ts
 *   中的 DTO 逐字段同形（跨进程契约双份维护，改动需两侧同步）。
 *
 * 提示词行为对齐 NotebookLM 思维导图（内部提示词从未公开，按官方行为
 * 描述对齐）：根=主题短语、一级分支=主要概念 4-8 个、总层级 ≤3、
 * 节点用短语、覆盖全部主要主题、不编造材料外内容。
 */

import { createHash } from "node:crypto";
import type {
  EmergenceCard,
  EmergenceEdge,
  EmergenceNode,
  EmergencePath,
  EmergenceProjectionResult,
} from "./emergence-projection.js";

/** 提示词/输出契约版本；行为变更时 +1，旧行按旧版本判定是否重生成。 */
export const MINDMAP_PROMPT_VERSION = 1;

export class MindmapParseError extends Error {}

export interface MindmapLeaf {
  label: string;
}

export interface MindmapBranch {
  label: string;
  children: Array<{ label: string; children?: MindmapLeaf[] }>;
}

export interface MindmapTree {
  topic: string;
  branches: MindmapBranch[];
  digest: { summary: string } | null;
}

const TOPIC_MAX = 80;
const LABEL_MAX = 40;
const BRANCH_MAX = 8;
const CHILD_MAX = 12;
const GRANDCHILD_MAX = 8;

function cleanLabel(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * 防御解析 subAgent 提交的树（outputSchema 之外的第二道闸，兼容手工调用）：
 * 类型/长度规整、层级 >3 截断、分支 >8 截断；topic 或 branches 无效时抛错。
 */
export function parseAgentMindmap(raw: unknown): MindmapTree {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MindmapParseError("mindmap result is not an object");
  }
  const source = raw as Record<string, unknown>;
  const topic = cleanLabel(source.topic, TOPIC_MAX);
  if (!topic) throw new MindmapParseError("mindmap topic is empty");

  const rawBranches = Array.isArray(source.branches) ? source.branches : [];
  const branches: MindmapBranch[] = [];
  for (const rawBranch of rawBranches.slice(0, BRANCH_MAX)) {
    if (!rawBranch || typeof rawBranch !== "object" || Array.isArray(rawBranch)) continue;
    const branch = rawBranch as Record<string, unknown>;
    const label = cleanLabel(branch.label, LABEL_MAX);
    if (!label) continue;
    const children: MindmapBranch["children"] = [];
    const rawChildren = Array.isArray(branch.children) ? branch.children : [];
    for (const rawChild of rawChildren.slice(0, CHILD_MAX)) {
      if (!rawChild || typeof rawChild !== "object" || Array.isArray(rawChild)) continue;
      const child = rawChild as Record<string, unknown>;
      const childLabel = cleanLabel(child.label, LABEL_MAX);
      if (!childLabel) continue;
      const grandchildren: MindmapLeaf[] = [];
      const rawGrandchildren = Array.isArray(child.children) ? child.children : [];
      for (const rawLeaf of rawGrandchildren.slice(0, GRANDCHILD_MAX)) {
        if (!rawLeaf || typeof rawLeaf !== "object" || Array.isArray(rawLeaf)) continue;
        const leafLabel = cleanLabel((rawLeaf as Record<string, unknown>).label, LABEL_MAX);
        if (leafLabel) grandchildren.push({ label: leafLabel });
      }
      children.push(grandchildren.length > 0 ? { label: childLabel, children: grandchildren } : { label: childLabel });
    }
    branches.push(children.length > 0 ? { label, children } : { label, children: [] });
  }
  if (branches.length === 0) throw new MindmapParseError("mindmap has no valid branches");

  const digestRaw = source.digest;
  let digest: MindmapTree["digest"] = null;
  if (digestRaw && typeof digestRaw === "object" && !Array.isArray(digestRaw)) {
    const summary = cleanLabel((digestRaw as Record<string, unknown>).summary, 200);
    if (summary) digest = { summary };
  }
  return { topic, branches, digest };
}

// ───────────────────────── 树 → 投影 ─────────────────────────

export const MINDMAP_ROOT_REF = "mindmap:root";

function branchRef(index: number): string {
  return `mindmap:b${index}`;
}

function leafRef(index: number, childIndex: number, grandIndex?: number): string {
  return grandIndex === undefined
    ? `mindmap:b${index}-${childIndex}`
    : `mindmap:b${index}-${childIndex}-${grandIndex}`;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function edgeId(from: string, to: string): string {
  return `edge:${sha(`${from}\n${to}\n分支`)}`;
}

/**
 * 树 → EmergenceProjectionResult 确定性映射：
 * - 根节点 nodeType 按 scope 取 room|document，分支/叶为 mindmapTopic；
 * - 边父→子（relationType「分支」，composed 虚线）；
 * - 卡片=一级分支一张（kind viewpoint，nodeRef 指向分支，卡片⇄图联动）；
 * - focusRootRef=mindmap:root，渲染层钻取起点自动落到生成树的根。
 */
export function mindmapToProjection(input: {
  tree: MindmapTree;
  scope: "room" | "document";
  roomId: string;
  roomTitle: string;
  documentId: string | null;
  documentTitle: string | null;
  generatedAt: string;
  requestVersion: number;
}): EmergenceProjectionResult {
  const roomRef = { id: input.roomId, title: input.roomTitle };
  const nodes: EmergenceNode[] = [
    {
      id: MINDMAP_ROOT_REF,
      nodeType: input.scope === "document" ? "document" : "room",
      label: input.tree.topic,
      sourceGraph: "mindmap",
      roomRef,
      updatedAt: input.generatedAt,
    },
  ];
  const edges: EmergenceEdge[] = [];
  const pushEdge = (from: string, to: string) => {
    edges.push({ id: edgeId(from, to), from, to, relationType: "分支", edgeLevel: "composed", confidence: null });
  };

  input.tree.branches.forEach((branch, branchIndex) => {
    const branchNodeRef = branchRef(branchIndex);
    nodes.push({
      id: branchNodeRef,
      nodeType: "mindmapTopic",
      label: branch.label,
      sourceGraph: "mindmap",
      roomRef,
      updatedAt: input.generatedAt,
    });
    pushEdge(MINDMAP_ROOT_REF, branchNodeRef);
    branch.children.forEach((child, childIndex) => {
      const childRef = leafRef(branchIndex, childIndex);
      nodes.push({
        id: childRef,
        nodeType: "mindmapTopic",
        label: child.label,
        sourceGraph: "mindmap",
        roomRef,
        updatedAt: input.generatedAt,
      });
      pushEdge(branchNodeRef, childRef);
      (child.children ?? []).forEach((leaf, grandIndex) => {
        const leafNodeRef = leafRef(branchIndex, childIndex, grandIndex);
        nodes.push({
          id: leafNodeRef,
          nodeType: "mindmapTopic",
          label: leaf.label,
          sourceGraph: "mindmap",
          roomRef,
          updatedAt: input.generatedAt,
        });
        pushEdge(childRef, leafNodeRef);
      });
    });
  });

  const scopeLabel = input.scope === "document"
    ? `文档《${input.documentTitle ?? ""}》的主要概念分支`
    : `Room「${input.roomTitle}」的主要概念分支`;
  const cards: EmergenceCard[] = input.tree.branches.map((branch, branchIndex) => {
    const nodeRef = branchRef(branchIndex);
    const path: EmergencePath = { nodeRefs: [MINDMAP_ROOT_REF, nodeRef], hops: ["分支"] };
    const childLabels = branch.children.map((child) => child.label).slice(0, 6);
    return {
      id: `card:${sha(`mindmap:${branchIndex}:${branch.label}`)}`,
      kind: "viewpoint",
      title: branch.label,
      summary: childLabels.length > 0 ? childLabels.join("、") : branch.label,
      sourceType: "mindmap",
      occurredAt: null,
      roomRef,
      reason: input.tree.digest?.summary
        ? `${input.tree.digest.summary}`
        : scopeLabel,
      quote: null,
      path,
      confidence: 0.9,
      nodeRef,
    };
  });

  return {
    cards,
    nodes,
    edges,
    paths: cards.map((card) => card.path!),
    focusRootRef: MINDMAP_ROOT_REF,
    scoreComponents: null,
    requestVersion: input.requestVersion,
    degraded: false,
    degradedReason: null,
    generatedAt: input.generatedAt,
  };
}
