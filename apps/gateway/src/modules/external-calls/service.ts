import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const EXTERNAL_CALL_SERVICES = ["WEB_SEARCH", "MCP", "CONNECTOR"] as const;
export const EXTERNAL_CALL_SCOPES = ["user", "workspace", "service"] as const;
export const EXTERNAL_CALL_PERIODS = ["UTC_DAY", "UTC_MONTH"] as const;
export const EXTERNAL_CALL_ENFORCEMENTS = ["BLOCK", "AUDIT_ONLY"] as const;

export type ExternalCallService = typeof EXTERNAL_CALL_SERVICES[number];
export type ExternalCallScope = typeof EXTERNAL_CALL_SCOPES[number];
export type ExternalCallPeriod = typeof EXTERNAL_CALL_PERIODS[number];
export type ExternalCallEnforcement = typeof EXTERNAL_CALL_ENFORCEMENTS[number];

export interface ExternalCallContext {
  userId?: string;
  workspaceId?: string;
  source: string;
  runId?: string;
  correlationId?: string;
}

export type ExternalCallIdentity = Pick<ExternalCallContext, "userId" | "workspaceId">;

export interface ExternalCallPolicyInput {
  id?: string;
  subjectScope: ExternalCallScope;
  subjectId: string;
  service: ExternalCallService;
  period: ExternalCallPeriod;
  limit: number;
  warningThreshold: number;
  enforcement: ExternalCallEnforcement;
}

export interface ExternalCallPolicy extends Required<ExternalCallPolicyInput> {
  createdAt: string;
  updatedAt: string;
}

export interface ExternalCallUsage {
  policyId: string;
  subjectScope: ExternalCallScope;
  subjectId: string;
  service: ExternalCallService;
  period: ExternalCallPeriod;
  periodStart: string;
  reservedCalls: number;
  consumedCalls: number;
  limit: number;
  warningThreshold: number;
  enforcement: ExternalCallEnforcement;
  nearLimit: boolean;
  atLimit: boolean;
}

export interface ExternalCallAudit {
  id: string;
  subjectScope: ExternalCallScope;
  subjectId: string;
  workspaceId: string | null;
  userId: string | null;
  service: ExternalCallService;
  tool: string;
  occurredAt: string;
  source: string;
  runId: string | null;
  correlationId: string | null;
  reservedCalls: number;
  consumedCalls: number;
  durationMs: number;
  outcome: "SUCCEEDED" | "FAILED" | "RELEASED" | "BLOCKED";
  failureCode: "PROVIDER_FAILURE" | "NOT_DISPATCHED" | "BUDGET_EXCEEDED" | "CANCELLED" | null;
}

export interface Page<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
}

interface PolicyRow {
  id: string;
  subject_scope: ExternalCallScope;
  subject_id: string;
  service: ExternalCallService;
  period: ExternalCallPeriod;
  call_limit: number;
  warning_threshold: number;
  enforcement: ExternalCallEnforcement;
  created_at: number;
  updated_at: number;
}

interface UsageRow extends PolicyRow {
  policy_id: string;
  period_start: number;
  reserved_calls: number;
  consumed_calls: number;
}

interface Reservation {
  id: string;
  policyIds: string[];
  context: ExternalCallContext;
  service: ExternalCallService;
  tool: string;
  startedAt: number;
}

export class ExternalCallBudgetExceededError extends Error {
  readonly code = "EXTERNAL_CALL_BUDGET_EXCEEDED";
  readonly recoverable = true;

  constructor(readonly blockedPolicyIds: string[]) {
    super(JSON.stringify({
      error: "external_call_budget_exceeded",
      recoverable: true,
      instruction: "Skip this tool and continue with another available path.",
    }));
    this.name = "ExternalCallBudgetExceededError";
  }
}

function periodStart(period: ExternalCallPeriod, now: Date): number {
  return period === "UTC_DAY"
    ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function policy(row: PolicyRow): ExternalCallPolicy {
  return {
    id: row.id,
    subjectScope: row.subject_scope,
    subjectId: row.subject_id,
    service: row.service,
    period: row.period,
    limit: row.call_limit,
    warningThreshold: row.warning_threshold,
    enforcement: row.enforcement,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function pageBounds(limit = 50, offset = 0): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(Math.trunc(limit), 1), 200),
    offset: Math.max(Math.trunc(offset), 0),
  };
}

