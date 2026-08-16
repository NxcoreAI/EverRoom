import { randomUUID } from "node:crypto";
import type {
  ConnectorProvider,
  SyncMode,
  SyncRun,
} from "@nxcore/connector-contract";
import type { ConnectorExecutor } from "./types.js";
import { ConnectorRepository } from "./repository.js";

export class ConnectorManager {
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(
    public readonly repository: ConnectorRepository,
    private readonly executor: ConnectorExecutor | null,
  ) {
    repository.recover();
  }
  async register(input: {
    provider: ConnectorProvider;
    nangoConfigKey: string;
    nangoConnectionId: string;
    filters?: Record<string, unknown>;
  }) {
    const c = this.repository.registerConnection(input);
    try {
      const scopes = this.executor?.discoverScopes
        ? await this.executor.discoverScopes(c)
        : [
            {
              id: input.provider === "gmail" ? "me" : "inbox",
              displayName: input.provider === "gmail" ? "Mailbox" : "Inbox",
            },
          ];
      for (const scope of scopes)
        this.repository.ensureScope(c.id, scope.id, scope.displayName);
      return c;
    } catch (error) {
      this.repository.purgeConnection(c.id);
      throw error;
    }
  }
  trigger(scopeId: string, mode: SyncMode): SyncRun {
    const existing = this.repository
      .listRuns()
      .find((r) => r.scopeId === scopeId && r.status === "running");
    if (existing) return existing;
    if (!this.executor) throw new Error("connectors_disabled");
    const scope = this.repository.getScope(scopeId),
      connection = scope && this.repository.getConnection(scope.connectionId);
    if (
      !scope ||
      !connection ||
      connection.status !== "active" ||
      scope.state === "disabled"
    )
      throw new Error("connection_disabled");
    if (scope.state === "resync_required") mode = "rebuild";
    const run = this.repository.createRun(scopeId, mode);
    const task = this.execute(run, mode).finally(() =>
      this.active.delete(scopeId),
    );
    this.active.set(scopeId, task);
    return run;
  }
  private async execute(run: SyncRun, mode: SyncMode) {
    const owner = randomUUID(),
      scope = this.repository.getScope(run.scopeId)!;
    const connection = this.repository.getConnection(scope.connectionId)!;
    const fence = this.repository.acquireLease(scope.id, owner);
    if (fence === null) {
      this.repository.finishRun(run.id, "failed", "scope_busy");
      return;
    }
    const base = this.repository.getScope(scope.id)!.checkpointRevision;
    try {
      for await (const page of this.executor!.pull(
        {
          ...scope,
          provider: connection.provider,
          nangoConnectionId: connection.nangoConnectionId,
          nangoConfigKey: connection.nangoConfigKey,
        },
        mode,
      )) {
        if (this.cancelled.has(run.id)) throw new Error("cancelled");
        this.repository.applyPage(scope.id, run.id, fence, page.changes);
        if (page.terminalCursor)
          this.repository.casCursor(scope.id, base, fence, page.terminalCursor);
      }
      this.repository.finishRun(run.id, "completed");
    } catch (error) {
      if (
        ((error as any)?.response?.status === 404 &&
          connection.provider === "gmail") ||
        ((error as any)?.response?.status === 410 &&
          connection.provider === "outlook")
      )
        this.repository.markResyncRequired(scope.id);
      this.repository.finishRun(
        run.id,
        "failed",
        error instanceof Error ? error.message : "sync_failed",
      );
    } finally {
      this.cancelled.delete(run.id);
      this.repository.releaseLease(scope.id, owner, fence);
    }
  }
  cancel(runId: string) {
    this.cancelled.add(runId);
    return this.repository.getRun(runId);
  }
  startPolling(intervalMs: number) {
    if (this.timer) return;
    const poll = () => {
      for (const scope of this.repository.listScopes())
        if (scope.state !== "disabled")
          try {
            this.trigger(scope.id, scope.sourceCursor ? "incremental" : "full");
          } catch {}
    };
    this.timer = setInterval(poll, intervalMs);
    this.timer.unref();
    queueMicrotask(poll);
  }
  async dispose() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled(this.active.values());
  }
}
