import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  ConnectorJsonRecord,
  NormalizedAddress,
  NormalizedCalendarChange,
  NormalizedCalendarEvent,
  NormalizedMail,
  NormalizedMailChange,
} from "@nxcore/connector-contract";
import type { GatewayDatabase } from "./host-types.js";
import {
  connectorCalendarEvents,
  connectorEmails,
  entityDocLinks,
  ingestEvents,
  roomEntityMentions,
  roomMemoryAttributions,
  roomSourceMemberships,
  routeDecisions,
} from "../../../apps/gateway/src/infrastructure/database/schema.js";

/**
 * 域投影（connector-platform-refactor-plan 阶段一）：Nango 拉取路径的
 * NormalizedMail / NormalizedCalendarEvent 落主库 connector_* 域表——
 * 与 CLI 推送路径（connectors/service.ts upsertDomainRecord）同一套
 * 唯一键与幂等语义，"多引擎、一投影"。Room 读侧从此单轨查域表，
 * 不再回退解析 route_decisions.sourceMarkdown。
 *
 * 注意（M2 收敛点）：contentHash 的 stableJson 算法与 service.ts 内部
 * 实现一致；CLI 路径的 Record<string,unknown> 校验式投影暂不复用本模块
 * （输入形态不同），阶段二拆迁时统一。
 */
type ProjectionDatabase = Pick<GatewayDatabase, "select" | "insert" | "update" | "delete">;

