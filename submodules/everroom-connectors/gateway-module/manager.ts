import { randomUUID } from "node:crypto";
import type {
  ConnectorProvider,
  SyncMode,
  SyncRun,
} from "@nxcore/connector-contract";
import type { ConnectorExecutor } from "./types.js";
import { ConnectorDocumentStore } from "./document-store.js";
import { calendarEventToMarkdown, mailToMarkdown } from "./connector-memory.js";
import type { ConnectorDomainProjection } from "./domain-projection.js";
import { ConnectorRepository } from "./repository.js";
import { syncProviderOf } from "./sync-providers/index.js";
import { SyncEngine } from "./sync-engine.js";

export class ConnectorManager {
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  /** 同步数据入库记忆的扇出（create-server 注入 MemoryService）；失败不阻塞同步本身。 */
  private memorySink:
    | ((input: { kind: "document" | "mail" | "calendar"; provider: string; connectionId: string; documentId: string; title: string; markdown: string; calendarId?: string; domainRowId?: string }) => Promise<void>)
    | null = null;
  /**
   * 域投影（阶段一）：归一化记录落主库 connector_* 域表，先于 memorySink。
   * 第一版软失败（记 sync_failures 计数，不阻断 ingest）；soak 后升硬失败。
   */
  private domainProjection: ConnectorDomainProjection | null = null;

  setMemorySink(
    sink: (input: { kind: "document" | "mail" | "calendar"; provider: string; connectionId: string; documentId: string; title: string; markdown: string; calendarId?: string; domainRowId?: string }) => Promise<void>,
  ) {
    this.memorySink = sink;
  }
  setDomainProjection(projection: ConnectorDomainProjection | null) {
    this.domainProjection = projection;
  }
  constructor(
    public readonly repository: ConnectorRepository,
    private readonly executor: ConnectorExecutor | null,
    private readonly documentStore: ConnectorDocumentStore | null = null,
    /** 阶段三：拉取引擎（nango/direct 分发）；缺省退化为仅 Nango 的引擎。 */
    engine?: SyncEngine | null,
  ) {
    this.engine = engine ?? new SyncEngine(executor, () => null);
    repository.recover();
  }
  private readonly engine: SyncEngine;
  async register(input: {
    provider: ConnectorProvider;
    /** oo 标识（Seam5：service/connectionName）。 */
    service: string;
    connectionName: string;
    filters?: Record<string, unknown>;
    authMethod?: "nango-oauth" | "api-token" | "webcal-url" | "password" | "manual-import";
    credentialsRef?: string | null;
    /**
     * 首次连接的首同步暂缓（授权流程用）：桌面端先弹过滤偏好引导，
     * 用户设置完成后再显式触发——否则首批数据在偏好生效前就被过滤。
     * 暂缓期间由轮询周期兜底（默认 5 分钟后无论如何开始同步）。
     */
    deferFirstSync?: boolean;
  }) {
    const c = this.repository.registerConnection(input);
    try {
      // 兜底 scope 种子来自注册表（executor 缺席/发现失败时；正常路径走 discoverScopes）。
      const fallbackScopes =
        syncProviderOf(input.provider)?.defaultScopes.map((scope) => ({
          id: scope.providerScopeId,
          displayName: scope.displayName,
        })) ?? [];
      const scopes = this.executor?.discoverScopes
        ? await this.executor.discoverScopes(c)
        : fallbackScopes;
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
    const scope = this.repository.getScope(scopeId),
      connection = scope && this.repository.getConnection(scope.connectionId);
    // 引擎门控：direct 源无需 Nango；nango 源在 secret 未就绪/引擎缺席时拒绝。
    if (!connection || !this.engine.canServe(connection.provider))
      throw new Error("connectors_disabled");
    if (
      !scope ||
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
    // 域投影软失败计数：run 结束时记一条汇总 sync_failures，不阻断 ingest。
    let projectionFailures = 0;
    const project = (action: () => unknown) => {
      if (!this.domainProjection) return;
      try {
        action();
      } catch {
        projectionFailures += 1;
      }
    };
    try {
      for await (const page of this.engine.pull(
        {
          ...scope,
          provider: connection.provider,
          connectionName: connection.connectionName,
          service: connection.service,
        },
        connection,
        mode,
      )) {
        if (this.cancelled.has(run.id)) throw new Error("cancelled");
        this.repository.applyPage(scope.id, run.id, fence, page.changes);
        this.repository.applyCalendarPage(scope.id, run.id, fence, page.calendarChanges ?? []);
        // 域投影先于 memorySink（M4）：投影返回行 id 随 memorySink 透传，
        // ingest 的 sourceId 直接用域行 id（对齐 CLI 路径；connector ref 仅存量遗留）。
        const projectedRowIds = new Map<string, string>();
        for (const change of page.changes) {
          project(() => {
            const result = this.domainProjection!.projectMail(connection.provider, connection.id, change);
            if (change.kind === "upsert" && result.id) projectedRowIds.set(change.message.providerMessageId, result.id);
          });
        }
        for (const change of page.calendarChanges ?? []) {
          project(() => {
            const result = this.domainProjection!.projectCalendar(connection.provider, connection.id, change);
            if (change.kind === "upsert" && result.id) projectedRowIds.set(change.event.providerEventId, result.id);
          });
        }
        for (const change of page.changes) {
          if (change.kind !== "upsert" || !this.memorySink) continue;
          await this.memorySink({
            kind: "mail",
            provider: connection.provider,
            connectionId: connection.id,
            documentId: change.message.providerMessageId,
            title: change.message.subject?.trim() || "（无主题）",
            markdown: mailToMarkdown(change.message),
            ...(projectedRowIds.get(change.message.providerMessageId)
              ? { domainRowId: projectedRowIds.get(change.message.providerMessageId)! }
              : {}),
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
            ...(projectedRowIds.get(change.event.providerEventId)
              ? { domainRowId: projectedRowIds.get(change.event.providerEventId)! }
              : {}),
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
      if (projectionFailures > 0) {
        this.repository.recordFailure(run.id, scope.id, "domain_projection",
          `域投影失败 ${projectionFailures} 条（软失败：数据仍经 markdown 进 ingest，读侧暂退化为快照解析）`, null);
      }
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
      for (const scope of this.repository.listScopes()) {
        if (scope.state === "disabled") continue;
        // 引擎门控前置：Nango secret 未就绪期间跳过 OAuth 源（避免 401 噪音），
        // direct 源（WebCal 订阅）不受影响照常轮询。
        const connection = this.repository.getConnection(scope.connectionId);
        if (!connection || !this.engine.canServe(connection.provider)) continue;
        try {
          this.trigger(scope.id, scope.sourceCursor ? "incremental" : "full");
        } catch {}
      }
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
