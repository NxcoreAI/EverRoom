import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ConnectorJsonRecord,
  ConnectorConnection,
  MailMessage,
  NormalizedMail,
  NormalizedMailChange,
  NormalizedCalendarChange,
  SyncRun,
  SyncScope,
} from "@nxcore/connector-contract";
const now = () => new Date().toISOString();
const key = (
  connectionId: string,
  scopeId: string,
  change: NormalizedMailChange,
  revision?: string | null,
) => {
  const id =
    change.kind === "upsert"
      ? change.message.providerMessageId
      : change.providerMessageId;
  const rev =
    change.kind === "upsert"
      ? (change.message.providerRevision ?? "current")
      : (revision ?? "removed");
  return createHash("sha256")
    .update(`${connectionId}:${scopeId}:${id}:${change.kind}:${rev}`)
    .digest("hex");
};
const calendarKey = (connectionId: string, scopeId: string, change: NormalizedCalendarChange) => {
  const id = change.kind === "upsert" ? change.event.providerEventId : change.providerEventId;
  const revision = change.kind === "upsert" ? (change.event.providerRevision ?? "current") : "removed";
  return createHash("sha256").update(`${connectionId}:${scopeId}:calendar:${id}:${change.kind}:${revision}`).digest("hex");
};
export class ConnectorRepository {
  constructor(public readonly sqlite: Database.Database) {}
  listConnections(): ConnectorConnection[] {
    return (
      this.sqlite
        .prepare(
          "SELECT id,provider,nango_config_key as nangoConfigKey,nango_connection_id as nangoConnectionId,account_identity_hash as accountIdentityHash,status,filters_json as filters,auth_method as authMethod,credentials_ref as credentialsRef,created_at as createdAt,updated_at as updatedAt FROM connector_connections ORDER BY created_at",
        )
        .all() as any[]
    ).map((r) => ({ ...r, filters: JSON.parse(r.filters) }));
  }
  getConnection(id: string) {
    return this.listConnections().find((x) => x.id === id) ?? null;
  }
  registerConnection(input: {
    provider: string;
    nangoConfigKey: string;
    nangoConnectionId: string;
    filters?: Record<string, unknown>;
    authMethod?: "nango-oauth" | "api-token" | "webcal-url" | "password" | "manual-import";
    credentialsRef?: string | null;
  }): ConnectorConnection {
    const id = randomUUID(),
      t = now();
    this.sqlite
      .prepare(
        "INSERT INTO connector_connections(id,provider,nango_config_key,nango_connection_id,filters_json,auth_method,credentials_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        input.provider,
        input.nangoConfigKey,
        input.nangoConnectionId,
        JSON.stringify(input.filters ?? {}),
        input.authMethod ?? "nango-oauth",
        input.credentialsRef ?? null,
        t,
        t,
      );
    return this.getConnection(id)!;
  }
  disableConnection(id: string) {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "UPDATE connector_connections SET status='disabled',updated_at=? WHERE id=?",
        )
        .run(now(), id);
      this.sqlite
        .prepare(
          "UPDATE sync_scopes SET state='disabled',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE connection_id=?",
        )
        .run(now(), id);
    })();
  }
  enableConnection(id: string) {
    this.sqlite.transaction(() => {
      this.sqlite.prepare("UPDATE connector_connections SET status='active',updated_at=? WHERE id=?").run(now(), id);
      this.sqlite.prepare("UPDATE sync_scopes SET state='idle',updated_at=? WHERE connection_id=? AND state='disabled'").run(now(), id);
    })();
  }
  purgeConnection(id: string) {
    this.sqlite.transaction(() => {
      for (const table of ["sync_failures", "sync_runs", "mail_memberships"]) {
        this.sqlite
          .prepare(
            `DELETE FROM ${table} WHERE scope_id IN (SELECT id FROM sync_scopes WHERE connection_id=?)`,
          )
          .run(id);
      }
      this.sqlite
        .prepare(
          "DELETE FROM mail_addresses WHERE message_id IN (SELECT id FROM mail_messages WHERE connection_id=?)",
        )
        .run(id);
      this.sqlite
        .prepare(
          "DELETE FROM mail_attachments WHERE message_id IN (SELECT id FROM mail_messages WHERE connection_id=?)",
        )
        .run(id);
      this.sqlite
        .prepare("DELETE FROM connector_records WHERE connection_id=?")
        .run(id);
      this.sqlite
        .prepare("DELETE FROM sync_changes WHERE connection_id=?")
        .run(id);
      this.sqlite
        .prepare("DELETE FROM mail_messages WHERE connection_id=?")
        .run(id);
      this.sqlite
        .prepare("DELETE FROM mail_threads WHERE connection_id=?")
        .run(id);
      this.sqlite
        .prepare("DELETE FROM sync_scopes WHERE connection_id=?")
        .run(id);
      this.sqlite
        .prepare("DELETE FROM connector_connections WHERE id=?")
        .run(id);
    })();
  }
  listScopes(): SyncScope[] {
    return this.sqlite
      .prepare(
        "SELECT id,connection_id as connectionId,provider_scope_id as providerScopeId,display_name as displayName,state,source_cursor as sourceCursor,delivery_cursor as deliveryCursor,checkpoint_revision as checkpointRevision,lease_owner as leaseOwner,lease_expires_at as leaseExpiresAt,fence_token as fenceToken,updated_at as updatedAt FROM sync_scopes ORDER BY updated_at",
      )
      .all() as SyncScope[];
  }
  getScope(id: string) {
    return this.listScopes().find((s) => s.id === id) ?? null;
  }
  ensureScope(
    connectionId: string,
    providerScopeId: string,
    displayName: string,
  ) {
    const found = this.listScopes().find(
      (s) =>
        s.connectionId === connectionId &&
        s.providerScopeId === providerScopeId,
    );
    if (found) return found;
    const id = randomUUID(),
      t = now();
    this.sqlite
      .prepare(
        "INSERT INTO sync_scopes(id,connection_id,provider_scope_id,display_name,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(id, connectionId, providerScopeId, displayName, t);
    return this.getScope(id)!;
  }
  acquireLease(id: string, owner: string, ttlMs = 60000) {
    const t = now(),
      expires = new Date(Date.now() + ttlMs).toISOString();
    const r = this.sqlite
      .prepare(
        "UPDATE sync_scopes SET lease_owner=?,lease_expires_at=?,fence_token=fence_token+1,state='running',updated_at=? WHERE id=? AND state!='disabled' AND (lease_owner IS NULL OR lease_expires_at<?)",
      )
      .run(owner, expires, t, id, t);
    return r.changes ? this.getScope(id)!.fenceToken : null;
  }
  releaseLease(id: string, owner: string, fence: number) {
    this.sqlite
      .prepare(
        "UPDATE sync_scopes SET lease_owner=NULL,lease_expires_at=NULL,state=CASE WHEN state='running' THEN 'idle' ELSE state END,updated_at=? WHERE id=? AND lease_owner=? AND fence_token=?",
      )
      .run(now(), id, owner, fence);
  }
  markResyncRequired(id: string) {
    this.sqlite
      .prepare(
        "UPDATE sync_scopes SET state='resync_required',updated_at=? WHERE id=?",
      )
      .run(now(), id);
  }
  casCursor(id: string, revision: number, fence: number, cursor: string) {
    const r = this.sqlite
      .prepare(
        "UPDATE sync_scopes SET source_cursor=?,checkpoint_revision=checkpoint_revision+1,updated_at=? WHERE id=? AND checkpoint_revision=? AND fence_token=?",
      )
      .run(cursor, now(), id, revision, fence);
    if (!r.changes) throw new Error("connector_checkpoint_conflict");
  }
  createRun(scopeId: string, mode: string) {
    const id = randomUUID(),
      t = now();
    this.sqlite
      .prepare(
        "INSERT INTO sync_runs(id,scope_id,mode,status,started_at) VALUES(?,?,?,?,?)",
      )
      .run(id, scopeId, mode, "running", t);
    return this.getRun(id)!;
  }
  getRun(id: string): SyncRun | null {
    return this.sqlite
      .prepare(
        "SELECT id,scope_id as scopeId,mode,status,processed,failed,error,started_at as startedAt,finished_at as finishedAt FROM sync_runs WHERE id=?",
      )
      .get(id) as SyncRun | null;
  }
  listRuns(): SyncRun[] {
    return this.sqlite
      .prepare(
        "SELECT id,scope_id as scopeId,mode,status,processed,failed,error,started_at as startedAt,finished_at as finishedAt FROM sync_runs ORDER BY started_at DESC LIMIT 100",
      )
      .all() as SyncRun[];
  }
  listFailures() {
    return this.sqlite
      .prepare(
        "SELECT id,scope_id as scopeId,run_id as runId,kind as category,message,provider_item_id as itemKey,created_at as createdAt FROM sync_failures ORDER BY created_at DESC LIMIT 200",
      )
      .all();
  }
  /** 域投影等非致命失败的台账（阶段一软失败策略；见 manager.execute）。 */
  recordFailure(runId: string, scopeId: string, kind: string, message: string, providerItemId: string | null) {
    this.sqlite
      .prepare("INSERT INTO sync_failures(id,run_id,scope_id,kind,message,provider_item_id,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(randomUUID(), runId, scopeId, kind, message, providerItemId, now());
  }
  records(
    connectionId: string,
    recordType: "mail" | "calendar" = "mail",
    opts: { limit?: number; offset?: number; provider?: string } = {},
  ) {
    const where = ["connection_id=?", "record_type=?"],
      args: unknown[] = [connectionId, recordType];
    if (opts.provider) {
      where.push("provider=?");
      args.push(opts.provider);
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 500),
      offset = Math.max(0, opts.offset ?? 0);
    const rows = this.sqlite
      .prepare(
        `SELECT payload_json as payloadJson FROM connector_records WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Array<{ payloadJson: string }>;
    return rows.map((row) => JSON.parse(row.payloadJson) as ConnectorJsonRecord);
  }

  countRecords(
    connectionId: string,
    recordType: "mail" | "calendar" = "mail",
    provider?: string,
  ) {
    const r = provider
      ? this.sqlite
          .prepare(
            "SELECT count(*) n FROM connector_records WHERE connection_id=? AND record_type=? AND provider=?",
          )
          .get(connectionId, recordType, provider)
      : this.sqlite
          .prepare(
            "SELECT count(*) n FROM connector_records WHERE connection_id=? AND record_type=?",
          )
          .get(connectionId, recordType);
    return (r as any).n as number;
  }
  upsertRecord(
    connectionId: string,
    provider: ConnectorJsonRecord["provider"],
    recordType: ConnectorJsonRecord["type"],
    providerRecordId: string,
    data: ConnectorJsonRecord["data"],
  ) {
    const record: ConnectorJsonRecord = {
      schemaVersion: 1,
      type: recordType,
      provider,
      connectionId,
      data,
    };
    this.sqlite
      .prepare(
        "INSERT INTO connector_records(id,connection_id,provider,record_type,provider_record_id,payload_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_id,record_type,provider_record_id) DO UPDATE SET provider=excluded.provider,payload_json=excluded.payload_json,updated_at=excluded.updated_at",
      )
      .run(
        randomUUID(),
        connectionId,
        provider,
        recordType,
        providerRecordId,
        JSON.stringify(record),
        now(),
      );
    return record;
  }
  recover() {
    this.sqlite
      .prepare(
        "UPDATE sync_runs SET status='interrupted',finished_at=? WHERE status IN ('running','queued')",
      )
      .run(now());
  }
  applyPage(
    scopeId: string,
    runId: string,
    fence: number,
    changes: NormalizedMailChange[],
  ) {
    this.sqlite.transaction(() => {
      const scope = this.sqlite
        .prepare(
          "SELECT s.connection_id as connectionId,s.provider_scope_id as providerScopeId,s.fence_token as fenceToken,c.provider FROM sync_scopes s JOIN connector_connections c ON c.id=s.connection_id WHERE s.id=?",
        )
        .get(scopeId) as any;
      if (!scope || scope.fenceToken !== fence)
        throw new Error("connector_fence_conflict");
      for (const change of changes) {
        const m = change.kind === "upsert" ? change.message : null;
        const pid = m?.providerMessageId ?? (change as any).providerMessageId;
        const existing = this.sqlite
          .prepare(
            "SELECT id,provider_revision as revision FROM mail_messages WHERE connection_id=? AND provider_message_id=?",
          )
          .get(scope.connectionId, pid) as any;
        const id = existing?.id ?? randomUUID();
        if (change.kind === "tombstone") {
          this.sqlite
            .prepare(
              "DELETE FROM mail_memberships WHERE message_id=? AND scope_id=?",
            )
            .run(id, scopeId);
          const memberships = this.sqlite
            .prepare(
              "SELECT 1 FROM mail_memberships WHERE message_id=? LIMIT 1",
            )
            .get(id);
          if (!memberships)
            this.sqlite
              .prepare(
                "DELETE FROM connector_records WHERE connection_id=? AND record_type='mail' AND provider_record_id=?",
              )
              .run(scope.connectionId, pid);
          if (!memberships)
            this.sqlite
              .prepare(
                "INSERT INTO mail_messages(id,connection_id,provider_message_id,provider_thread_id,is_tombstone,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(connection_id,provider_message_id) DO UPDATE SET is_tombstone=1,updated_at=excluded.updated_at",
              )
              .run(
                id,
                scope.connectionId,
                pid,
                change.providerThreadId ?? null,
                now(),
              );
        } else {
          const m = change.message;
          this.upsertRecord(
            scope.connectionId,
            scope.provider,
            "mail",
            m.providerMessageId,
            m satisfies NormalizedMail,
          );
          this.sqlite
            .prepare(
              "INSERT INTO mail_messages(id,connection_id,provider_message_id,provider_thread_id,subject,snippet,text_body,html_body,received_at,sent_at,is_read,is_starred,is_draft,provider_revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,provider_message_id) DO UPDATE SET provider_thread_id=excluded.provider_thread_id,subject=excluded.subject,snippet=excluded.snippet,text_body=excluded.text_body,html_body=excluded.html_body,received_at=excluded.received_at,sent_at=excluded.sent_at,is_read=excluded.is_read,is_starred=excluded.is_starred,is_draft=excluded.is_draft,provider_revision=excluded.provider_revision,is_tombstone=0,updated_at=excluded.updated_at",
            )
            .run(
              id,
              scope.connectionId,
              pid,
              m.providerThreadId ?? null,
              m.subject ?? null,
              m.snippet ?? null,
              m.textBody ?? null,
              m.htmlBody ?? null,
              m.receivedAt ?? null,
              m.sentAt ?? null,
              m.isRead ? 1 : 0,
              m.isStarred ? 1 : 0,
              m.isDraft ? 1 : 0,
              m.providerRevision ?? null,
              now(),
            );
          if (m.providerThreadId)
            this.sqlite
              .prepare(
                "INSERT INTO mail_threads(id,connection_id,provider_thread_id,subject,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,provider_thread_id) DO UPDATE SET subject=excluded.subject,updated_at=excluded.updated_at",
              )
              .run(
                randomUUID(),
                scope.connectionId,
                m.providerThreadId,
                m.subject ?? null,
                now(),
              );
          this.sqlite
            .prepare("DELETE FROM mail_addresses WHERE message_id=?")
            .run(id);
          for (const [position, a] of (m.addresses ?? []).entries())
            this.sqlite
              .prepare(
                "INSERT INTO mail_addresses(id,message_id,role,position,display_name,address) VALUES(?,?,?,?,?,?)",
              )
              .run(
                randomUUID(),
                id,
                a.role,
                position,
                a.displayName ?? null,
                a.address.toLowerCase(),
              );
          this.sqlite
            .prepare(
              "DELETE FROM mail_memberships WHERE message_id=? AND scope_id=?",
            )
            .run(id, scopeId);
          const memberships =
            scope.provider === "outlook"
              ? [scope.providerScopeId, ...(m.memberships ?? [])]
              : (m.memberships ?? []);
          for (const membership of memberships)
            this.sqlite
              .prepare(
                "INSERT OR IGNORE INTO mail_memberships(message_id,scope_id,membership_key) VALUES(?,?,?)",
              )
              .run(id, scopeId, membership);
          this.sqlite
            .prepare("DELETE FROM mail_attachments WHERE message_id=?")
            .run(id);
          for (const a of m.attachments ?? [])
            this.sqlite
              .prepare(
                "INSERT INTO mail_attachments(id,message_id,provider_id,filename,mime_type,size,inline_attachment) VALUES(?,?,?,?,?,?,?)",
              )
              .run(
                randomUUID(),
                id,
                a.providerId ?? null,
                a.filename ?? null,
                a.mimeType ?? null,
                a.size ?? null,
                a.inline ? 1 : 0,
              );
        }
        this.sqlite
          .prepare(
            "INSERT OR IGNORE INTO sync_changes(event_key,connection_id,scope_id,message_id,kind,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            key(scope.connectionId, scopeId, change, existing?.revision),
            scope.connectionId,
            scopeId,
            id,
            change.kind,
            now(),
          );
      }
      this.sqlite
        .prepare(
          "UPDATE sync_scopes SET delivery_cursor=(SELECT COALESCE(MAX(sequence),0) FROM sync_changes WHERE scope_id=?),updated_at=? WHERE id=?",
        )
        .run(scopeId, now(), scopeId);
      this.sqlite
        .prepare("UPDATE sync_runs SET processed=processed+? WHERE id=?")
        .run(changes.length, runId);
    })();
  }
  applyCalendarPage(scopeId: string, runId: string, fence: number, changes: NormalizedCalendarChange[]) {
    if (!changes.length) return;
    this.sqlite.transaction(() => {
      const scope = this.sqlite.prepare("SELECT s.connection_id as connectionId,s.fence_token as fenceToken,c.provider FROM sync_scopes s JOIN connector_connections c ON c.id=s.connection_id WHERE s.id=?").get(scopeId) as any;
      if (!scope || scope.fenceToken !== fence) throw new Error("connector_fence_conflict");
      for (const change of changes) {
        const id = change.kind === "upsert" ? change.event.providerEventId : change.providerEventId;
        if (change.kind === "upsert") this.upsertRecord(scope.connectionId, scope.provider, "calendar", id, change.event);
        else this.sqlite.prepare("DELETE FROM connector_records WHERE connection_id=? AND record_type='calendar' AND provider_record_id=?").run(scope.connectionId, id);
        this.sqlite.prepare("INSERT OR IGNORE INTO sync_changes(event_key,connection_id,scope_id,message_id,kind,created_at) VALUES(?,?,?,?,?,?)").run(calendarKey(scope.connectionId, scopeId, change), scope.connectionId, scopeId, null, change.kind, now());
      }
      this.sqlite.prepare("UPDATE sync_scopes SET delivery_cursor=(SELECT COALESCE(MAX(sequence),0) FROM sync_changes WHERE scope_id=?),updated_at=? WHERE id=?").run(scopeId, now(), scopeId);
      this.sqlite.prepare("UPDATE sync_runs SET processed=processed+? WHERE id=?").run(changes.length, runId);
    })();
  }
  incrementRunProcessed(runId: string, count: number) {
    if (count <= 0) return;
    this.sqlite.prepare("UPDATE sync_runs SET processed=processed+? WHERE id=?").run(count, runId);
  }
  finishRun(id: string, status: string, error?: string) {
    this.sqlite
      .prepare("UPDATE sync_runs SET status=?,error=?,finished_at=? WHERE id=?")
      .run(status, error ?? null, now(), id);
  }
  messages(
    connectionId: string,
    opts: { limit?: number; offset?: number; provider?: string } = {},
  ): MailMessage[] {
    const join = opts.provider
      ? "JOIN connector_connections c ON c.id=connection_id AND c.provider=?"
      : "";
    const args = opts.provider ? [opts.provider, connectionId] : [connectionId];
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 500),
      offset = Math.max(0, opts.offset ?? 0);
    const rows = this.sqlite
      .prepare(
        `SELECT id,connection_id as connectionId,provider_message_id as providerMessageId,provider_thread_id as providerThreadId,subject,snippet,text_body as textBody,html_body as htmlBody,received_at as receivedAt,sent_at as sentAt,is_read as isRead,is_starred as isStarred,is_draft as isDraft,is_tombstone as isTombstone,updated_at as updatedAt FROM mail_messages ${join} WHERE connection_id=? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Array<
      Omit<MailMessage, "isRead" | "isStarred" | "isDraft" | "isTombstone"> & {
        isRead: number;
        isStarred: number;
        isDraft: number;
        isTombstone: number;
      }
    >;
    return rows.map((row) => ({
      ...row,
      isRead: row.isRead === 1,
      isStarred: row.isStarred === 1,
      isDraft: row.isDraft === 1,
      isTombstone: row.isTombstone === 1,
    }));
  }

  countMessages(connectionId: string, provider?: string) {
    const r = provider
      ? this.sqlite
          .prepare(
            "SELECT count(*) n FROM mail_messages m JOIN connector_connections c ON c.id=m.connection_id AND c.provider=? WHERE m.connection_id=?",
          )
          .get(provider, connectionId)
      : this.sqlite
          .prepare("SELECT count(*) n FROM mail_messages WHERE connection_id=?")
          .get(connectionId);
    return (r as any).n as number;
  }
}
