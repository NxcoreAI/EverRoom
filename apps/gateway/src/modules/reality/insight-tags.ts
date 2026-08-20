import type { RealityTag } from "@nxcore/reality-contract";

const ENTITY_TYPES = new Set(["person", "organization", "project", "product", "place", "other"]);

function text(value: unknown, maxLength = 500): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function confidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

/** Accepts old string labels and the structured entity/fact format used by recordings. */
export function normalizeInsightTags(value: unknown): RealityTag[] {
  if (!Array.isArray(value)) return [];
  const tags: RealityTag[] = [];
  for (const item of value.slice(0, 12)) {
    if (typeof item === "string") {
      const label = text(item, 160);
      if (label) tags.push({ kind: "entity", label, entityType: "other" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const label = text(row.label, 160);
    if (!label || (row.kind !== "entity" && row.kind !== "fact")) continue;
    const evidence = text(row.evidence, 500);
    const score = confidence(row.confidence);
    if (row.kind === "entity") {
      const entityType = typeof row.entityType === "string" && ENTITY_TYPES.has(row.entityType)
        ? row.entityType as NonNullable<RealityTag["entityType"]>
        : "other";
      tags.push({
        kind: "entity",
        label,
        entityType,
        ...(evidence ? { evidence } : {}),
        ...(score === undefined ? {} : { confidence: score }),
      });
      continue;
    }
    const subject = text(row.subject, 160);
    const predicate = text(row.predicate, 160);
    const object = text(row.object, 240);
    if (!subject || !predicate || !object) continue;
    tags.push({
      kind: "fact",
      label,
      subject,
      predicate,
      object,
      ...(evidence ? { evidence } : {}),
      ...(score === undefined ? {} : { confidence: score }),
    });
  }
  return tags;
}

export function insightEvidenceMarkdown(input: {
  title: string;
  eventType?: string | null;
  summary?: string | null;
  keyPoints?: string[];
  tags?: RealityTag[];
  transcript?: string;
}): string {
  const parts = [`# ${input.title}`];
  if (input.eventType) parts.push(`事件类型：${input.eventType}`);
  if (input.summary?.trim()) parts.push(`## 摘要\n\n${input.summary.trim()}`);
  const keyPoints = input.keyPoints?.map((item) => item.trim()).filter(Boolean) ?? [];
  if (keyPoints.length > 0) parts.push(`## 关键内容\n\n${keyPoints.map((item) => `- ${item}`).join("\n")}`);
  if (input.tags && input.tags.length > 0) {
    parts.push(`## 实体与事实\n\n${input.tags.map((tag) => {
      const value = tag.kind === "fact"
        ? `${tag.subject} ${tag.predicate} ${tag.object}`
        : `${tag.label}（${tag.entityType ?? "other"}）`;
      return `- [${tag.kind}] ${value}${tag.evidence ? `；证据：${tag.evidence}` : ""}`;
    }).join("\n")}`);
  }
  if (input.transcript?.trim()) parts.push(`## 逐字稿\n\n${input.transcript.trim()}`);
  return parts.join("\n\n");
}
