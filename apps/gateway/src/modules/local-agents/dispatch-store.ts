import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  localAgentDispatches,
  type LocalAgentDispatchMaterialRecord,
} from "../../infrastructure/database/schema.js";
import type { LocalAgentDelegationContext } from "@nxcore/agent-contract";

export type LocalAgentDispatchStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface LocalAgentDispatchRecord {
  id: string;
  sessionId: string;
  parentRunId: string;
  agentId: string;
  displayName: string;
  provider: string;
  assignment: string;
  sharedGoal: string | null;
  constraints: string[];
  materials: LocalAgentDispatchMaterialRecord[];
  packageJson: string;
  packageDigest: string;
  packageVersion: number;
  status: LocalAgentDispatchStatus;
  resultText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  subRunId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLocalAgentDispatchInput {
  sessionId: string;
  parentRunId: string;
  agentId: string;
  displayName: string;
  provider: string;
  assignment: string;
  sharedGoal?: string;
  constraints: string[];
  materials: LocalAgentDispatchMaterialRecord[];
  packagePayload: LocalAgentDelegationContext;
  subRunId: string;
}

type DispatchRow = typeof localAgentDispatches.$inferSelect;

function toRecord(row: DispatchRow): LocalAgentDispatchRecord {
  return { ...row };
}

export class LocalAgentDispatchStore {
  constructor(private readonly db: GatewayDatabase) {}

  create(input: CreateLocalAgentDispatchInput): LocalAgentDispatchRecord {
    const now = new Date();
    const row: typeof localAgentDispatches.$inferInsert = {
      id: randomUUID(),
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      agentId: input.agentId,
      displayName: input.displayName,
      provider: input.provider,
      assignment: input.assignment,
      ...(input.sharedGoal ? { sharedGoal: input.sharedGoal } : {}),
      constraints: input.constraints,
      materials: input.materials,
      packageJson: JSON.stringify(input.packagePayload),
      packageDigest: input.packagePayload.provenance.digest,
      packageVersion: this.nextVersion(input.parentRunId),
      status: "pending",
      subRunId: input.subRunId,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(localAgentDispatches).values(row).run();
    return this.get(row.id)!;
  }

  markRunning(id: string): void {
    this.db.update(localAgentDispatches).set({ status: "running", updatedAt: new Date() })
      .where(eq(localAgentDispatches.id, id)).run();
  }

  complete(id: string, resultText: string): void {
    this.db.update(localAgentDispatches).set({
      status: "completed",
      resultText,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(localAgentDispatches.id, id)).run();
  }

  fail(id: string, status: "failed" | "cancelled" | "timed_out", errorCode: string, errorMessage?: string): void {
    this.db.update(localAgentDispatches).set({
      status,
      errorCode,
      ...(errorMessage ? { errorMessage } : {}),
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(localAgentDispatches.id, id)).run();
  }

  get(id: string): LocalAgentDispatchRecord | null {
    const row = this.db.select().from(localAgentDispatches)
      .where(eq(localAgentDispatches.id, id)).get();
    return row ? toRecord(row) : null;
  }

  getByParentRun(parentRunId: string): LocalAgentDispatchRecord[] {
    return this.db.select().from(localAgentDispatches)
      .where(eq(localAgentDispatches.parentRunId, parentRunId))
      .orderBy(desc(localAgentDispatches.packageVersion)).all()
      .map(toRecord);
  }

  getBySession(sessionId: string): LocalAgentDispatchRecord[] {
    return this.db.select().from(localAgentDispatches)
      .where(eq(localAgentDispatches.sessionId, sessionId))
      .orderBy(desc(localAgentDispatches.createdAt)).all()
      .map(toRecord);
  }

  nextVersion(parentRunId: string): number {
    const rows = this.db.select({ version: localAgentDispatches.packageVersion })
      .from(localAgentDispatches)
      .where(eq(localAgentDispatches.parentRunId, parentRunId))
      .orderBy(desc(localAgentDispatches.packageVersion))
      .limit(1).all();
    return (rows[0]?.version ?? 0) + 1;
  }
}
