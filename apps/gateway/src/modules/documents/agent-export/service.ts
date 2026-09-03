import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type {
  AgentAuthChallengeView,
  AgentDocumentExportMode,
  AgentDocumentExportRunView,
  AgentDocumentExportTarget,
  ExternalDocumentProvider,
  ExternalDocumentWarning,
  RoomDocument,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import { agentDocumentExports } from "../../../infrastructure/database/schema.js";
import type { OpenConnectorCliConfig } from "../../../config.js";
import { agentDocumentMarkdown } from "../agent-markdown.js";
import type { DocumentService } from "../service.js";
import { readArtifact, storeArtifact } from "../import/artifact-store.js";
import { runImportConnectorAction, ImportConnectorError, type ImportActionRunner } from "../import/oo-runner.js";
import {
  LarkCliError,
  type LarkCliConfig,
  larkAuthStatus,
  larkCliVersion,
  runLarkCli,
} from "./lark-cli.js";

export const EXPORT_RENDERER_VERSION = "tiptap-markdown/agent-v1";
export const EXPORT_PAYLOAD_LIMIT_BYTES = 512 * 1024;

export class ExportServiceError extends Error {
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

export interface CreateExportInput {
  roomId: string;
  documentId: string;
  version?: number | undefined;
  provider: ExternalDocumentProvider;
  mode: AgentDocumentExportMode;
  target?: AgentDocumentExportTarget | null | undefined;
}

function sha256Of(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function warningsOf(value: unknown): ExternalDocumentWarning[] {
  return Array.isArray(value) ? (value as ExternalDocumentWarning[]) : [];
}

/**
 * lark-cli docs 命令返回的真实形状是 {document: {document_id, revision_id, url}}
 * （嵌套 + 蛇形命名），兼容根层与 camelCase 变体逐层查找；revision 等数字字段
 * 以字符串形式返回。
 */
function feishuFieldOf(value: unknown, camelKeys: string[], snakeKeys: string[] = []): string | null {
  const scalar = (raw: unknown): string | null => {
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
    return null;
  };
  const root = objectValue(value);
  const nested = objectValue(root.document);
  const file = objectValue(root.file);
  for (const source of [root, nested, file, objectValue(root.data)]) {
    for (const key of [...camelKeys, ...snakeKeys]) {
      const found = scalar(source[key]);
      if (found) return found;
    }
  }
  return null;
}

function feishuDocTokenOf(target: AgentDocumentExportTarget): string {
  const raw = target.remoteDocumentId?.trim() || target.remoteUrl?.trim() || "";
  if (!raw) {
    throw new ExportServiceError("EXPORT_TARGET_REQUIRED", "update 模式必须提供目标文档 URL 或 token", 422);
  }
  const match = /(?:docx|docs|wiki)[/?]+([A-Za-z0-9]{8,})/.exec(raw);
  return match?.[1] ?? raw;
}

function notionPageIdOf(target: AgentDocumentExportTarget): string {
  const raw = target.remoteDocumentId?.trim() || target.remoteUrl?.trim() || "";
  if (!raw) {
    throw new ExportServiceError("EXPORT_TARGET_REQUIRED", "update 模式必须提供目标页面 URL 或 ID", 422);
  }
  const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(raw);
  return (match?.[1] ?? raw).replaceAll("-", "");
}

/**
 * Agent 一次性导出：固定 Room 版本 → Markdown → CLI/skill 单次写入。
 * 只做审计记录，不建远端 binding、不自动重试不确定的写入。
 */
export class AgentDocumentExportService {
  private readonly connectorAction: ImportActionRunner;
  private readonly logger: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void } | null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly documents: DocumentService,
    private readonly connectorConfig: OpenConnectorCliConfig | null,
    private readonly lark: LarkCliConfig | null,
    private readonly dataDir: string,
    options?: {
      actionRunner?: ImportActionRunner;
      logger?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
    },
  ) {
    this.connectorAction = options?.actionRunner ?? runImportConnectorAction;
    this.logger = options?.logger ?? null;
  }

  /** 创建导出任务并执行前置检查；create 模式在授权就绪时直接完成写入。 */
  async runExport(input: CreateExportInput): Promise<AgentDocumentExportRunView> {
    const runId = await this.createRun(input);
    const view = await this.prepare(runId);
    if (view.status === "awaiting_confirmation" || view.status === "awaiting_auth"
      || view.status === "environment_not_ready" || view.status === "failed") {
      return view;
    }
    return this.executeRun(runId);
  }

  /**
   * REST 路径的后台驱动：createRun 之后异步跑 prepare/execute，调用方立即拿到
   * preparing 状态的 run 视图并轮询，让进度条能看到中间状态。
   */
  async runFrom(runId: string): Promise<void> {
    try {
      const view = await this.prepare(runId);
      if (view.status === "awaiting_confirmation" || view.status === "awaiting_auth"
        || view.status === "environment_not_ready" || view.status === "failed") {
        return;
      }
      await this.executeRun(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ exportRunId: runId, message }, "agent document export background run failed");
      this.transition(runId, "failed", {
        errorCode: "EXPORT_WRITE_FAILED",
        errorMessage: message,
      });
    }
  }

  /** 确认 update 目标后在后台执行写入（调用方轮询状态）。 */
  async confirm(runId: string): Promise<AgentDocumentExportRunView> {
    const run = this.loadRun(runId);
    if (run.status !== "awaiting_confirmation") {
      throw new ExportServiceError("NOT_AWAITING_CONFIRMATION", `任务状态为 ${run.status}，不能确认执行`, 409);
    }
    void this.executeRun(runId);
    return this.view(runId);
  }

  /**
   * 授权完成后恢复原任务（方案 §4.3）：对 awaiting_auth / environment_not_ready
   * 的任务重新执行 prepare（重新做只读连接检查），通过则继续写入。
   */
  async retry(runId: string): Promise<AgentDocumentExportRunView> {
    const run = this.loadRun(runId);
    if (run.status !== "awaiting_auth" && run.status !== "environment_not_ready") {
      throw new ExportServiceError("NOT_RETRYABLE", `任务状态为 ${run.status}，无需恢复`, 409);
    }
    void this.runFrom(runId);
    return this.view(runId);
  }

  async createRun(input: CreateExportInput): Promise<string> {
    if (input.mode === "update" && !input.target?.remoteDocumentId && !input.target?.remoteUrl) {
      throw new ExportServiceError(
        "EXPORT_TARGET_REQUIRED",
        "update 模式必须由用户提供目标文档 URL 或 ID，不猜测、不沿用历史导出目标",
        422,
      );
    }
    const document = this.documents.get(input.documentId);
    if (!document) throw new ExportServiceError("NOT_FOUND", "文档不存在", 404);
    if (document.roomId !== input.roomId) {
      throw new ExportServiceError("ROOM_MISMATCH", "文档属于其他 Room", 409);
    }
    const version = input.version ?? document.version;
    const snapshot = this.documents.getVersionSnapshot(input.documentId, version);
    if (!snapshot) {
      throw new ExportServiceError("VERSION_NOT_FOUND", `版本 ${String(version)} 不存在`, 404);
    }
    const prepared = this.materializeLocalAssets(snapshot.contentJson);
    const markdown = agentDocumentMarkdown.serialize(prepared.content).trim();
    if (!markdown) {
      throw new ExportServiceError("EXPORT_PAYLOAD_EMPTY", "文档内容为空，无法导出", 422);
    }
    if (Buffer.byteLength(markdown, "utf8") > EXPORT_PAYLOAD_LIMIT_BYTES) {
      throw new ExportServiceError("EXPORT_PAYLOAD_TOO_LARGE", "导出内容超过 512 KiB 上限", 422);
    }
    const payloadHash = sha256Of(markdown);
    const payloadMarkdownRef = await storeArtifact(this.dataDir, {
      kind: "export-payload",
      documentId: input.documentId,
      version,
      title: snapshot.title,
      markdown,
    });
    const runId = randomUUID();
    this.db.insert(agentDocumentExports).values({
      id: runId,
      requestId: randomUUID(),
      roomId: input.roomId,
      documentId: input.documentId,
      version,
      provider: input.provider,
      mode: input.mode,
      targetJson: input.target ?? null,
      rendererVersion: EXPORT_RENDERER_VERSION,
      payloadHash,
      payloadMarkdownRef,
      cliSkillRef: input.provider === "feishu" ? "lark-cli:docs" : "open-connector:notion",
      status: "preparing",
      warningsJson: prepared.warnings,
    }).run();
    return runId;
  }

  /**
   * 本地资产（nxcore-document-asset:// 等非 http 图片）的字节在桌面资产库，网关
   * 无法上传到远端；且 markdown 序列化会静默丢弃非 http 图片节点。导出前把这类
   * 节点替换为可见占位并记录告警（方案 §10：不允许静默降级）。
   */
  private materializeLocalAssets(content: TiptapJsonContent): {
    content: TiptapJsonContent;
    warnings: ExternalDocumentWarning[];
  } {
    const warnings: ExternalDocumentWarning[] = [];
    let count = 0;
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk);
      if (!value || typeof value !== "object") return value;
      const node = value as { type?: unknown; attrs?: { src?: unknown; alt?: unknown }; content?: unknown };
      if (node.type === "image") {
        const src = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
        if (src && !/^https?:\/\//i.test(src)) {
          count += 1;
          const alt = typeof node.attrs?.alt === "string" && node.attrs.alt.trim() ? node.attrs.alt.trim() : String(count);
          return {
            type: "paragraph",
            content: [{ type: "text", text: `（本地图片「${alt}」未随导出上传）` }],
          };
        }
        return node;
      }
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        next[key] = key === "attrs" ? item : walk(item);
      }
      return next;
    };
    const result = walk(content) as TiptapJsonContent;
    if (count > 0) {
      warnings.push({
        code: "local_assets_placeholder",
        message: `${String(count)} 张本地图片无法上传到远端，已替换为占位文本`,
      });
    }
    return { content: result, warnings };
  }

  /** 环境自检 → 授权检查 →（update）目标预检；不写入。 */
  async prepare(runId: string): Promise<AgentDocumentExportRunView> {
    const run = this.loadRun(runId);
    const target = run.targetJson ?? {};
    if (run.provider === "feishu") {
      if (!this.lark) {
        return this.transition(runId, "environment_not_ready", {
          errorCode: "ENVIRONMENT_NOT_READY",
          errorMessage: "lark-cli 未随发行包预装或不可用",
          warnings: [{ code: "environment_not_ready", message: "导出环境未就绪：lark-cli 不可用" }],
        });
      }
      const versionOk = await larkCliVersion(this.lark);
      if (!versionOk) {
        return this.transition(runId, "environment_not_ready", {
          errorCode: "ENVIRONMENT_NOT_READY",
          errorMessage: "lark-cli 版本自检失败",
          warnings: [{ code: "environment_not_ready", message: "导出环境未就绪：lark-cli 版本自检失败" }],
        });
      }
      let auth;
      try {
        auth = await larkAuthStatus(this.lark);
      } catch (error) {
        const mapped = error instanceof LarkCliError ? error : null;
        if (mapped?.kind === "environment") {
          return this.transition(runId, "environment_not_ready", {
            errorCode: "ENVIRONMENT_NOT_READY",
            errorMessage: mapped.detail,
            warnings: [{ code: "environment_not_ready", message: "导出环境未就绪" }],
          });
        }
        return this.transition(runId, "awaiting_auth", {
          challenge: challengeOf(run, "app_setup", "app_setup_required",
            "飞书应用尚未初始化", [
              { id: "config-init", title: "创建并配置自己的飞书应用", description: "由本地 lark-cli 引导完成，凭据只保存在本机", action: "run_cli_check", completed: false },
            ]),
        });
      }
      if (!auth.appConfigured) {
        return this.transition(runId, "awaiting_auth", {
          challenge: challengeOf(run, "app_setup", "app_setup_required",
            "飞书应用尚未初始化", [
              { id: "config-init", title: "创建并配置自己的飞书应用", description: "由本地 lark-cli 引导完成，凭据只保存在本机", action: "run_cli_check", completed: false },
            ]),
        });
      }
      // needs_refresh 是 lark-cli 常态（token 短时效、下次调用自动刷新）；
      // 只有明确失效（invalid/expired）或不可用才需要重新授权。
      const tokenDead = auth.tokenStatus === "invalid" || auth.tokenStatus === "expired";
      if (!auth.userAvailable || tokenDead) {
        return this.transition(runId, "awaiting_auth", {
          challenge: challengeOf(run, "user_auth", "not_connected",
            "飞书账号未授权或凭据已过期", [
              { id: "auth-login", title: "授权飞书账号", description: "扫码/登录并同意文档写入所需的最小权限", action: "run_cli_check", completed: false },
            ]),
        });
      }
    } else {
      if (!this.connectorConfig) {
        return this.transition(runId, "environment_not_ready", {
          errorCode: "ENVIRONMENT_NOT_READY",
          errorMessage: "OpenConnector 不可用，Notion 导出通道未就绪",
          warnings: [{ code: "environment_not_ready", message: "导出环境未就绪：OpenConnector 不可用" }],
        });
      }
      try {
        await this.connectorAction(this.connectorConfig, {
          service: "notion",
          action: "search",
          input: { query: "", page_size: 1 },
        });
      } catch (error) {
        if (error instanceof ImportConnectorError
          && (error.code === "no_connection" || error.code === "authentication_required")) {
          return this.transition(runId, "awaiting_auth", {
            challenge: challengeOf(run, "user_auth", "not_connected",
              "Notion Agent 导出授权未建立", [
                { id: "connect", title: "建立 Notion 导出授权", description: "与导入连接相互独立，需单独完成一次授权", action: "run_cli_check", completed: false },
              ]),
          });
        }
        if (error instanceof ImportConnectorError && error.code === "cli_unavailable") {
          return this.transition(runId, "environment_not_ready", {
            errorCode: "ENVIRONMENT_NOT_READY",
            errorMessage: error.detail,
            warnings: [{ code: "environment_not_ready", message: "导出环境未就绪：oo CLI 不可用" }],
          });
        }
        return this.transition(runId, "failed", {
          errorCode: "EXPORT_PRECHECK_FAILED",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (run.mode === "update") {
      const confirmation = await this.preflightUpdateTarget(runId);
      if (confirmation instanceof ExportServiceError) {
        return this.transition(runId, "failed", {
          errorCode: confirmation.code,
          errorMessage: confirmation.message,
        });
      }
      return this.transition(runId, "awaiting_confirmation", { confirmation });
    }
    // create 模式：写入前展示目标与摘要，无需再次确认（方案 §6.1）。
    return this.view(runId);
  }

  /** 用户确认后执行一次性写入；写入结果不确定时标记 needs_review，禁止自动重发。 */
  async confirmAndExecute(runId: string): Promise<AgentDocumentExportRunView> {
    const run = this.loadRun(runId);
    if (run.status !== "awaiting_confirmation") {
      throw new ExportServiceError("NOT_AWAITING_CONFIRMATION", `任务状态为 ${run.status}，不能确认执行`, 409);
    }
    return this.executeRun(runId);
  }

  async executeRun(runId: string): Promise<AgentDocumentExportRunView> {
    const run = this.loadRun(runId);
    const artifact = await this.loadPayload(run.payloadMarkdownRef);
    const markdown = typeof artifact.markdown === "string" ? artifact.markdown : "";
    const title = typeof artifact.title === "string" ? artifact.title : "导出文档";
    const target = run.targetJson ?? {};

    this.db.update(agentDocumentExports).set({ status: "running", updatedAt: new Date() })
      .where(eq(agentDocumentExports.id, runId)).run();

    try {
      if (run.provider === "feishu") {
        return await this.executeFeishu(runId, run.mode, title, markdown, target);
      }
      return await this.executeNotion(runId, run.mode, title, markdown, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const uncertain = /timed? out|timeout|cancelled/i.test(message);
      this.logger?.warn(
        { exportRunId: runId, provider: run.provider, mode: run.mode, uncertain, message },
        "agent document export write failed",
      );
      return this.transition(runId, uncertain ? "needs_review" : "failed", {
        errorCode: uncertain ? "EXPORT_WRITE_UNCERTAIN" : "EXPORT_WRITE_FAILED",
        errorMessage: message,
      });
    }
  }

  getRun(runId: string): AgentDocumentExportRunView {
    this.loadRun(runId);
    return this.view(runId);
  }

  listRuns(documentId?: string): AgentDocumentExportRunView[] {
    const rows = documentId
      ? this.db.select().from(agentDocumentExports)
        .where(eq(agentDocumentExports.documentId, documentId))
        .orderBy(desc(agentDocumentExports.createdAt)).all()
      : this.db.select().from(agentDocumentExports)
        .orderBy(desc(agentDocumentExports.createdAt)).all();
    return rows.map((row) => this.rowToView(row));
  }

  cancelRun(runId: string): AgentDocumentExportRunView {
    const run = this.loadRun(runId);
    if (run.status === "preparing" || run.status === "awaiting_auth" || run.status === "awaiting_confirmation") {
      return this.transition(runId, "cancelled", {});
    }
    return this.view(runId);
  }

  private async executeFeishu(
    runId: string,
    mode: AgentDocumentExportMode,
    title: string,
    markdown: string,
    target: AgentDocumentExportTarget,
  ): Promise<AgentDocumentExportRunView> {
    const config = this.requireLark();
    if (mode === "create") {
      const args = ["docs", "+create", "--doc-format", "markdown", "--title", title, "--content", "-"];
      const parentToken = target.parentId?.trim() || target.parentUrl?.trim();
      if (parentToken) {
        args.push("--parent-token", feishuDocTokenOf({ remoteDocumentId: parentToken }));
      } else {
        args.push("--parent-position", "my_library");
      }
      const { data } = await runLarkCli(config, args, { stdin: markdown });
      return this.finishSuccess(runId, data, "feishu");
    }
    if (mode === "update") {
      const docToken = feishuDocTokenOf(target);
      // append（默认）不破坏远端内容；replace_document 才整篇覆盖。
      if ((target.writeScope ?? "append") === "append") {
        const { data } = await runLarkCli(config, [
          "docs", "+update",
          "--command", "append",
          "--doc", docToken,
          "--doc-format", "markdown",
          "--content", "-",
        ], { stdin: markdown });
        return this.finishSuccess(runId, data, "feishu");
      }
      const revision = await this.fetchFeishuRevision(docToken);
      const { data } = await runLarkCli(config, [
        "docs", "+update",
        "--command", "overwrite",
        "--doc", docToken,
        "--doc-format", "markdown",
        "--revision-id", String(revision ?? -1),
        "--content", "-",
      ], { stdin: markdown });
      return this.finishSuccess(runId, data, "feishu");
    }
    if (mode === "export_file") {
      // 导出为飞书云空间原生 .md 文件（lark-cli markdown 域）。
      const fileName = `${title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "export"}.md`;
      const args = ["markdown", "+create", "--name", fileName, "--content", "-"];
      const parentToken = target.parentId?.trim() || target.parentUrl?.trim();
      if (parentToken) {
        args.push("--folder-token", feishuDocTokenOf({ remoteDocumentId: parentToken }));
      }
      const { data } = await runLarkCli(config, args, { stdin: markdown });
      return this.finishSuccess(runId, data, "feishu");
    }
    throw new ExportServiceError("EXPORT_MODE_UNSUPPORTED", "lark-cli 不支持的导出模式", 422);
  }

  private async executeNotion(
    runId: string,
    mode: AgentDocumentExportMode,
    title: string,
    markdown: string,
    target: AgentDocumentExportTarget,
  ): Promise<AgentDocumentExportRunView> {
    const config = this.requireConnector();
    if (mode === "create") {
      const parentId = target.parentId?.trim() || target.parentUrl?.trim() || null;
      const input: Record<string, unknown> = parentId
        ? { parentId: notionPageIdOf({ remoteDocumentId: parentId }), title, markdown }
        : { title, markdown };
      const data = await this.connectorAction(config, {
        service: "notion",
        action: "create_page",
        input,
      });
      return this.finishSuccess(runId, data, "notion");
    }
    if (mode === "update") {
      const pageId = notionPageIdOf(target);
      const append = (target.writeScope ?? "append") === "append";
      const data = await this.connectorAction(config, {
        service: "notion",
        action: "update_page_markdown",
        input: append
          ? { pageId, type: "insert_content", insert_content: { content: markdown } }
          : { pageId, type: "replace_content", replace_content: { content: markdown } },
      });
      return this.finishSuccess(runId, data, "notion");
    }
    throw new ExportServiceError("EXPORT_MODE_UNSUPPORTED", "Notion 通道暂不支持 export_file 模式", 422);
  }

  private async fetchFeishuRevision(docToken: string): Promise<number | null> {
    try {
      const { data } = await runLarkCli(this.requireLark(), [
        "docs", "+fetch", "--doc", docToken, "--scope", "outline", "--detail", "simple",
      ], { timeoutMs: 30_000 });
      const revision = feishuFieldOf(data, ["revisionId", "revision"], ["revision_id"]);
      const parsed = revision === null ? Number.NaN : Number.parseInt(revision, 10);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      // revision 读取失败时用 -1（最新）；并发风险由确认卡明示。
      return null;
    }
  }

  private async preflightUpdateTarget(runId: string): Promise<Record<string, unknown> | ExportServiceError> {
    const run = this.loadRun(runId);
    const target = run.targetJson ?? {};
    const append = (target.writeScope ?? "append") === "append";
    try {
      if (run.provider === "feishu") {
        const docToken = feishuDocTokenOf(target);
        const { data } = await runLarkCli(this.requireLark(), [
          "docs", "+fetch", "--doc", docToken, "--scope", "outline", "--detail", "simple",
        ], { timeoutMs: 30_000 });
        const title = feishuFieldOf(data, ["title", "name"])
          ?? feishuFieldOf(objectValue(data).document, ["title", "name"])
          ?? "飞书文档";
        const revision = feishuFieldOf(data, ["revisionId", "revision"], ["revision_id"]);
        return {
          targetTitle: title,
          targetUrl: target.remoteUrl ?? feishuFieldOf(data, ["url"], ["url"]) ?? `https://feishu.cn/docx/${docToken}`,
          roomVersion: run.version,
          writeScope: append ? "append" : "replace_document",
          remoteRevision: revision,
          warnings: append ? [] : [{
            code: "overwrite_warning",
            message: "将用 Room 版本替换整篇目标文档，可能影响其中的图片、评论与飞书特有块",
          }],
        };
      }
      const pageId = notionPageIdOf(target);
      const data = await this.connectorAction(this.requireConnector(), {
        service: "notion",
        action: "retrieve_page",
        input: { pageId },
      });
      const root = objectValue(data);
      return {
        targetTitle: textValue(root.title) ?? textValue(objectValue(root.properties).title) ?? "Notion 页面",
        targetUrl: textValue(root.url) ?? `https://notion.so/${pageId}`,
        roomVersion: run.version,
        writeScope: append ? "append" : "replace_content",
        remoteRevision: textValue(root.lastEditedTime) ?? textValue(root.last_edited_time),
        warnings: append ? [] : [{
          code: "overwrite_warning",
          message: "将用 Room 版本替换目标页面的 Markdown 内容",
        }],
      };
    } catch (error) {
      if (error instanceof LarkCliError && error.kind === "auth_required") {
        return new ExportServiceError("EXPORT_AUTH_REQUIRED", `目标预检需要授权：${error.detail}`, 422);
      }
      if (error instanceof ImportConnectorError
        && (error.code === "no_connection" || error.code === "authentication_required")) {
        return new ExportServiceError("EXPORT_AUTH_REQUIRED", "Notion 导出授权未建立", 422);
      }
      return new ExportServiceError(
        "EXPORT_TARGET_UNREACHABLE",
        `无法读取目标文档：${error instanceof Error ? error.message : String(error)}`,
        422,
      );
    }
  }

  private finishSuccess(runId: string, data: unknown, provider: ExternalDocumentProvider): AgentDocumentExportRunView {
    const remoteUrl = feishuFieldOf(data, ["url", "documentUrl"], ["remote_url"]);
    const remoteId = feishuFieldOf(data, ["documentId", "id", "token"], ["document_id"]);
    const remoteRevision = feishuFieldOf(data, ["revisionId", "revision"], ["revision_id"]);
    if (!remoteUrl && !remoteId) {
      // 写入可能已发生但结果不可识别：标记待人工核查，禁止自动重发。
      return this.transition(runId, "needs_review", {
        errorCode: "EXPORT_RESULT_UNRECOGNIZED",
        errorMessage: `${provider} 写入已执行，但返回结果无法识别远端地址，请人工核查`,
        remoteResultJson: objectValue(data),
      });
    }
    return this.transition(runId, "succeeded", {
      remoteResultJson: {
        url: remoteUrl,
        id: remoteId,
        revision: remoteRevision,
      },
    });
  }

  private loadRun(runId: string) {
    const run = this.db.select().from(agentDocumentExports).where(eq(agentDocumentExports.id, runId)).get();
    if (!run) throw new ExportServiceError("NOT_FOUND", "导出任务不存在", 404);
    return run;
  }

  private async loadPayload(ref: string | null): Promise<Record<string, unknown>> {
    if (!ref) throw new ExportServiceError("PAYLOAD_MISSING", "导出 payload 缺失", 500);
    return objectValue(await readArtifact(this.dataDir, ref));
  }

  private requireLark(): LarkCliConfig {
    if (!this.lark) {
      throw new ExportServiceError("ENVIRONMENT_NOT_READY", "lark-cli 未配置", 503);
    }
    return this.lark;
  }

  private requireConnector(): OpenConnectorCliConfig {
    if (!this.connectorConfig) {
      throw new ExportServiceError("ENVIRONMENT_NOT_READY", "OpenConnector 未配置", 503);
    }
    return this.connectorConfig;
  }

  private transition(
    runId: string,
    status: AgentDocumentExportRunView["status"],
    patch: {
      challenge?: AgentAuthChallengeView | null;
      confirmation?: Record<string, unknown> | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      warnings?: ExternalDocumentWarning[];
      remoteResultJson?: Record<string, unknown> | null;
    },
  ): AgentDocumentExportRunView {
    this.db.update(agentDocumentExports).set({
      status,
      ...(patch.challenge !== undefined ? { challengeJson: patch.challenge } : {}),
      ...(patch.confirmation !== undefined ? { confirmationJson: patch.confirmation } : {}),
      ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
      ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      ...(patch.warnings !== undefined ? { warningsJson: patch.warnings } : {}),
      ...(patch.remoteResultJson !== undefined ? { remoteResultJson: patch.remoteResultJson } : {}),
      updatedAt: new Date(),
      completedAt: ["succeeded", "failed", "cancelled", "needs_review"].includes(status) ? new Date() : null,
    }).where(eq(agentDocumentExports.id, runId)).run();
    return this.view(runId);
  }

  private view(runId: string): AgentDocumentExportRunView {
    const row = this.loadRun(runId);
    return this.rowToView(row);
  }

  private rowToView(row: typeof agentDocumentExports.$inferSelect): AgentDocumentExportRunView {
    const document = this.documents.get(row.documentId);
    return {
      id: row.id,
      requestId: row.requestId,
      roomId: row.roomId,
      documentId: row.documentId,
      version: row.version,
      documentTitle: document?.title ?? null,
      provider: row.provider,
      mode: row.mode,
      target: row.targetJson ?? null,
      payloadHash: row.payloadHash,
      rendererVersion: row.rendererVersion,
      cliSkillRef: row.cliSkillRef,
      status: row.status,
      challenge: row.challengeJson ?? null,
      confirmation: (row.confirmationJson as AgentDocumentExportRunView["confirmation"]) ?? null,
      remoteUrl: textValue(objectValue(row.remoteResultJson).url) ?? null,
      remoteRevision: textValue(objectValue(row.remoteResultJson).revision) ?? null,
      warnings: warningsOf(row.warningsJson),
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }
}

function challengeOf(
  run: typeof agentDocumentExports.$inferSelect,
  phase: AgentAuthChallengeView["phase"],
  reason: AgentAuthChallengeView["reason"],
  title: string,
  steps: AgentAuthChallengeView["steps"],
): AgentAuthChallengeView {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  return {
    id: `challenge-${run.id}`,
    provider: run.provider,
    operation: "export",
    phase,
    status: "required",
    reason,
    title,
    steps,
    verificationUrl: null,
    localResumeHandle: run.id,
    expiresAt: expiresAt.toISOString(),
  };
}

export type { RoomDocument };