export class ExternalCallBudgetService {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly now: () => Date = () => new Date(),
    private readonly identity: ExternalCallIdentity = {},
  ) {}

  upsertPolicy(input: ExternalCallPolicyInput): ExternalCallPolicy {
    if (!input.subjectId.trim()) throw new Error("external_call_policy_subject_required");
    if (input.subjectScope === "service" && input.subjectId !== input.service) {
      throw new Error("external_call_policy_service_subject_mismatch");
    }
    if (!Number.isInteger(input.limit) || input.limit < 0) throw new Error("external_call_policy_limit_invalid");
    if (!Number.isInteger(input.warningThreshold)
      || input.warningThreshold < 0
      || input.warningThreshold > input.limit) {
      throw new Error("external_call_policy_warning_threshold_invalid");
    }
    const now = this.now().getTime();
    const existing = this.sqlite.prepare(`SELECT id FROM external_call_policies
      WHERE subject_scope = ? AND subject_id = ? AND service = ? AND period = ?`)
      .get(input.subjectScope, input.subjectId.trim(), input.service, input.period) as { id: string } | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    this.sqlite.prepare(`
      INSERT INTO external_call_policies
        (id, subject_scope, subject_id, service, period, call_limit, warning_threshold, enforcement, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        subject_scope = excluded.subject_scope,
        subject_id = excluded.subject_id,
        service = excluded.service,
        period = excluded.period,
        call_limit = excluded.call_limit,
        warning_threshold = excluded.warning_threshold,
        enforcement = excluded.enforcement,
        updated_at = excluded.updated_at
    `).run(id, input.subjectScope, input.subjectId.trim(), input.service, input.period,
      input.limit, input.warningThreshold, input.enforcement, now, now);
    return policy(this.sqlite.prepare(`
      SELECT * FROM external_call_policies
      WHERE subject_scope = ? AND subject_id = ? AND service = ? AND period = ?
    `).get(input.subjectScope, input.subjectId.trim(), input.service, input.period) as PolicyRow);
  }

  deletePolicy(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM external_call_policies WHERE id = ?").run(id).changes > 0;
  }

  listPolicies(query: {
    subjectScope?: ExternalCallScope;
    subjectId?: string;
    service?: ExternalCallService;
    limit?: number;
    offset?: number;
  } = {}): Page<ExternalCallPolicy> {
    const { where, values } = this.filters(query);
    const bounds = pageBounds(query.limit, query.offset);
    const rows = this.sqlite.prepare(`SELECT * FROM external_call_policies ${where}
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`).all(...values, bounds.limit, bounds.offset) as PolicyRow[];
    const total = (this.sqlite.prepare(`SELECT count(*) AS count FROM external_call_policies ${where}`)
      .get(...values) as { count: number }).count;
    return { items: rows.map(policy), ...bounds, total };
  }

  listUsage(query: {
    subjectScope?: ExternalCallScope;
    subjectId?: string;
    service?: ExternalCallService;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  } = {}): Page<ExternalCallUsage> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.subjectScope) { clauses.push("p.subject_scope = ?"); values.push(query.subjectScope); }
    if (query.subjectId) { clauses.push("p.subject_id = ?"); values.push(query.subjectId); }
    if (query.service) { clauses.push("p.service = ?"); values.push(query.service); }
    if (query.from) { clauses.push("u.period_start >= ?"); values.push(query.from.getTime()); }
    if (query.to) { clauses.push("u.period_start < ?"); values.push(query.to.getTime()); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const bounds = pageBounds(query.limit, query.offset);
    const select = `FROM external_call_usage u JOIN external_call_policies p ON p.id = u.policy_id ${where}`;
    const rows = this.sqlite.prepare(`SELECT u.policy_id, u.period_start, u.reserved_calls, u.consumed_calls,
      p.* ${select} ORDER BY u.period_start DESC, p.id LIMIT ? OFFSET ?`)
      .all(...values, bounds.limit, bounds.offset) as UsageRow[];
    const total = (this.sqlite.prepare(`SELECT count(*) AS count ${select}`).get(...values) as { count: number }).count;
    return {
      items: rows.map((row) => {
        const used = row.reserved_calls + row.consumed_calls;
        return {
          policyId: row.policy_id,
          subjectScope: row.subject_scope,
          subjectId: row.subject_id,
          service: row.service,
          period: row.period,
          periodStart: iso(row.period_start),
          reservedCalls: row.reserved_calls,
          consumedCalls: row.consumed_calls,
          limit: row.call_limit,
          warningThreshold: row.warning_threshold,
          enforcement: row.enforcement,
          nearLimit: used >= row.warning_threshold && used < row.call_limit,
          atLimit: used >= row.call_limit,
        };
      }),
      ...bounds,
      total,
    };
  }

  listAudits(query: {
    subjectScope?: ExternalCallScope;
    subjectId?: string;
    service?: ExternalCallService;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  } = {}): Page<ExternalCallAudit> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.subjectScope && query.subjectId) {
      const column = query.subjectScope === "user" ? "user_id"
        : query.subjectScope === "workspace" ? "workspace_id" : "subject_id";
      clauses.push(`${column} = ?`);
      values.push(query.subjectId);
    } else if (query.subjectScope) {
      clauses.push("subject_scope = ?");
      values.push(query.subjectScope);
    } else if (query.subjectId) {
      clauses.push("(subject_id = ? OR user_id = ? OR workspace_id = ?)");
      values.push(query.subjectId, query.subjectId, query.subjectId);
    }
    if (query.service) { clauses.push("service = ?"); values.push(query.service); }
    if (query.from) { clauses.push("occurred_at >= ?"); values.push(query.from.getTime()); }
    if (query.to) { clauses.push("occurred_at < ?"); values.push(query.to.getTime()); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const bounds = pageBounds(query.limit, query.offset);
    const rows = this.sqlite.prepare(`SELECT * FROM external_call_audits ${where}
      ORDER BY occurred_at DESC, id LIMIT ? OFFSET ?`).all(...values, bounds.limit, bounds.offset) as Array<{
        id: string; subject_scope: ExternalCallScope; subject_id: string; workspace_id: string | null;
        user_id: string | null; service: ExternalCallService; tool: string; occurred_at: number; source: string;
        run_id: string | null; correlation_id: string | null; reserved_calls: number; consumed_calls: number;
        duration_ms: number; outcome: ExternalCallAudit["outcome"]; failure_code: ExternalCallAudit["failureCode"];
      }>;
    const total = (this.sqlite.prepare(`SELECT count(*) AS count FROM external_call_audits ${where}`)
      .get(...values) as { count: number }).count;
    return {
      items: rows.map((row) => ({
        id: row.id,
        subjectScope: row.subject_scope,
        subjectId: row.subject_id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        service: row.service,
        tool: row.tool,
        occurredAt: iso(row.occurred_at),
        source: row.source,
        runId: row.run_id,
        correlationId: row.correlation_id,
        reservedCalls: row.reserved_calls,
        consumedCalls: row.consumed_calls,
        durationMs: row.duration_ms,
        outcome: row.outcome,
        failureCode: row.failure_code,
      })),
      ...bounds,
      total,
    };
  }

  async execute<T>(
    service: ExternalCallService,
    tool: string,
    context: ExternalCallContext,
    invoke: (markDispatched: () => void) => Promise<T>,
  ): Promise<T> {
    const reservation = this.reserve(service, tool, { ...this.identity, ...context });
    let dispatched = false;
    try {
      const result = await invoke(() => { dispatched = true; });
      this.finish(reservation, true, "SUCCEEDED", null);
      return result;
    } catch (error) {
      if (dispatched) {
        const cancelled = error instanceof Error && (error.name === "AbortError" || /cancelled|aborted/i.test(error.message));
        this.finish(reservation, true, "FAILED", cancelled ? "CANCELLED" : "PROVIDER_FAILURE");
      } else {
        this.finish(reservation, false, "RELEASED", "NOT_DISPATCHED");
      }
      throw error;
    }
  }

  private reserve(service: ExternalCallService, tool: string, context: ExternalCallContext): Reservation {
    const startedAt = this.now().getTime();
    const subjects: Array<[ExternalCallScope, string]> = [["service", service]];
    if (context.workspaceId) subjects.push(["workspace", context.workspaceId]);
    if (context.userId) subjects.push(["user", context.userId]);
    const reservation: Reservation = { id: randomUUID(), policyIds: [], context, service, tool, startedAt };
    let blockedPolicyIds: string[] = [];

    const reserve = this.sqlite.transaction(() => {
      const policies = this.sqlite.prepare(`SELECT * FROM external_call_policies WHERE service = ? AND (${subjects
        .map(() => "(subject_scope = ? AND subject_id = ?)").join(" OR ")})`)
        .all(service, ...subjects.flat()) as PolicyRow[];
      const usage = policies.map((item) => {
        const start = periodStart(item.period, new Date(startedAt));
        this.sqlite.prepare(`INSERT INTO external_call_usage
          (policy_id, period_start, reserved_calls, consumed_calls, updated_at)
          VALUES (?, ?, 0, 0, ?) ON CONFLICT(policy_id, period_start) DO NOTHING`)
          .run(item.id, start, startedAt);
        const row = this.sqlite.prepare(`SELECT reserved_calls, consumed_calls FROM external_call_usage
          WHERE policy_id = ? AND period_start = ?`).get(item.id, start) as { reserved_calls: number; consumed_calls: number };
        return { policy: item, start, ...row };
      });
      const blocked = usage.filter(({ policy: item, reserved_calls, consumed_calls }) =>
        item.enforcement === "BLOCK" && reserved_calls + consumed_calls + 1 > item.call_limit);
      if (blocked.length) {
        blockedPolicyIds = blocked.map(({ policy: item }) => item.id);
        return;
      }
      for (const item of usage) {
        this.sqlite.prepare(`UPDATE external_call_usage SET reserved_calls = reserved_calls + 1, updated_at = ?
          WHERE policy_id = ? AND period_start = ?`).run(startedAt, item.policy.id, item.start);
      }
      reservation.policyIds = policies.map((item) => item.id);
      this.sqlite.prepare(`INSERT INTO external_call_reservations
        (id, policy_ids, service, tool, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)`)
        .run(reservation.id, JSON.stringify(reservation.policyIds), service, tool, startedAt, startedAt);
    });
    reserve.immediate();
    if (blockedPolicyIds.length) {
      this.insertAudit(reservation, 0, 0, "BLOCKED", "BUDGET_EXCEEDED", startedAt);
      throw new ExternalCallBudgetExceededError(blockedPolicyIds);
    }
    return reservation;
  }

  private finish(
    reservation: Reservation,
    consumed: boolean,
    outcome: ExternalCallAudit["outcome"],
    failureCode: ExternalCallAudit["failureCode"],
  ): void {
    const finishedAt = this.now().getTime();
    const finish = this.sqlite.transaction(() => {
      for (const policyId of reservation.policyIds) {
        const item = this.sqlite.prepare("SELECT period FROM external_call_policies WHERE id = ?")
          .get(policyId) as { period: ExternalCallPeriod } | undefined;
        if (!item) continue;
        const start = periodStart(item.period, new Date(reservation.startedAt));
        this.sqlite.prepare(`UPDATE external_call_usage SET reserved_calls = max(reserved_calls - 1, 0),
          consumed_calls = consumed_calls + ?, updated_at = ? WHERE policy_id = ? AND period_start = ?`)
          .run(consumed ? 1 : 0, finishedAt, policyId, start);
      }
      this.sqlite.prepare("UPDATE external_call_reservations SET state = ?, updated_at = ? WHERE id = ?")
        .run(consumed ? "CONSUMED" : "RELEASED", finishedAt, reservation.id);
      this.insertAudit(reservation, 1, consumed ? 1 : 0, outcome, failureCode, finishedAt);
    });
    finish.immediate();
  }

  private insertAudit(
    reservation: Reservation,
    reservedCalls: number,
    consumedCalls: number,
    outcome: ExternalCallAudit["outcome"],
    failureCode: ExternalCallAudit["failureCode"],
    occurredAt: number,
  ): void {
    const { context } = reservation;
    const subjectScope: ExternalCallScope = context.userId ? "user" : context.workspaceId ? "workspace" : "service";
    const subjectId = context.userId ?? context.workspaceId ?? reservation.service;
    this.sqlite.prepare(`INSERT INTO external_call_audits
      (id, subject_scope, subject_id, workspace_id, user_id, service, tool, occurred_at, source,
       run_id, correlation_id, reserved_calls, consumed_calls, duration_ms, outcome, failure_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), subjectScope, subjectId, context.workspaceId ?? null, context.userId ?? null,
        reservation.service, reservation.tool, occurredAt, context.source, context.runId ?? null,
        context.correlationId ?? null, reservedCalls, consumedCalls,
        Math.max(0, occurredAt - reservation.startedAt), outcome, failureCode);
  }

  private filters(query: { subjectScope?: ExternalCallScope; subjectId?: string; service?: ExternalCallService }): {
    where: string;
    values: unknown[];
  } {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (query.subjectScope) { clauses.push("subject_scope = ?"); values.push(query.subjectScope); }
    if (query.subjectId) { clauses.push("subject_id = ?"); values.push(query.subjectId); }
    if (query.service) { clauses.push("service = ?"); values.push(query.service); }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
  }
}
