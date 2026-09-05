import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type {
  CanonicalDocumentArtifact,
  DocumentImportCommentDiffSummary,
  ExternalDocumentCommentView,
  DocumentImportHistoryEntry,
  DocumentImportRunView,
  ExternalDocumentPreview,
  ExternalDocumentProvider,
  ExternalDocumentSearchResponse,
  ExternalDocumentWarning,
  RoomDocument,
} from "@nxcore/agent-contract";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  documentImportComments,
  documentImportRuns,
  documentImportSnapshots,
  documentImportSources,
  documentRoomImports,
} from "../../../infrastructure/database/schema.js";
import type { OpenConnectorCliConfig } from "../../../config.js";
import { agentDocumentMarkdown } from "../agent-markdown.js";
import type { DocumentService } from "../service.js";
import { artifactHashOf, readArtifact, storeArtifact } from "./artifact-store.js";
import { ImportConnectorError, runImportConnectorAction, type ImportActionRunner } from "./oo-runner.js";
import { importAdapterOf, type ExternalDocumentProviderAdapter, type ImportActionFn } from "./providers.js";

export class ImportServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, statusCode = 400, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface CommitImportInput {
  runId: string;
  roomId: string;
  /** 提供时表示"同一来源再次导入到该文档"：生成候选版本，不覆盖当前文档。 */
  targetDocumentId?: string;
}

export interface CommitImportResult {
  run: DocumentImportRunView;
  roomImportId: string;
  /** primary：新建文档版本 1；candidate：物化候选文档，待用户应用。 */
  relation: "primary" | "candidate";
  documentId: string;
  document: RoomDocument;
}

function isoToDateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function warningsOf(value: unknown): ExternalDocumentWarning[] {
  return Array.isArray(value) ? (value as ExternalDocumentWarning[]) : [];
}

/**
 * 飞书 / Notion 文档导入编排。导入只经 OpenConnector 读 action；快照不可变，
 * Room 落地全部走 DocumentService（DocumentCommitService 乐观锁），不做任何
 * 远端同步状态机。
 */
export class DocumentImportService {
  private readonly actionRunner: ImportActionRunner;

