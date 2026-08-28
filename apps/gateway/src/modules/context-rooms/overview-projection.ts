import { createHash } from "node:crypto";
import type {
  RoomAppliedEntitiesResult,
  RoomOverviewClaim,
  RoomOverviewClaimData,
  RoomOverviewEvidence,
  RoomOverviewFreshness,
  RoomOverviewProjection,
  RoomOverviewSection,
} from "@nxcore/agent-contract";
import type { ContextRoomOverviewSynthesis } from "./room-agent.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, maxLength = 4_000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function optionalText(value: unknown, maxLength = 4_000): string | null {
  return text(value, maxLength) || null;
}

function stringList(value: unknown, maxItems = 20): string[] {
  return Array.isArray(value) ? value.map((item) => text(item, 1_000)).filter(Boolean).slice(0, maxItems) : [];
}

function isoTime(value: unknown): string | null {
  const normalized = text(value, 120);
  if (!normalized || !Number.isFinite(Date.parse(normalized))) return null;
  return new Date(normalized).toISOString();
}

function uniqueEvidence(items: RoomOverviewEvidence[]): RoomOverviewEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourceKind}:${item.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function normalizePriority(value: unknown): "high" | "medium" | "low" | null {
  const normalized = text(value, 20).toLowerCase();
  if (["high", "高", "urgent", "紧急"].includes(normalized)) return "high";
  if (["medium", "中", "normal", "普通"].includes(normalized)) return "medium";
  if (["low", "低"].includes(normalized)) return "low";
  return null;
}

function isCompleted(value: unknown): boolean {
  return /^(done|completed|complete|closed|已完成|完成|已关闭)$/iu.test(text(value, 80));
}

export function createRoomOverviewClaim(
  section: RoomOverviewSection,
  value: string,
  origin: RoomOverviewClaim["origin"],
  evidence: RoomOverviewEvidence[] = [],
  confidence: number | null = null,
  occurredAt?: string | null,
  data?: RoomOverviewClaimData,
  identity = value,
): RoomOverviewClaim {
  return {
    id: `${section}:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`,
    section,
    text: value,
    origin,
    confidence,
    evidence,
    corrected: false,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(data ? { data } : {}),
  };
}

export function dedupeRoomOverviewClaims(items: RoomOverviewClaim[]): RoomOverviewClaim[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.section}:${item.text.trim().toLocaleLowerCase()}`;
    if (!item.text.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function roomOverviewFreshness(
  generatedAt: string,
  sourceUpdatedAt: string | null,
): RoomOverviewFreshness {
  const stale = Boolean(sourceUpdatedAt && sourceUpdatedAt > generatedAt);
  return {
    state: stale ? "stale" : "fresh",
    sourceUpdatedAt,
    generatedAt,
    staleSince: stale ? sourceUpdatedAt : null,
    staleSections: stale ? ["overview", "status", "next_steps"] : [],
  };
}

export function buildRoomOverviewProjection(input: {
  roomId: string;
  roomData: Record<string, unknown>;
  applied: RoomAppliedEntitiesResult;
  generatedAt: Date;
  sourceUpdatedAt: string | null;
  /** Room 关联的活跃云文档（最新在前）——时间轴的收录/版本事件源。 */
  documents: Array<{ id: string; title: string; version: number; createdAt: string; updatedAt: string }>;
  /** 已路由进 Room 的日历事件（startedAt 为事件开始时间，解析不到为 null）。 */
  calendarEvents: Array<{
    sourceId: string; title: string; startedAt: string | null;
    endAt: string | null; allDay: boolean; location: string | null;
  }>;
  /** 已路由进 Room 的连接器待办（按 dueAt 升序）——task claim 与时间轴任务事件源。 */
  todos: Array<{
    sourceId: string; title: string; status: string | null;
    dueAt: string | null; completedAt: string | null; priority: string | null;
  }>;
  synthesis?: ContextRoomOverviewSynthesis;
}): RoomOverviewProjection {
  const { roomId, roomData: data, applied, generatedAt, synthesis } = input;
  const brief = record(data.brief);
  const generated = record(data.generatedContext);
  const sourceOf = (source: {
    sourceKind: string;
    sourceId: string;
    sourceTitle: string | null;
    evidence?: string | null;
    mentionedAt?: string | null;
    sourceVersion?: number;
  }): RoomOverviewEvidence => ({
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    sourceTitle: source.sourceTitle,
    excerpt: source.evidence ?? null,
    observedAt: source.mentionedAt ?? null,
    sourceVersion: source.sourceVersion ?? null,
  });
  const evidenceByRef = new Map<string, RoomOverviewEvidence[]>();
  for (const fact of applied.facts) {
    const evidence = fact.sources.map(sourceOf);
    evidenceByRef.set(fact.factId, evidence);
    for (const item of evidence) {
      evidenceByRef.set(`${item.sourceKind}:${item.sourceId}`, [item]);
      evidenceByRef.set(item.sourceId, [item]);
    }
  }
  for (const entity of applied.entities) {
    for (const item of entity.sources.map(sourceOf)) {
      if (!evidenceByRef.has(`${item.sourceKind}:${item.sourceId}`)) evidenceByRef.set(`${item.sourceKind}:${item.sourceId}`, [item]);
      if (!evidenceByRef.has(item.sourceId)) evidenceByRef.set(item.sourceId, [item]);
    }
  }
  const resolveEvidence = (refs: string[]) => uniqueEvidence(refs.flatMap((ref) => evidenceByRef.get(ref) ?? []));

  const fallbackOverview = [
    [text(generated.overview) || text(brief.background), "summary"],
    [text(brief.goal), "goal"],
  ] as const;
  const overview = synthesis?.overview.length
    ? synthesis.overview.map((item, index) => createRoomOverviewClaim(
        "overview", item.text, "inference", resolveEvidence(item.evidenceRefs), item.confidence,
        undefined, { kind: "overview", aspect: item.aspect }, `synthesis:${item.aspect}:${item.key ?? index}`,
      ))
    : fallbackOverview.flatMap(([value, aspect]) => value ? [createRoomOverviewClaim(
        "overview", value, "inference", [], null, undefined,
        { kind: "overview", aspect }, `fallback:${aspect}`,
      )] : []);

  const fallbackStatus: RoomOverviewClaim[] = [];
  const statusText = text(generated.status) || text(brief.status);
  if (statusText) fallbackStatus.push(createRoomOverviewClaim(
    "status", statusText, "inference", [], null, undefined,
    { kind: "status", category: "conclusion", state: "active" }, "fallback:conclusion",
  ));
  for (const [index, value] of stringList(brief.risks, 8).entries()) fallbackStatus.push(createRoomOverviewClaim(
    "status", value, "inference", [], null, undefined,
    { kind: "status", category: "problem", state: "active" }, `fallback:risk:${index}`,
  ));
  for (const [index, value] of stringList(brief.decisions, 8).entries()) fallbackStatus.push(createRoomOverviewClaim(
    "status", value, "fact", [], 1, undefined,
    { kind: "status", category: "conclusion", state: "active" }, `fallback:decision:${index}`,
  ));
  const status = synthesis?.status.length
    ? synthesis.status.map((item, index) => createRoomOverviewClaim(
        "status", item.text, "inference", resolveEvidence(item.evidenceRefs), item.confidence,
        undefined, { kind: "status", category: item.category, state: item.state },
        `synthesis:${item.category}:${item.key ?? index}`,
      ))
    : fallbackStatus;

  const taskClaims = [
    ...(Array.isArray(data.actionItems) ? data.actionItems : []),
    ...(Array.isArray(generated.actionItems) ? generated.actionItems : []),
  ].flatMap((item, index) => {
    const value = record(item);
    const title = text(value.title, 500);
    const statusValue = optionalText(value.status, 100);
    if (!title || value.completed === true || isCompleted(statusValue)) return [];
    const actionId = optionalText(value.id, 256);
    const source = record(value.source);
    const sourceKind = text(source.type, 100) || "task";
    const sourceId = text(source.objectId, 256) || actionId;
    return [createRoomOverviewClaim(
      "next_steps", title, "fact",
      sourceId ? [{ sourceKind, sourceId, sourceTitle: optionalText(source.name, 500) }] : [],
      1, undefined,
      {
        kind: "next_step", itemType: "task", actionId, owner: optionalText(value.owner, 120),
        dueAt: isoTime(value.dueDate) ?? isoTime(value.deadline) ?? optionalText(value.dueDate ?? value.deadline, 120),
        status: statusValue, priority: normalizePriority(value.priority),
      },
      `task:${actionId ?? index}`,
    )];
  });
  const meetingClaims = (Array.isArray(generated.meetings) ? generated.meetings : []).flatMap((item, index) => {
    const value = record(item);
    const title = text(value.title, 500);
    const normalizedWhen = isoTime(value.when);
    const when = normalizedWhen ?? optionalText(value.when, 120);
    if (!title || !when || (normalizedWhen && normalizedWhen < generatedAt.toISOString())) return [];
    const sourceId = optionalText(value.sourceId, 256) ?? optionalText(value.id, 256);
    return [createRoomOverviewClaim(
      "next_steps", title, "fact",
      sourceId ? [{ sourceKind: "calendar-event", sourceId, sourceTitle: optionalText(value.sourceTitle, 500) }] : [],
      1, undefined,
      { kind: "next_step", itemType: "schedule", actionId: sourceId, owner: null, dueAt: when, status: "scheduled", priority: null },
      `meeting:${sourceId ?? index}`,
    )];
  });
  // 确定性日程 claim：未来开始的连接器日历事件（服务层已按开始时间升序），
  // 取即将到来的前 8 条——先过滤再截断，历史事件再多也不挤掉未来日程。
  const connectorSourceIds = new Set(input.calendarEvents.map((event) => event.sourceId));
  const upcomingEvents = input.calendarEvents
    .filter((event) => event.startedAt && event.startedAt >= generatedAt.toISOString());
  const scheduleClaims = upcomingEvents.slice(0, 8).flatMap((event) => {
    return [createRoomOverviewClaim(
      "next_steps", event.title, "fact",
      [{ sourceKind: "calendar-event", sourceId: event.sourceId, sourceTitle: event.title }],
      1, undefined,
      { kind: "next_step", itemType: "schedule", actionId: event.sourceId, owner: null, dueAt: event.startedAt, status: "scheduled", priority: null },
      `calendar-schedule:${event.sourceId}`,
    )];
  });
  const llmMeetingClaims = meetingClaims.filter((claim) => {
    const sourceId = claim.data?.kind === "next_step" ? claim.data.actionId : null;
    return !sourceId || !connectorSourceIds.has(sourceId);
  });
  // 确定性待办 claim：未完成的连接器待办（status 语义由连接器 Skill 归一，completed 语义兜底判断）。
  const todoClaims = input.todos.slice(0, 20).flatMap((todo) => {
    if (todo.completedAt || isCompleted(todo.status)) return [];
    return [createRoomOverviewClaim(
      "next_steps", todo.title, "fact",
      [{ sourceKind: "todo", sourceId: todo.sourceId, sourceTitle: todo.title }],
      1, undefined,
      {
        kind: "next_step", itemType: "task", actionId: todo.sourceId, owner: null,
        dueAt: todo.dueAt, status: todo.status, priority: normalizePriority(todo.priority),
      },
      `todo:${todo.sourceId}`,
    )];
  });
  const inferredNextSteps = synthesis
    ? synthesis.nextSteps.map((item, index) => createRoomOverviewClaim(
        "next_steps", item.text, "inference", resolveEvidence(item.evidenceRefs), item.confidence,
        undefined,
        { kind: "next_step", itemType: "suggestion", actionId: null, owner: item.owner, dueAt: item.dueAt, status: null, priority: item.priority },
        `suggestion:${item.key ?? index}`,
      ))
    : stringList(generated.nextSteps).map((item, index) => createRoomOverviewClaim(
        "next_steps", item, "inference", [], null, undefined,
        { kind: "next_step", itemType: "suggestion", actionId: null, owner: null, dueAt: null, status: null, priority: null },
        `suggestion:${index}`,
      ));

  // 确定性事件源①：云文档收录/版本事件（时间取文档真实时间戳，evidence 指向文档本身）。
  const documentEvents = input.documents.slice(0, 20).flatMap((document) => {
    const updated = document.version > 1;
    const title = updated
      ? `《${document.title}》更新至第 ${document.version} 版`
      : `《${document.title}》已收录于 Room`;
    const description = updated ? "文档内容已保存新版本。" : "已作为资料归入本 Room，参与后续上下文生成。";
    return [createRoomOverviewClaim(
      "timeline", `${title}：${description}`, "fact",
      [{ sourceKind: "everroom-doc", sourceId: document.id, sourceTitle: document.title }],
      1, updated ? document.updatedAt : document.createdAt,
      {
        kind: "timeline", eventType: updated ? "update" : "source",
        title, description, certainty: "fact",
      },
      `doc:${document.id}:${document.version}`,
    )];
  });
  // 确定性事件源②：连接器日历事件（occurredAt = 事件开始时间；解析不到则按无时间沉底）。
  // 时间轴取最新 20 条（列表已升序，slice(-20) 保升序输出；最终 timeline 整体倒序）。
  const calendarEvents = input.calendarEvents.slice(-20).flatMap((event) => {
    if (!event.title) return [];
    return [createRoomOverviewClaim(
      "timeline", event.title, "fact",
      [{ sourceKind: "calendar-event", sourceId: event.sourceId, sourceTitle: event.title }],
      1, event.startedAt,
      { kind: "timeline", eventType: "meeting", title: event.title, description: null, certainty: "fact" },
      `calendar:${event.sourceId}`,
    )];
  });
  // 确定性事件源③：连接器待办（occurredAt = dueAt；已完成的取完成时间；dueAt 升序 → 取最新 20）。
  const todoTimeline = input.todos.slice(-20).flatMap((todo) => {
    const occurredAt = todo.completedAt ?? todo.dueAt;
    if (!occurredAt) return [];
    return [createRoomOverviewClaim(
      "timeline", todo.title, "fact",
      [{ sourceKind: "todo", sourceId: todo.sourceId, sourceTitle: todo.title }],
      1, occurredAt,
      { kind: "timeline", eventType: "task", title: todo.title, description: null, certainty: "fact" },
      `todo-timeline:${todo.sourceId}`,
    )];
  });
  // 确定性事件源④：事实记忆——occurredAt 取首次提及时间（最后提及时间会让旧事随新资料"漂移"到最新）。
  const factTimeline = applied.facts.flatMap((fact) => {
    if (!fact.lastMentionAt && fact.sources.length === 0) return [];
    const firstMentionAt = fact.sources
      .map((source) => source.mentionedAt)
      .filter(Boolean)
      .sort()[0] ?? fact.lastMentionAt;
    return [createRoomOverviewClaim(
      "timeline", fact.content, "fact", fact.sources.map(sourceOf), 1, firstMentionAt,
      { kind: "timeline", eventType: "fact", title: fact.content, description: null, certainty: "fact" },
      `fact:${fact.factId}`,
    )];
  }).slice(0, 40);
  const legacyTimeline = Array.isArray(data.timeline) ? data.timeline.flatMap((item) => {
    const value = record(item);
    const title = text(value.title, 500);
    const description = text(value.description, 2_000);
    if (!title && !description) return [];
    const sourceId = text(value.sourceDocumentId, 256);
    return [createRoomOverviewClaim(
      "timeline", title && description ? `${title}：${description}` : title || description,
      value.generated === true ? "inference" : "fact",
      sourceId ? [{ sourceKind: "everroom-doc", sourceId, sourceTitle: null }] : [],
      value.generated === true ? null : 1,
      text(value.time, 200) || null,
      {
        kind: "timeline", eventType: text(value.kind, 40) === "meeting" ? "meeting" : "update",
        title: title || description, description: description || null,
        certainty: value.generated === true ? "inference" : "fact",
      },
      `legacy:${text(value.id, 200) || `${text(value.time, 200)}:${title || description}`}`,
    )];
  }) : [];
  const freshness = roomOverviewFreshness(generatedAt.toISOString(), input.sourceUpdatedAt);
  return {
    roomId,
    revision: 0,
    generatedAt: generatedAt.toISOString(),
    stale: freshness.state === "stale",
    freshness,
    overview: dedupeRoomOverviewClaims(overview),
    status: dedupeRoomOverviewClaims(status),
    nextSteps: dedupeRoomOverviewClaims([
      ...scheduleClaims, ...todoClaims, ...taskClaims, ...llmMeetingClaims, ...inferredNextSteps,
    ]).sort((left, right) => {
      const leftData = left.data?.kind === "next_step" ? left.data : null;
      const rightData = right.data?.kind === "next_step" ? right.data : null;
      const rank = { schedule: 0, task: 1, suggestion: 2 };
      return (leftData ? rank[leftData.itemType] : 3) - (rightData ? rank[rightData.itemType] : 3)
        || (leftData?.dueAt ?? "9999").localeCompare(rightData?.dueAt ?? "9999")
        || left.text.localeCompare(right.text);
    }),
    timeline: dedupeRoomOverviewClaims([
      ...calendarEvents, ...todoTimeline, ...documentEvents, ...factTimeline, ...legacyTimeline,
    ]).sort((left, right) =>
      (right.occurredAt ?? "").localeCompare(left.occurredAt ?? "") || left.id.localeCompare(right.id)),
    entities: applied.entities.map((entity) => createRoomOverviewClaim(
      "entities", entity.summary ? `${entity.name}：${entity.summary}` : entity.name,
      "fact", entity.sources.map(sourceOf), entity.salience, undefined,
      {
        kind: "entity", entityId: entity.entityId, entityKind: entity.kind,
        entityStatus: entity.status, linkedRoomId: entity.linkedRoomId,
        salience: entity.salience, mentionCount: entity.mentionCount,
      },
      `entity:${entity.entityId}`,
    )),
    appliedCorrectionIds: [],
  };
}
