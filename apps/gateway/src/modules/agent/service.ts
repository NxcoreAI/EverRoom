import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentEventType,
  AgentMessage,
  AgentRun,
  AgentRunStatus,
  AgentSession,
  AgentSessionSnapshot,
  CreateAgentSessionInput,
  StartAgentRunInput,
  UpdateAgentSessionInput,
} from "@nxcore/agent-contract";
import type { AgentRuntime, RuntimeEvent } from "@nxcore/agent-runtime";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentEvents,
  agentMessages,
  agentRuns,
  agentSessions,
} from "../../infrastructure/database/schema.js";
import { AgentEventBroker } from "./event-broker.js";

export interface AgentServiceLogger {
  info(bindings: Record<string, unknown>, message: string): void;
}

const silentLogger: AgentServiceLogger = { info: () => undefined };

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function toSession(row: typeof agentSessions.$inferSelect): AgentSession {
  return {
    id: row.id,
    roomId: row.roomId,
    pageLabel: row.pageLabel,
    runtimeId: row.runtimeId,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRun(row: typeof agentRuns.$inferSelect): AgentRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    prompt: row.prompt,
    lastEventSeq: row.lastEventSeq,
    error: row.error,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function toMessage(row: typeof agentMessages.$inferSelect): AgentMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AgentService {
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly runtime: AgentRuntime,
    readonly broker: AgentEventBroker,
    private readonly logger: AgentServiceLogger = silentLogger,
  ) {}

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }

  createSession(input: CreateAgentSessionInput): AgentSession {
    const now = new Date();
    const row: typeof agentSessions.$inferInsert = {
      id: randomUUID(),
      roomId: input.roomId ?? null,
      pageLabel: input.pageLabel.trim(),
      runtimeId: this.runtime.id,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    const created = this.db.insert(agentSessions).values(row).returning().get();
    return toSession(created);
  }

  listSessions(pageLabel?: string): AgentSession[] {
    const query = this.db.select().from(agentSessions);
    const rows = pageLabel === undefined
      ? query.orderBy(desc(agentSessions.updatedAt), desc(agentSessions.createdAt)).all()
      : query.where(eq(agentSessions.pageLabel, pageLabel)).orderBy(
        desc(agentSessions.updatedAt),
        desc(agentSessions.createdAt),
      ).all();
    return rows.map(toSession);
  }

  updateSession(sessionId: string, input: UpdateAgentSessionInput): AgentSession | null {
    const updated = this.db.update(agentSessions)
      .set({ title: input.title.trim(), updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))
      .returning()
      .get();
    return updated ? toSession(updated) : null;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (!session) return false;
    if (session.status === "running") throw new Error("agent_session_busy");
    if (session.runtimeId === this.runtime.id && session.runtimeSessionRef) {
      await this.runtime.deleteSession(session.runtimeSessionRef);
    }
    this.db.delete(agentSessions).where(eq(agentSessions.id, sessionId)).run();
    return true;
  }

  getSnapshot(sessionId: string): AgentSessionSnapshot | null {
    const sessionRow = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (!sessionRow) return null;
    const messageRows = this.db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.sessionId, sessionId))
      .orderBy(asc(agentMessages.createdAt))
      .all();
    const activeRunRow = this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          inArray(agentRuns.status, ["accepted", "running"]),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .get();
    const lastRun = this.db
      .select({ lastEventSeq: agentRuns.lastEventSeq })
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, sessionId))
      .orderBy(desc(agentRuns.createdAt))
      .get();
    return {
      session: toSession(sessionRow),
      activeRun: activeRunRow ? toRun(activeRunRow) : null,
      messages: messageRows.map(toMessage),
      lastEventSeq: lastRun?.lastEventSeq ?? 0,
    };
  }

  getRun(runId: string): AgentRun | null {
    const row = this.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    return row ? toRun(row) : null;
  }

  listEvents(sessionId: string, runId: string | undefined, afterSeq: number): AgentEvent[] {
    const rows = this.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.sessionId, sessionId))
      .orderBy(asc(agentEvents.createdAt), asc(agentEvents.seq))
      .all();
    return rows
      .filter((row) => row.seq > afterSeq && (!runId || row.runId === runId))
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        runId: row.runId,
        seq: row.seq,
        type: row.type as AgentEventType,
        occurredAt: row.createdAt.toISOString(),
        payload: row.payload,
      }));
  }

  async startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun> {
    const existing = this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.sessionId, sessionId), eq(agentRuns.idempotencyKey, input.idempotencyKey)))
      .get();
    if (existing) return toRun(existing);

    let session = this.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
    if (!session) throw new Error("agent_session_not_found");
    if (session.status === "running") throw new Error("agent_session_busy");

    if (session.runtimeId !== this.runtime.id) {
      session = this.db.update(agentSessions)
        .set({ runtimeId: this.runtime.id, runtimeSessionRef: null, updatedAt: new Date() })
        .where(eq(agentSessions.id, sessionId))
        .returning()
        .get();
    }

    const now = new Date();
    const runId = randomUUID();
    const runRow: typeof agentRuns.$inferInsert = {
      id: runId,
      sessionId,
      idempotencyKey: input.idempotencyKey,
      status: "accepted",
      prompt: input.prompt,
      lastEventSeq: 0,
      createdAt: now,
    };
    this.db.transaction((tx) => {
      tx.insert(agentRuns).values(runRow).run();
      tx.insert(agentMessages).values({
        id: randomUUID(),
        sessionId,
        runId,
        role: "user",
        content: input.prompt,
        createdAt: now,
      }).run();
      tx.update(agentSessions)
        .set({ status: "running", updatedAt: now, title: session.title ?? input.prompt.slice(0, 48) })
        .where(eq(agentSessions.id, sessionId))
        .run();
    });
    this.sequences.set(runId, 0);
    this.logger.info(
      { event: "agent.input", sessionId, runId, content: input.prompt },
      "agent user input",
    );
    await this.appendEvent(sessionId, runId, { type: "run.accepted", payload: {} });

    let runtimeRun;
    try {
      runtimeRun = await this.runtime.start({
        runId,
        sessionId,
        runtimeSessionRef: session.runtimeSessionRef,
        prompt: input.prompt,
        pageLabel: session.pageLabel,
      });
    } catch (error) {
      await this.appendEvent(sessionId, runId, {
        type: "run.failed",
        payload: { message: error instanceof Error ? error.message : "Runtime failed to start" },
      });
      return this.getRun(runId)!;
    }
    this.db.update(agentSessions)
      .set({ runtimeSessionRef: runtimeRun.runtimeSessionRef, updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))
      .run();
    void this.consumeRuntimeEvents(sessionId, runId, runtimeRun.events);
    return this.getRun(runId)!;
  }

  async cancelRun(runId: string): Promise<AgentRun | null> {
    const run = this.getRun(runId);
    if (!run) return null;
    if (run.status === "accepted" || run.status === "running") await this.runtime.cancel(runId);
    return this.getRun(runId);
  }

  private async consumeRuntimeEvents(
    sessionId: string,
    runId: string,
    events: AsyncIterable<RuntimeEvent>,
  ): Promise<void> {
    try {
      for await (const event of events) await this.appendEvent(sessionId, runId, event);
    } catch (error) {
      await this.appendEvent(sessionId, runId, {
        type: "run.failed",
        payload: { message: error instanceof Error ? error.message : "Runtime failed" },
      });
    }
  }

  private async appendEvent(sessionId: string, runId: string, runtimeEvent: RuntimeEvent): Promise<void> {
    if (runtimeEvent.type === "message.delta") {
      const delta = (runtimeEvent.payload as { delta?: unknown }).delta;
      if (typeof delta === "string") {
        this.logger.info(
          { event: "agent.output.delta", sessionId, runId, delta },
          "agent assistant output delta",
        );
      }
    } else if (runtimeEvent.type === "message.completed") {
      const content = (runtimeEvent.payload as { content?: unknown }).content;
      if (typeof content === "string") {
        this.logger.info(
          { event: "agent.output.completed", sessionId, runId, content },
          "agent assistant output completed",
        );
      }
    }

    const seq = (this.sequences.get(runId) ?? this.getRun(runId)?.lastEventSeq ?? 0) + 1;
    this.sequences.set(runId, seq);
    const now = new Date();
    const event: AgentEvent = {
      id: randomUUID(),
      sessionId,
      runId,
      seq,
      type: runtimeEvent.type,
      occurredAt: now.toISOString(),
      payload: runtimeEvent.payload,
    };

    const terminalStatus: Partial<Record<AgentEventType, AgentRunStatus>> = {
      "run.completed": "completed",
      "run.failed": "failed",
      "run.cancelled": "cancelled",
      "run.interrupted": "interrupted",
    };
    const nextStatus = runtimeEvent.type === "run.started" ? "running" : terminalStatus[runtimeEvent.type];

    this.db.transaction((tx) => {
      tx.insert(agentEvents).values({
        id: event.id,
        sessionId,
        runId,
        seq,
        type: event.type,
        payload: event.payload,
        createdAt: now,
      }).run();
      tx.update(agentRuns)
        .set({
          lastEventSeq: seq,
          ...(nextStatus ? { status: nextStatus } : {}),
          ...(runtimeEvent.type === "run.started" ? { startedAt: now } : {}),
          ...(nextStatus && nextStatus !== "running" ? { completedAt: now } : {}),
          ...(runtimeEvent.type === "run.failed"
            ? { error: String((runtimeEvent.payload as { message?: unknown }).message ?? "Runtime failed") }
            : {}),
        })
        .where(eq(agentRuns.id, runId))
        .run();

      if (runtimeEvent.type === "message.completed") {
        const payload = runtimeEvent.payload as { content?: unknown };
        tx.insert(agentMessages).values({
          id: randomUUID(),
          sessionId,
          runId,
          role: "assistant",
          content: typeof payload.content === "string" ? payload.content : "",
          createdAt: now,
        }).run();
      }
      if (nextStatus && nextStatus !== "running") {
        tx.update(agentSessions)
          .set({ status: nextStatus === "interrupted" ? "interrupted" : "idle", updatedAt: now })
          .where(eq(agentSessions.id, sessionId))
          .run();
      }
    });
    this.broker.publish(event);
    if (nextStatus && nextStatus !== "running") this.sequences.delete(runId);
  }
}