  private readonly assetBridgeUrl: string | null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly documents: DocumentService,
    private readonly connectorConfig: OpenConnectorCliConfig | null,
    private readonly dataDir: string,
    options?: { actionRunner?: ImportActionRunner; assetBridgeUrl?: string | null },
  ) {
    this.actionRunner = options?.actionRunner ?? runImportConnectorAction;
    this.assetBridgeUrl = options?.assetBridgeUrl?.replace(/\/$/, "") ?? null;
  }

  async search(provider: ExternalDocumentProvider, query: string): Promise<ExternalDocumentSearchResponse> {
    const adapter = this.adapterOf(provider);
    return adapter.searchDocuments(query.trim())
      .then((result) => ({ provider, items: result.items, warnings: result.warnings }))
      .catch((error) => {
        throw this.mapConnectorError(error);
      });
  }

  async preview(provider: ExternalDocumentProvider, remoteDocumentId: string): Promise<ExternalDocumentPreview> {
    const adapter = this.adapterOf(provider);
    const config = this.requireConfig();
    const runId = randomUUID();
    const now = new Date();
    this.db.insert(documentImportRuns).values({
      id: runId,
      requestId: randomUUID(),
      provider,
      remoteDocumentId,
      status: "reading",
      actionRefsJson: adapter.actionRefs,
    }).run();

    let artifact: CanonicalDocumentArtifact;
    try {
      const read = await adapter.readDocument(remoteDocumentId);
      let comments = artifactCommentsEmpty();
      let commentsStatus: CanonicalDocumentArtifact["commentsStatus"] = "unavailable";
      const warnings: ExternalDocumentWarning[] = [...read.warnings];
      try {
        const commentResult = await adapter.readComments(remoteDocumentId);
        comments = commentResult.comments;
        commentsStatus = commentResult.status;
        warnings.push(...commentResult.warnings);
      } catch (error) {
        // 评论读取失败不阻断正文导入，但必须显式标记，不能伪装成"没有评论"。
        commentsStatus = "failed";
        warnings.push({
          code: "comments_read_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      artifact = {
        provider,
        remoteDocumentId,
        sourceUrl: read.sourceUrl,
        title: read.title.slice(0, 120),
        bodyMarkdown: read.bodyMarkdown,
        assets: read.assets,
        comments,
        commentsStatus,
        sourceRevision: read.sourceRevision,
        sourceUpdatedAt: read.sourceUpdatedAt,
        warnings,
      };
    } catch (error) {
      const mapped = this.mapConnectorError(error);
      this.finishRun(runId, "failed", mapped.code, mapped.message);
      throw mapped;
    }

    // 分页边界可能出现重复远端 id：按 id 去重（快照、预览与入库共用同一列表）。
    artifact = {
      ...artifact,
      comments: [...new Map(artifact.comments.map((comment) => [comment.id, comment])).values()],
    };
    // 远端图片物化（B-9）：经桌面资产桥 PUT 落 DocumentAssetStore，改写为本机
    // nxcore-document-asset:// URL（编辑器原生可渲染）；失败保留远端链接并告警。
    artifact = await this.materializeRemoteAssets(artifact, runId);

    const artifactRef = await storeArtifact(this.dataDir, artifact);
    const sourceId = await this.upsertSource(artifact);
    const snapshotId = randomUUID();
    const contentHash = artifactHashOf(Buffer.from(artifact.bodyMarkdown, "utf8"));
    this.db.insert(documentImportSnapshots).values({
      id: snapshotId,
      sourceId,
      importRunId: runId,
      artifactRef,
      contentHash,
      sourceRevision: artifact.sourceRevision,
      commentsStatus: artifact.commentsStatus,
      commentsHash: artifact.commentsStatus === "complete"
        ? artifactHashOf(Buffer.from(JSON.stringify(artifact.comments), "utf8"))
        : null,
      warningsJson: artifact.warnings,
    }).run();
    // 分页边界可能出现重复远端 id；按 remote id 去重（表上有唯一索引兜底）。
    const seenCommentIds = new Set<string>();
    for (const comment of artifact.comments) {
      if (seenCommentIds.has(comment.id)) continue;
      seenCommentIds.add(comment.id);
      this.db.insert(documentImportComments).values({
        id: randomUUID(),
        snapshotId,
        remoteCommentId: comment.id,
        parentRemoteCommentId: comment.parentId,
        authorJson: comment.authorName === null ? null : { name: comment.authorName },
        body: comment.body,
        quotedText: comment.anchor?.quotedText ?? null,
        anchorJson: comment.anchor,
        status: comment.resolved === null ? "unknown" : comment.resolved ? "resolved" : "open",
        sourceUrl: comment.sourceUrl,
        locationStatus: comment.locationStatus,
        commentCreatedAt: isoToDateOrNull(comment.createdAt),
        commentUpdatedAt: isoToDateOrNull(comment.updatedAt),
      }).run();
    }
    this.db.update(documentImportRuns).set({
      status: "preview",
      sourceId,
      snapshotId,
      warningsJson: artifact.warnings,
      updatedAt: new Date(),
    }).where(eq(documentImportRuns.id, runId)).run();

    return {
      runId,
      provider,
      remoteDocumentId,
      title: artifact.title,
      bodyExcerpt: artifact.bodyMarkdown.slice(0, 4000),
      sourceUrl: artifact.sourceUrl,
      sourceRevision: artifact.sourceRevision,
      sourceUpdatedAt: artifact.sourceUpdatedAt,
      comments: artifact.comments.map((comment) => ({
        id: comment.id,
        parentId: comment.parentId,
        authorName: comment.authorName,
        body: comment.body,
        quotedText: comment.anchor?.quotedText ?? null,
        resolved: comment.resolved,
        sourceUrl: comment.sourceUrl,
        locationStatus: comment.locationStatus,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
      commentsStatus: artifact.commentsStatus,
      warnings: artifact.warnings,
    };
  }

  async commitToRoom(input: CommitImportInput): Promise<CommitImportResult> {
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, input.runId)).get();
    if (!run) throw new ImportServiceError("NOT_FOUND", "导入任务不存在", 404);
    if (run.status !== "preview") {
      throw new ImportServiceError("IMPORT_RUN_NOT_PREVIEWABLE", `导入任务状态为 ${run.status}，不能提交`, 409);
    }
    const snapshot = run.snapshotId
      ? this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, run.snapshotId)).get()
      : null;
    if (!snapshot) throw new ImportServiceError("SNAPSHOT_MISSING", "导入快照缺失", 409);
    const artifact = await this.loadArtifact(snapshot.artifactRef);
    const contentJson = agentDocumentMarkdown.parse(artifact.bodyMarkdown) as RoomDocument["contentJson"];

    const isCandidate = input.targetDocumentId !== undefined;
    const roomImportId = randomUUID();
    let document: RoomDocument;
    let candidateDocumentId: string | null = null;
    let importedVersion: number | null = null;

    this.db.update(documentImportRuns).set({
      status: "committing",
      targetRoomId: input.roomId,
      targetDocumentId: input.targetDocumentId ?? null,
      updatedAt: new Date(),
    }).where(eq(documentImportRuns.id, run.id)).run();

    if (isCandidate) {
      // 再次导入：物化独立的候选文档，不覆盖当前 Room 文档（方案 §5.3）。
      const candidateTitle = `${artifact.title}（外部更新候选）`.slice(0, 120);
      document = await this.documents.import({
        id: `imp-cand-${randomUUID()}`,
        roomId: input.roomId,
        title: candidateTitle,
        contentJson,
      });
      candidateDocumentId = document.id;
    } else {
      document = await this.documents.import({
        id: `imp-${randomUUID()}`,
        roomId: input.roomId,
        title: artifact.title,
        contentJson,
      });
      importedVersion = document.version;
    }

    this.db.insert(documentRoomImports).values({
      id: roomImportId,
      roomId: input.roomId,
      documentId: input.targetDocumentId ?? document.id,
      importRunId: run.id,
      snapshotId: snapshot.id,
      importedVersion,
      relation: isCandidate ? "candidate" : "primary",
      candidateDocumentId,
    }).run();
    this.finishRun(run.id, "succeeded");

    return {
      run: this.getRun(run.id),
      roomImportId,
      relation: isCandidate ? "candidate" : "primary",
      documentId: isCandidate ? candidateDocumentId! : document.id,
      document,
    };
  }

  /**
   * "检查外部更新"：对已挂接外部来源的 Room 文档重新读取远端并生成候选版本。
   * 与"应用此版本"（applyCandidate）是两个独立动作。
   */
  async checkExternalUpdate(roomId: string, documentId: string): Promise<CommitImportResult> {
    const rows = this.db.select()
      .from(documentRoomImports)
      .where(and(eq(documentRoomImports.roomId, roomId), eq(documentRoomImports.documentId, documentId)))
      .orderBy(desc(documentRoomImports.createdAt))
      .all();
    if (rows.length === 0) {
      throw new ImportServiceError("NO_IMPORT_SOURCE", "该文档没有外部导入来源", 404);
    }
    const latest = rows[0]!;
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, latest.importRunId)).get();
    if (!run?.sourceId) {
      throw new ImportServiceError("NO_IMPORT_SOURCE", "该文档的导入记录缺少来源信息", 409);
    }
    const source = this.db.select().from(documentImportSources).where(eq(documentImportSources.id, run.sourceId)).get();
    if (!source) {
      throw new ImportServiceError("NO_IMPORT_SOURCE", "导入来源记录缺失", 409);
    }
    const preview = await this.preview(source.provider, source.remoteDocumentId);
    return this.commitToRoom({
      runId: preview.runId,
      roomId,
      targetDocumentId: documentId,
    });
  }

  /** "应用此版本"：把候选快照提交为当前文档的正式新版本。 */
  async applyCandidate(roomImportId: string): Promise<{ document: RoomDocument; version: number }> {
    const row = this.db.select().from(documentRoomImports).where(eq(documentRoomImports.id, roomImportId)).get();
    if (!row) throw new ImportServiceError("NOT_FOUND", "导入关联记录不存在", 404);
    if (row.relation !== "candidate") {
      throw new ImportServiceError("NOT_A_CANDIDATE", "只有候选导入才能应用此版本", 409);
    }
    if (row.importedVersion !== null) {
      throw new ImportServiceError("CANDIDATE_ALREADY_APPLIED", "该候选版本已应用", 409);
    }
    const snapshot = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, row.snapshotId)).get();
    if (!snapshot) throw new ImportServiceError("SNAPSHOT_MISSING", "导入快照缺失", 409);
    const artifact = await this.loadArtifact(snapshot.artifactRef);
    const target = this.documents.get(row.documentId);
    if (!target) throw new ImportServiceError("NOT_FOUND", "目标文档不存在", 404);
    if (target.roomId !== row.roomId) {
      throw new ImportServiceError("ROOM_MISMATCH", "目标文档属于其他 Room", 409);
    }
    if (target.deletedAt) {
      throw new ImportServiceError("DOCUMENT_TRASHED", "目标文档已在回收站，先恢复再应用", 409);
    }
    if (target.activeTransactionId) {
      throw new ImportServiceError("DOCUMENT_BUSY", "Agent 正在写入该文档", 409);
    }
    const contentJson = agentDocumentMarkdown.parse(artifact.bodyMarkdown) as RoomDocument["contentJson"];
    const saved = await this.documents.save(row.documentId, {
      baseVersion: target.version,
      title: artifact.title,
      contentJson,
    });
    this.db.update(documentRoomImports).set({ importedVersion: saved.version }).where(eq(documentRoomImports.id, roomImportId)).run();
    return { document: saved, version: saved.version };
  }

  async importHistory(roomId: string, documentId: string): Promise<{
    entries: DocumentImportHistoryEntry[];
    commentDiff: DocumentImportCommentDiffSummary | null;
    comments: ExternalDocumentCommentView[];
  }> {
    const rows = this.db.select({
      roomImport: documentRoomImports,
      run: documentImportRuns,
      snapshot: documentImportSnapshots,
      source: documentImportSources,
    })
      .from(documentRoomImports)
      .innerJoin(documentImportRuns, eq(documentRoomImports.importRunId, documentImportRuns.id))
      .innerJoin(documentImportSnapshots, eq(documentRoomImports.snapshotId, documentImportSnapshots.id))
      .innerJoin(documentImportSources, eq(documentImportRuns.sourceId, documentImportSources.id))
      .where(and(eq(documentRoomImports.roomId, roomId), eq(documentRoomImports.documentId, documentId)))
      .orderBy(desc(documentRoomImports.createdAt))
      .all();
    const entries: DocumentImportHistoryEntry[] = rows.map(({ roomImport, snapshot, source }) => ({
      importRunId: roomImport.importRunId,
      roomImportId: roomImport.id,
      snapshotId: snapshot.id,
      relation: roomImport.relation,
      importedVersion: roomImport.importedVersion,
      candidateDocumentId: roomImport.candidateDocumentId,
      provider: source.provider,
      remoteDocumentId: source.remoteDocumentId,
      displayTitle: source.displayTitle ?? "外部文档",
      sourceUrl: source.sourceUrl,
      sourceRevision: snapshot.sourceRevision,
      capturedAt: snapshot.capturedAt.toISOString(),
      commentsStatus: snapshot.commentsStatus,
      warnings: warningsOf(snapshot.warningsJson),
    }));
    const commentDiff = rows.length >= 2
      ? this.commentDiffSummary(rows.map((row) => row.snapshot.id))
      : null;
    // 最新快照的评论（只读面板数据，B-1）；无记录时返回空。
    const comments = rows[0]
      ? this.db.select().from(documentImportComments)
        .where(eq(documentImportComments.snapshotId, rows[0].snapshot.id))
        .orderBy(documentImportComments.parentRemoteCommentId, documentImportComments.remoteCommentId)
        .all()
        .slice(0, 200)
        .map((row) => ({
          id: row.remoteCommentId,
          parentId: row.parentRemoteCommentId,
          authorName: row.authorJson?.name ?? null,
          body: row.body,
          quotedText: row.quotedText,
          resolved: row.status === "resolved" ? true : row.status === "open" ? false : null,
          sourceUrl: row.sourceUrl,
          locationStatus: row.locationStatus,
          createdAt: row.commentCreatedAt?.toISOString() ?? null,
          updatedAt: row.commentUpdatedAt?.toISOString() ?? null,
        }))
      : [];
    return { entries, commentDiff, comments };
  }

  /** 候选 vs 当前文档的行级 diff（B-2）：服务端算 hunks，前端只渲染。 */
  async candidateDiff(roomImportId: string): Promise<{
    candidateTitle: string;
    currentTitle: string;
    appliedVersion: number | null;
    hunks: Array<{ type: "ctx" | "add" | "del"; text: string }>;
    commentsComparable: boolean;
  }> {
    const { diffLines } = await import("diff");
    const row = this.db.select().from(documentRoomImports).where(eq(documentRoomImports.id, roomImportId)).get();
    if (!row) throw new ImportServiceError("NOT_FOUND", "导入关联记录不存在", 404);
    const snapshot = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, row.snapshotId)).get();
    if (!snapshot) throw new ImportServiceError("SNAPSHOT_MISSING", "导入快照缺失", 409);
    const artifact = await this.loadArtifact(snapshot.artifactRef);
    const target = this.documents.get(row.documentId);
    if (!target) throw new ImportServiceError("NOT_FOUND", "目标文档不存在", 404);
    const currentSnapshot = this.documents.getVersionSnapshot(row.documentId, target.version);
    if (!currentSnapshot) throw new ImportServiceError("NOT_FOUND", "当前版本快照缺失", 409);
    const { agentDocumentMarkdown } = await import("../agent-markdown.js");
    const currentMarkdown = agentDocumentMarkdown.serialize(currentSnapshot.contentJson);
    const parts = diffLines(currentMarkdown, artifact.bodyMarkdown);
    // 折叠未变更区域：仅保留变更行 ±3 行上下文。
    const KEEP_CTX = 3;
    const keep = new Array<boolean>(parts.length).fill(false);
    parts.forEach((part, index) => {
      if (part.added || part.removed) {
        for (let near = index - KEEP_CTX; near <= index + KEEP_CTX; near += 1) {
          if (near >= 0 && near < parts.length) keep[near] = true;
        }
      }
    });
    const hunks: Array<{ type: "ctx" | "add" | "del"; text: string }> = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || !keep[index]) continue;
      const type = part.added ? "add" : part.removed ? "del" : "ctx";
      const last = hunks.at(-1);
      const text = part.value.replace(/\n$/, "");
      if (last && last.type === type) last.text += `\n${text}`;
      else hunks.push({ type, text });
    }
    return {
      candidateTitle: `${artifact.title}（外部更新候选）`,
      currentTitle: target.title,
      appliedVersion: row.importedVersion,
      hunks,
      commentsComparable: snapshot.commentsStatus === "complete",
    };
  }

  getRun(runId: string): DocumentImportRunView {
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, runId)).get();
    if (!run) throw new ImportServiceError("NOT_FOUND", "导入任务不存在", 404);
    const snapshot = run.snapshotId
      ? this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, run.snapshotId)).get()
      : undefined;
    return {
      id: run.id,
      requestId: run.requestId,
      provider: run.provider,
      remoteDocumentId: run.remoteDocumentId,
      sourceId: run.sourceId,
      snapshotId: run.snapshotId,
      targetRoomId: run.targetRoomId,
      targetDocumentId: run.targetDocumentId,
      status: run.status,
      warnings: warningsOf(run.warningsJson),
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      commentsStatus: snapshot?.commentsStatus ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }

  cancelRun(runId: string): DocumentImportRunView {
    const run = this.db.select().from(documentImportRuns).where(eq(documentImportRuns.id, runId)).get();
    if (!run) throw new ImportServiceError("NOT_FOUND", "导入任务不存在", 404);
    if (run.status === "searching" || run.status === "reading" || run.status === "preview") {
      this.finishRun(runId, "cancelled");
    }
    return this.getRun(runId);
  }

  private commentDiffSummary(snapshotIds: string[]): DocumentImportCommentDiffSummary {
    const [newerId, olderId] = snapshotIds;
    const loadComments = (snapshotId: string) => this.db.select()
      .from(documentImportComments)
      .where(eq(documentImportComments.snapshotId, snapshotId))
      .all();
    const newer = loadComments(newerId!);
    const older = loadComments(olderId!);
    const newerStatus = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, newerId!)).get()?.commentsStatus;
    const olderStatus = this.db.select().from(documentImportSnapshots).where(eq(documentImportSnapshots.id, olderId!)).get()?.commentsStatus;
    // 只有两次快照评论都完整时才可比；缺失不能误判为全部删除（方案 §4.2）。
    if (newerStatus !== "complete" || olderStatus !== "complete") {
      return { comparable: false, added: 0, resolved: 0, modified: 0, removed: 0, reason: "comments_incomplete" };
    }
    const olderById = new Map(older.map((row) => [row.remoteCommentId, row]));
    const newerIds = new Set(newer.map((row) => row.remoteCommentId));
    let added = 0;
    let modified = 0;
    let resolved = 0;
    for (const row of newer) {
      const before = olderById.get(row.remoteCommentId);
      if (!before) added += 1;
      else {
        if (before.body !== row.body) modified += 1;
        if (before.status === "open" && row.status === "resolved") resolved += 1;
      }
    }
    const removed = older.filter((row) => !newerIds.has(row.remoteCommentId)).length;
    return { comparable: true, added, resolved, modified, removed, reason: null };
  }

  private async materializeRemoteAssets(
    artifact: CanonicalDocumentArtifact,
    runId: string,
  ): Promise<CanonicalDocumentArtifact> {
    if (!this.assetBridgeUrl) return artifact;
    const bridge = this.assetBridgeUrl;
    const syntheticDocId = `import-${runId.slice(0, 12)}`;
    const warnings: ExternalDocumentWarning[] = [...artifact.warnings];
    let materialized = 0;
    let failed = 0;
    const bodyMarkdown = await replaceAsync(artifact.bodyMarkdown, /!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)[^)]*\)/g,
      async (full: string, alt: string, url: string) => {
        if (materialized + failed >= 10) return full;
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
          const mime = ((response.headers.get("content-type") ?? "").split(";")[0] ?? "").trim();
          if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
            throw new Error(`不支持的图片类型 ${mime}`);
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("图片超过 5MB");
          const put = await fetch(`${bridge}?doc=${encodeURIComponent(syntheticDocId)}`, {
            method: "PUT",
            headers: { "Content-Type": mime },
            body: bytes,
            signal: AbortSignal.timeout(15_000),
          });
          if (!put.ok) throw new Error(`资产桥 PUT ${String(put.status)}`);
          const stored = await put.json() as { src?: unknown };
          const src = typeof stored.src === "string" ? stored.src : null;
          if (!src) throw new Error("资产桥未返回 src");
          materialized += 1;
          return `![${alt}](${src})`;
        } catch {
          failed += 1;
          return full;
        }
      });
    if (materialized > 0) {
      warnings.push({
        code: "remote_assets_materialized",
        message: `${String(materialized)} 张远端图片已下载为本机资产`,
      });
    }
    if (failed > 0) {
      warnings.push({
        code: "asset_materialize_failed",
        message: `${String(failed)} 张远端图片下载失败，保留原链接`,
      });
    }
    return { ...artifact, bodyMarkdown, warnings };
  }

  private async loadArtifact(ref: string): Promise<CanonicalDocumentArtifact> {
    const value = await readArtifact(this.dataDir, ref);
    if (!value || typeof value !== "object") {
      throw new ImportServiceError("ARTIFACT_INVALID", "导入快照内容无效", 500);
    }
    return value as CanonicalDocumentArtifact;
  }

  private async upsertSource(artifact: CanonicalDocumentArtifact): Promise<string> {
    const existing = this.db.select().from(documentImportSources)
      .where(and(
        eq(documentImportSources.ownerId, "local-user"),
        eq(documentImportSources.provider, artifact.provider),
        eq(documentImportSources.remoteDocumentId, artifact.remoteDocumentId),
      ))
      .get();
    if (existing) {
      this.db.update(documentImportSources).set({
        sourceUrl: artifact.sourceUrl,
        displayTitle: artifact.title,
        lastSeenRevision: artifact.sourceRevision,
        updatedAt: new Date(),
      }).where(eq(documentImportSources.id, existing.id)).run();
      return existing.id;
    }
    const id = randomUUID();
    this.db.insert(documentImportSources).values({
      id,
      ownerId: "local-user",
      provider: artifact.provider,
      remoteDocumentId: artifact.remoteDocumentId,
      sourceUrl: artifact.sourceUrl,
      displayTitle: artifact.title,
      lastSeenRevision: artifact.sourceRevision,
    }).run();
    return id;
  }

  private finishRun(runId: string, status: DocumentImportRunStatusLike, errorCode?: string, errorMessage?: string): void {
    this.db.update(documentImportRuns).set({
      status,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
      updatedAt: new Date(),
      completedAt: ["succeeded", "failed", "cancelled"].includes(status) ? new Date() : null,
    }).where(eq(documentImportRuns.id, runId)).run();
  }

  private requireConfig(): OpenConnectorCliConfig {
    if (!this.connectorConfig) {
      throw new ImportServiceError(
        "OPEN_CONNECTOR_UNAVAILABLE",
        "OpenConnector 尚未迁移或不可用，导入入口暂不可用",
        503,
      );
    }
    return this.connectorConfig;
  }

  private adapterOf(provider: ExternalDocumentProvider): ExternalDocumentProviderAdapter {
    const config = this.requireConfig();
    const run: ImportActionFn = (call, signal) => this.actionRunner(config, call, signal);
    return importAdapterOf(provider, run);
  }

  private mapConnectorError(error: unknown): ImportServiceError {
    if (error instanceof ImportServiceError) return error;
    if (error instanceof ImportConnectorError) {
      if (error.code === "authentication_required" || error.code === "no_connection") {
        return new ImportServiceError(
          "IMPORT_CONNECTION_REQUIRED",
          `导入连接不可用：${error.detail}。请在连接器管理中建立该服务的导入连接。`,
          422,
        );
      }
      if (error.code === "action_not_found") {
        return new ImportServiceError("IMPORT_ACTION_MISSING", `OpenConnector 动作不可用：${error.detail}`, 502);
      }
      if (error.code === "cli_unavailable") {
        return new ImportServiceError("OPEN_CONNECTOR_UNAVAILABLE", `OpenConnector CLI 不可用：${error.detail}`, 503);
      }
      return new ImportServiceError("IMPORT_READ_FAILED", `外部文档读取失败：${error.detail}`, 502);
    }
    return new ImportServiceError(
      "IMPORT_READ_FAILED",
      error instanceof Error ? error.message : String(error),
      502,
    );
  }
}

type DocumentImportRunStatusLike = DocumentImportRunView["status"];

function artifactCommentsEmpty(): CanonicalDocumentArtifact["comments"] {
  return [];
}


/** 顺序执行的异步正则替换（物化远端图片用）。 */
async function replaceAsync(
  source: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const tasks: Array<Promise<string>> = [];
  source.replace(pattern, (match: string, ...groups: string[]) => {
    tasks.push(replacer(match, ...groups.slice(0, -2)));
    return match;
  });
  const results = await Promise.all(tasks);
  let cursor = 0;
  return source.replace(pattern, () => results[cursor++] ?? "");
}