export type DomainProjectionOutcome = "inserted" | "updated" | "unchanged" | "deleted" | "noop";
/** 投影结果：outcome + 域行 id（M4：memorySink 的 sourceId 直接用行 id）。 */
export interface DomainProjectionResult { outcome: DomainProjectionOutcome; id: string | null; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function domainContentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function dateOf(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** HTML 兜底转纯文本：Nango 归一化通常已给 textBody，缺省时从 htmlBody 剥离。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function senderOf(addresses: NormalizedAddress[] | undefined): { senderName: string | null; senderAddress: string | null } {
  const from = addresses?.find((item) => item.role === "from") ?? addresses?.find((item) => item.role === "sender");
  return {
    senderName: from?.displayName?.trim() || null,
    senderAddress: from?.address?.trim() || null,
  };
}

function recipientsOf(addresses: NormalizedAddress[] | undefined): Array<{ name?: string; address: string }> {
  return (addresses ?? [])
    .filter((item) => ["to", "cc", "bcc"].includes(item.role) && item.address?.trim())
    .map((item) => ({
      ...(item.displayName?.trim() ? { name: item.displayName.trim() } : {}),
      address: item.address.trim(),
    }));
}

export class ConnectorDomainProjection {
  constructor(
    private readonly db: ProjectionDatabase,
    /** 域表唯一键成员；与 CLI 路径 currentOwnerId() 同源（默认 "local-user"）。 */
    private readonly ownerId: string,
  ) {}

  projectMail(provider: string, connectionId: string, change: NormalizedMailChange, syncedAt = new Date()): DomainProjectionResult {
    if (change.kind === "tombstone") return this.softDelete(connectorEmails, provider, connectionId, change.providerMessageId, syncedAt);
    const message: NormalizedMail = change.message;
    const receivedAt = dateOf(message.receivedAt ?? message.sentAt);
    const bodyText = message.textBody?.trim() || (message.htmlBody ? htmlToText(message.htmlBody) : "");
    const { senderName, senderAddress } = senderOf(message.addresses);
    const normalized = {
      ownerId: this.ownerId,
      service: provider,
      connectionName: connectionId,
      sourceRecordId: message.providerMessageId,
      sourceUpdatedAt: dateOf(message.sentAt ?? message.receivedAt),
      schemaVersion: 1,
      promptVersion: 0,
      extensionPayload: null,
      messageId: message.providerMessageId,
      threadId: message.providerThreadId ?? null,
      senderName,
      senderAddress,
      recipients: recipientsOf(message.addresses),
      subject: message.subject?.trim() || "（无主题）",
      sentAt: dateOf(message.sentAt ?? message.receivedAt),
      bodyText,
      labels: message.memberships ?? [],
      hasAttachments: (message.attachments?.length ?? 0) > 0,
    };
    return this.upsert(connectorEmails, normalized, syncedAt);
  }

  projectCalendar(provider: string, connectionId: string, change: NormalizedCalendarChange, syncedAt = new Date()): DomainProjectionResult {
    if (change.kind === "tombstone") return this.softDelete(connectorCalendarEvents, provider, connectionId, change.providerEventId, syncedAt);
    const event: NormalizedCalendarEvent = change.event;
    const normalized = {
      ownerId: this.ownerId,
      service: provider,
      connectionName: connectionId,
      sourceRecordId: event.providerEventId,
      sourceUpdatedAt: dateOf(event.startsAt),
      schemaVersion: 1,
      promptVersion: 0,
      extensionPayload: null,
      eventId: event.providerEventId,
      title: event.title?.trim() || "（无标题）",
      description: event.description?.trim() || "",
      organizer: event.organizer?.address
        ? { ...(event.organizer.displayName ? { name: event.organizer.displayName } : {}), address: event.organizer.address }
        : null,
      attendees: (event.attendees ?? [])
        .filter((item) => item.address)
        .map((item) => ({
          ...(item.displayName ? { name: item.displayName } : {}),
          address: item.address,
        })),
      startAt: dateOf(event.startsAt),
      endAt: dateOf(event.endsAt),
      // ICS/归一化层声明了全天语义时透传；Gmail/Graph 折算 T00:00:00Z 的存量路径缺省 false。
      allDay: event.allDay === true,
      status: event.status ?? null,
      location: event.location ?? null,
    };
    return this.upsert(connectorCalendarEvents, normalized, syncedAt);
  }

  private upsert(
    table: typeof connectorEmails | typeof connectorCalendarEvents,
    normalized: Record<string, unknown>,
    syncedAt: Date,
  ): DomainProjectionResult {
    const existing = this.db.select({ id: table.id, contentHash: table.contentHash, deletedAt: table.deletedAt })
      .from(table)
      .where(and(
        eq(table.ownerId, normalized.ownerId as string),
        eq(table.service, normalized.service as string),
        eq(table.connectionName, normalized.connectionName as string),
        eq(table.sourceRecordId, normalized.sourceRecordId as string),
      ))
      .get();
    const hash = domainContentHash(normalized);
    const values = { ...normalized, id: existing?.id ?? randomUUID(), syncedAt, contentHash: hash, deletedAt: null };
    this.db.insert(table).values(values as never).onConflictDoUpdate({
      target: [table.ownerId, table.service, table.connectionName, table.sourceRecordId],
      set: values as never,
    }).run();
    return {
      outcome: !existing ? "inserted" : existing.contentHash === hash && !existing.deletedAt ? "unchanged" : "updated",
      id: values.id as string,
    };
  }

  private softDelete(
    table: typeof connectorEmails | typeof connectorCalendarEvents,
    provider: string,
    connectionId: string,
    sourceRecordId: string,
    syncedAt: Date,
  ): DomainProjectionResult {
    const existing = this.db.select({ id: table.id, deletedAt: table.deletedAt })
      .from(table)
      .where(and(
        eq(table.ownerId, this.ownerId),
        eq(table.service, provider),
        eq(table.connectionName, connectionId),
        eq(table.sourceRecordId, sourceRecordId),
      ))
      .get();
    if (!existing || existing.deletedAt) return { outcome: "noop", id: existing?.id ?? null };
    this.db.update(table).set({ deletedAt: syncedAt }).where(eq(table.id, existing.id)).run();
    return { outcome: "deleted", id: existing.id };
  }
}

/**
 * 解析 ingest 侧的 connector sourceId ref：`connector:{provider}:{connectionId}:{kind}:{recordId}`。
 * document 分支无 kind 段（`connector:{provider}:{connectionId}:{docId}`）。
 * recordId 内若含 ":" 一并收回到最后一段（slice(4).join）——身份协议解析只此一处
 * （阶段四将整体退役为域行 id）。
 */
export interface ConnectorSourceRef {
  provider: string;
  connectionId: string;
  kind: "mail" | "calendar" | "document";
  recordId: string;
}

export function parseConnectorSourceRef(sourceId: string): ConnectorSourceRef | null {
  if (!sourceId.startsWith("connector:")) return null;
  const parts = sourceId.split(":");
  if (parts.length < 4) return null;
  const [, provider, connectionId, third] = parts;
  if (!provider || !connectionId) return null;
  if (third === "mail" || third === "calendar") {
    const recordId = parts.slice(4).join(":");
    return recordId ? { provider, connectionId, kind: third, recordId } : null;
  }
  // document：无 kind 段，third 起即 recordId。
  return third ? { provider, connectionId, kind: "document", recordId: parts.slice(3).join(":") } : null;
}


export interface IdentityRewriteSummary {
  /** 扫描到的 connector ref 引用数（跨全部身份表去重前）。 */
  refs: number;
  rewritten: number;
  unresolved: number;
  deduped: { memberships: number; entityLinks: number };
}

/**
 * M4 存量身份改写：把六张身份表里的 connector ref（`connector:{provider}:{conn}:{kind}:{id}`）
 * 原地改写为域行 id（与 M4 写路径、CLI 路径同一身份体系）。幂等：ref 全部消失后
 * 再跑为 no-op。解析失败/域行缺失的 ref 不动（读侧 ref 兜底通道保留一个周期），
 * 只计数不静默丢弃。membership/mention 在改写后按 (room, kind, sourceId) 去重
 * （CLI 行与 Nango 行同 id 撞车的场景，保留 updatedAt 最新的一行）。
 */
/** 六张身份表：connector ref 出现的全部位置（sourceKind + sourceId 成对）。 */
const IDENTITY_TABLES = [roomSourceMemberships, roomEntityMentions, routeDecisions, entityDocLinks, roomMemoryAttributions, ingestEvents] as const;

export function rewriteConnectorRefIdentities(db: ProjectionDatabase): IdentityRewriteSummary {
  const kindOfRef = (kind: string): "mail" | "calendar-event" | null =>
    kind === "mail" ? "mail" : kind === "calendar" ? "calendar-event" : null;
  // 收集全部 ref（跨表 DISTINCT）。
  const refs = new Set<string>();
  for (const table of IDENTITY_TABLES) {
    const rows = db.select({ sourceId: table.sourceId }).from(table)
      .where(sql`${table.sourceId} LIKE 'connector:%'`)
      .all();
    for (const row of rows)
      if (typeof row.sourceId === "string" && row.sourceId.startsWith("connector:")) refs.add(row.sourceId);
  }
  const summary: IdentityRewriteSummary = { refs: refs.size, rewritten: 0, unresolved: 0, deduped: { memberships: 0, entityLinks: 0 } };
  // ref → 域行 id。
  const refToId = new Map<string, string>();
  for (const ref of refs) {
    const parsed = parseConnectorSourceRef(ref);
    const kind = parsed ? kindOfRef(parsed.kind) : null;
    if (!parsed || !kind) { summary.unresolved += 1; continue; }
    const table = kind === "mail" ? connectorEmails : connectorCalendarEvents;
    const row = db.select({ id: table.id }).from(table).where(and(
      eq(table.service, parsed.provider),
      eq(table.connectionName, parsed.connectionId),
      eq(table.sourceRecordId, parsed.recordId),
    )).get();
    if (!row) { summary.unresolved += 1; continue; }
    refToId.set(ref, row.id);
  }
  // 原地改写六张表。memberships / entity_doc_links 带业务唯一键
  // （(room,kind,sourceId) / (entity,kind,sourceId)）：CLI 行已用目标 id 时，
  // ref 行改写会撞唯一键——预删冲突 ref 行（保留既有行，信息不丢）。
  for (const [ref, id] of refToId) {
    const parsed = parseConnectorSourceRef(ref)!;
    const kind = kindOfRef(parsed.kind)!;
    // memberships 冲突预删：同 room 已存在目标 sourceId 的行 → 删 ref 行。
    const conflictRooms = db.select({ roomId: roomSourceMemberships.roomId }).from(roomSourceMemberships)
      .where(and(eq(roomSourceMemberships.sourceKind, kind), eq(roomSourceMemberships.sourceId, id))).all();
    if (conflictRooms.length > 0) {
      const removed = db.delete(roomSourceMemberships).where(and(
        eq(roomSourceMemberships.sourceKind, kind),
        eq(roomSourceMemberships.sourceId, ref),
        inArray(roomSourceMemberships.roomId, conflictRooms.map((row) => row.roomId)),
      )).run().changes;
      summary.deduped.memberships += removed;
    }
    // entity_doc_links 冲突预删：同 entity 已存在目标 sourceId 的行。
    const conflictEntities = db.select({ entityId: entityDocLinks.entityId }).from(entityDocLinks)
      .where(and(eq(entityDocLinks.sourceKind, kind), eq(entityDocLinks.sourceId, id))).all();
    if (conflictEntities.length > 0) {
      const removed = db.delete(entityDocLinks).where(and(
        eq(entityDocLinks.sourceKind, kind),
        eq(entityDocLinks.sourceId, ref),
        inArray(entityDocLinks.entityId, conflictEntities.map((row) => row.entityId)),
      )).run().changes;
      summary.deduped.entityLinks += removed;
    }
    for (const table of IDENTITY_TABLES) {
      db.update(table).set({ sourceId: id }).where(and(
        eq(table.sourceKind, kind),
        eq(table.sourceId, ref),
      )).run();
    }
    summary.rewritten += 1;
  }
  return summary;
}

/** 回填数据源（ConnectorRepository 的窄接口，便于测试替身）。 */
export interface DomainBackfillSource {
  listConnections(): Array<{ id: string; provider: string }>;
  records(connectionId: string, recordType: "mail" | "calendar", opts?: { limit?: number; offset?: number }): ConnectorJsonRecord[];
}

export interface DomainBackfillSummary {
  connections: number;
  mail: number;
  calendar: number;
  failures: number;
}

/**
 * 存量回填：直读 connectors.sqlite 的 connector_records（payload 即归一化 JSON），
 * 过与实时同步**同一个**投影函数落主库域表。幂等：唯一键 upsert，
 * 重复执行产出 "unchanged"，可安全随启动重跑（阶段一不依赖 SQL 迁移——
 * 主库域表 schema 早已存在）。
 */
export function backfillDomainProjection(
  db: ProjectionDatabase,
  source: DomainBackfillSource,
  ownerId: string,
): DomainBackfillSummary {
  const projection = new ConnectorDomainProjection(db, ownerId);
  const summary: DomainBackfillSummary = { connections: 0, mail: 0, calendar: 0, failures: 0 };
  const pageSize = 500;
  for (const connection of source.listConnections()) {
    summary.connections += 1;
    for (const recordType of ["mail", "calendar"] as const) {
      for (let offset = 0; ; offset += pageSize) {
        let page: ConnectorJsonRecord[];
        try {
          page = source.records(connection.id, recordType, { limit: pageSize, offset });
        } catch {
          summary.failures += 1;
          break;
        }
        for (const record of page) {
          try {
            const result = recordType === "mail"
              ? projection.projectMail(record.provider, record.connectionId ?? connection.id, { kind: "upsert", message: record.data as NormalizedMail })
              : projection.projectCalendar(record.provider, record.connectionId ?? connection.id, { kind: "upsert", event: record.data as NormalizedCalendarEvent });
            // 只计 inserted/updated（"applied"口径）：幂等重跑时 unchanged 不增长，
            // 调用方可据此判断回填是否产生了新工作。
            if (result.outcome === "inserted" || result.outcome === "updated") summary[recordType] += 1;
          } catch {
            summary.failures += 1;
          }
        }
        if (page.length < pageSize) break;
      }
    }
  }
  return summary;
}
