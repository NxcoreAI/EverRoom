import { randomUUID } from "node:crypto";
import type {
  ConnectorProvider,
  SyncMode,
  SyncRun,
} from "@nxcore/connector-contract";
import type { ConnectorExecutor } from "./types.js";
import { ConnectorDocumentStore } from "./document-store.js";
import { calendarEventToMarkdown, mailToMarkdown } from "./connector-memory.js";
import { ConnectorRepository } from "./repository.js";

export class ConnectorManager {
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  /** 同步数据入库记忆的扇出（create-server 注入 MemoryService）；失败不阻塞同步本身。 */
  private memorySink:
    | ((input: { kind: "document" | "mail" | "calendar"; provider: string; connectionId: string; documentId: string; title: string; markdown: string; calendarId?: string }) => Promise<void>)
    | null = null;

  setMemorySink(
    sink: (input: { kind: "document" | "mail" | "calendar"; provider: string; connectionId: string; documentId: string; title: string; markdown: string; calendarId?: string }) => Promise<void>,
  ) {
    this.memorySink = sink;
  }
  constructor(
    public readonly repository: ConnectorRepository,
    private readonly executor: ConnectorExecutor | null,
    private readonly documentStore: ConnectorDocumentStore | null = null,
  ) {
    repository.recover();
  }
  async register(input: {
    provider: ConnectorProvider;
    nangoConfigKey: string;
    nangoConnectionId: string;
    filters?: Record<string, unknown>;
    /**
     * 首次连接的首同步暂缓（授权流程用）：桌面端先弹过滤偏好引导，
     * 用户设置完成后再显式触发——否则首批数据在偏好生效前就被过滤。
     * 暂缓期间由轮询周期兜底（默认 5 分钟后无论如何开始同步）。
     */
    deferFirstSync?: boolean;
  }) {
    const c = this.repository.registerConnection(input);
    try {
      const scopes = this.executor?.discoverScopes
        ? await this.executor.discoverScopes(c)
        : [
            {
              id: input.provider === "gmail" ? "me" : input.provider === "google-calendar" ? "primary" : "inbox",
              displayName: input.provider === "gmail" ? "Mailbox" : input.provider === "google-calendar" ? "Primary calendar" : "Inbox",
            },
          ];
      // 重复注册（重装/重连）时 scope 已存在——只有新建的 scope 才需要首同步
      const knownBefore = new Set(
        this.repository.listScopes().filter((s) => s.connectionId === c.id).map((s) => s.providerScopeId),
      );
      const created: string[] = [];
      for (const scope of scopes) {
        const ensured = this.repository.ensureScope(c.id, scope.id, scope.displayName);
        if (!knownBefore.has(scope.id)) created.push(ensured.id);
      }
      // 首次连接立即触发全量同步：不等轮询周期（默认 5 分钟）——
      // "连接成功但什么都不发生"是最迷惑的首次体验。失败静默，轮询兜底。
      if (created.length > 0 && this.executor && !input.deferFirstSync) {
        for (const scopeId of created) {
          try {
            this.trigger(scopeId, "full");
          } catch {
            // 轮询周期会重试，注册流程不因首同步失败回滚连接
          }
        }
      }
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
        this.repository.applyCalendarPage(scope.id, run.id, fence, page.calendarChanges ?? []);
        for (const change of page.changes) {
          if (change.kind !== "upsert" || !this.memorySink) continue;
          await this.memorySink({
            kind: "mail",
            provider: connection.provider,
            connectionId: connection.id,
            documentId: change.message.providerMessageId,
            title: change.message.subject?.trim() || "（无主题）",
            markdown: mailToMarkdown(change.message),
          }).catch(() => {});
        }
        for (const change of page.calendarChanges ?? []) {
          if (change.kind !== "upsert" || !this.memorySink) continue;
          await this.memorySink({
            kind: "calendar",
            provider: connection.provider,
            connectionId: connection.id,
            documentId: change.event.providerEventId,
            title: change.event.title.trim() || "（无标题）",
            markdown: calendarEventToMarkdown(change.event),
            // scope 按"每个日历"建立：providerScopeId 即日历 id，进规则信号做日历级归因
            calendarId: scope.providerScopeId,
          }).catch(() => {});
        }
        for (const document of page.documents ?? []) {
          if (!this.documentStore) throw new Error("connector_document_store_unavailable");
          await this.documentStore.write(connection.provider, connection.id, document);
          if (this.memorySink)
            await this.memorySink({
              kind: "document",
              provider: connection.provider,
              connectionId: connection.id,
              documentId: document.providerDocumentId,
              title: document.title,
              markdown: document.markdown,
            }).catch(() => {});
        }
        this.repository.incrementRunProcessed(run.id, page.documents?.length ?? 0);
        if (page.terminalCursor)
          this.repository.casCursor(scope.id, base, fence, page.terminalCursor);
      }
      this.repository.finishRun(run.id, "completed");
    } catch (error) {
      if (
        ((error as any)?.response?.status === 404 &&
          connection.provider === "gmail") ||
        ((error as any)?.response?.status === 410 &&
          (connection.provider === "outlook" || connection.provider === "google-calendar"))
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
  async listDocuments(connectionId: string) {
    const connection = this.documentConnection(connectionId);
    return this.documentStore!.list(connection.provider, connection.id);
  }
  async readDocument(connectionId: string, documentId: string) {
    const connection = this.documentConnection(connectionId);
    return this.documentStore!.read(connection.provider, connection.id, documentId);
  }
  private documentConnection(connectionId: string) {
    const connection = this.repository.getConnection(connectionId);
    if (!connection || (connection.provider !== "google-docs" && connection.provider !== "notion"))
      throw new Error("document_connection_not_found");
    if (!this.documentStore) throw new Error("connector_document_store_unavailable");
    return connection;
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
