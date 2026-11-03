import type { GatewayConfig } from "../../../config.js";

export type OfficeGenerateFormat = "docx" | "pptx" | "xlsx";

export interface OfficeSheetBridgeInput {
  name: string | null;
  rows: (string | number | boolean | null)[][];
}

export interface OfficeGenerateInput {
  title: string;
  /** 缺省 docx。 */
  format?: OfficeGenerateFormat;
  /** docx：受限 HTML 正文。 */
  html?: string | null;
  /** pptx：每页一个 PageSpec JSON 字符串。 */
  pages?: string[] | null;
  /** xlsx：sheets→rows。 */
  sheets?: OfficeSheetBridgeInput[] | null;
  roomId: string | null;
  /** 会话所属工作区：产物入库归属（资料库/产物库按空间隔离）。 */
  workspaceId?: string | null;
  fileName: string | null;
  idempotencyKey: string;
  /** pptx：true = 不广播 done（骨架入库阶段），由网关全部落页后经 completeDeck 补发真完成。 */
  deferDone?: boolean;
}

/** /v1/office-complete：逐页落定后的真完成广播（done 后移到全部页完成）。 */
export interface OfficeCompleteInput {
  fileId: string;
  title: string;
  originalName?: string;
  roomId?: string | null;
  completed: boolean;
  appliedPages: number;
  totalPages: number;
  /** 失败/退化页 0 起页码。 */
  failedPages?: number[];
}

/** 桌面 office-bridge /v1/office-generate 的返回（见 office-bridge.ts）。 */
export interface OfficeGenerateResult {
  fileEntryId: string;
  fileVersionId: string;
  jobId: string;
  contentHash: string;
  blobDeduped: boolean;
  versionDeduped: boolean;
  roomRequested: boolean;
  originalName: string;
  /** 出稿提示：模版骨架回落、自检软伤等。面板要展示给用户，不能吞。 */
  warnings?: string[];
}

/** /v1/office-apply-bytes：把 Agent 改好的 Office 文件字节落回当前打开的实例。 */
export interface OfficeApplyBytesInput {
  fileId: string;
  bytesBase64: string;
  /** 基线版本内容指纹（桌面端据此判断文件在生成字节期间是否被保存过）。 */
  expectedContentHash: string;
}

export interface OfficeApplyBytesResult {
  ok: boolean;
  reason?: "not_open" | "not_editable" | "unsaved" | "conflict" | "error";
  message?: string;
  /** 落盘后的库内版本号（桌面端回填版本链后返回）。 */
  version?: number;
  fileVersionId?: string;
}

/** /v1/office-export-pdf：把文件库里的 .docx 导出成 PDF 并作为新文件入库。 */
export interface OfficeExportPdfInput {
  fileId: string;
  /** 输出文件名（可选，默认取原文件名 .pdf）；桌面端校验 .pdf 后缀。 */
  fileName?: string | null;
  roomId?: string | null;
  /** 产物归属工作区（与源文件同空间；资料库/产物库按空间隔离）。 */
  workspaceId?: string | null;
}

export interface OfficeExportPdfResult {
  ok: boolean;
  /** 新 PDF 的 fileEntryId（入库后）。 */
  fileId: string;
  originalName: string;
  /** PDF 内容指纹（有则透传，便于去重/引用）。 */
  contentHash?: string;
}

/** /v1/office-edit read：活会话大纲 + op 词汇表。 */
export interface OfficeSlidesDeckInfo {
  outline: string;
  opVocabulary: string;
  /** 宿主补充：实例是否可编辑（只读打开也能读大纲，编辑需重新以可编辑方式打开）。 */
  editable?: boolean;
}

/** /v1/office-edit apply：事务结果（ok:false = 宿主级错误；per-op 失败在 failures）。 */
export interface OfficeSlidesEditResult {
  ok: boolean;
  error?: string;
  applied?: boolean;
  dryRun?: boolean;
  plan?: string[];
  records?: Array<{ op: string; target?: string; created?: string[] }>;
  failures?: Array<{ index: number; error: string }>;
  saved?: boolean;
  saveError?: string;
  outline?: string;
  /** PageSpec 解析告警（逐页填充路径）：页面已渲染，但建议关注。 */
  warnings?: Array<{ page: number; messages: string[] }>;
}

export interface OfficeSlidesEditInput {
  fileId: string;
  ops: unknown[];
  dryRun?: boolean;
  isolation?: "atomic" | "per_op";
}

/** /v1/office-agent-tools 工具调用（docs/sheets 渲染层 AI 工具）。 */
export interface OfficeAgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** describe 结果：上下文 + 工具词汇表（+ 指南）。 */
export interface OfficeAgentArtifactDescription {
  context: string;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  commandsGuide?: string;
  htmlRules?: string;
  guides?: Record<string, string>;
  /** current text watermark (Word), null when the document has none */
  watermark?: string | null;
  /** current page setup: orientation/paper/margins/columns/pageColor/sectionCount */
  pageSetup?: Record<string, unknown>;
  /** Word：word_agent_ops 的 op 词汇表（按能力分组的 op 名 + 字段说明，渲染层是唯一事实源）。 */
  operationsGuide?: string;
  /** Word：文档对象现状（章节/页眉页脚/批注/域/引用/修订/表格等），供 ops 定位。 */
  documentState?: Record<string, unknown>;
}

/** apply 结果：逐调用结果（isError = 该调用失败；mutated = 有落盘变更）。 */
export interface OfficeAgentToolsResult {
  ok: boolean;
  error?: string;
  /** 后台 Word 会话在本次 apply 内完成版本回填后的新版本 id。 */
  version?: string;
  results?: Array<{
    id: string;
    name: string;
    output: string;
    isError?: boolean;
    mutated?: boolean;
    summary?: string;
    /** 端侧附加的逐条明细（如 word_agent_ops 的 per-op 结果），原样透传给模型。 */
    details?: unknown;
  }>;
}

export class OfficeBridgeClient {
  constructor(private readonly config: NonNullable<GatewayConfig["officeBridge"]>) {}

  async generate(input: OfficeGenerateInput): Promise<OfficeGenerateResult> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      // 隐藏渲染端生成 + file-imports 入库全链路可到分钟级。
      signal: AbortSignal.timeout(5 * 60_000),
    });
    const body = await response.json().catch(() => ({})) as { message?: unknown; data?: Record<string, unknown> };
    if (!response.ok) {
      throw new Error(typeof body.message === "string" ? body.message : `Office bridge failed (${response.status})`);
    }
    const data = body.data ?? {};
    const str = (key: string) => typeof data[key] === "string" ? data[key] as string : "";
    return {
      fileEntryId: str("fileEntryId"),
      fileVersionId: str("fileVersionId"),
      jobId: str("jobId"),
      contentHash: str("contentHash"),
      blobDeduped: data.blobDeduped === true,
      versionDeduped: data.versionDeduped === true,
      roomRequested: data.roomRequested === true,
      originalName: str("originalName"),
    };
  }

  /** /v1/office-complete：全部页落定后补发 done（真完成时机），渲染层据此 toast/打开成品。 */
  async completeDeck(input: OfficeCompleteInput): Promise<{ ok: boolean }> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      // 纯广播通知，无渲染链路。
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => ({})) as { message?: unknown };
    if (!response.ok) {
      throw new Error(typeof body.message === "string" ? body.message : `Office complete failed (${response.status})`);
    }
    return { ok: true };
  }

  /** /v1/office-render：PageSpec → pptx 字节，不入库不广播（风格演示页自校专用）。 */
  async renderPptx(input: { title: string; pages: string[] }): Promise<Buffer> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-render`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      // 单页渲染（秒级）；soffice/sips 转换在调用方。
      signal: AbortSignal.timeout(2 * 60_000),
    });
    const body = await response.json().catch(() => ({})) as { message?: unknown; data?: Record<string, unknown> };
    if (!response.ok) {
      throw new Error(typeof body.message === "string" ? body.message : `Office render failed (${response.status})`);
    }
    const base64 = body.data?.pptxBase64;
    if (typeof base64 !== "string" || base64.length === 0) throw new Error("Office render 返回缺少 pptx 字节");
    return Buffer.from(base64, "base64");
  }

  /** 读取已打开 PPT 产物的活会话大纲 + op 词汇表（fileId 'active' = 当前打开的那个）。 */
  async readDeck(fileId: string): Promise<OfficeSlidesDeckInfo> {
    const data = await this.postEdit({ mode: "read", fileId });
    return {
      outline: typeof data.outline === "string" ? data.outline : "",
      opVocabulary: typeof data.opVocabulary === "string" ? data.opVocabulary : "",
      ...(data.editable !== undefined ? { editable: data.editable === true } : {}),
    };
  }

  /** 向已打开 PPT 产物的活会话应用一个 op 事务（编辑实时重绘在打开的视图上，随后静默保存）。 */
  async editDeck(input: OfficeSlidesEditInput): Promise<OfficeSlidesEditResult> {
    const data = await this.postEdit({
      mode: "apply",
      fileId: input.fileId,
      ops: input.ops,
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
    });
    return { ...(data as unknown as OfficeSlidesEditResult), ok: data.ok !== false };
  }

  /** 逐页生成：PageSpec 经与整册生成同一条 builder/merge 管线落地——替换指定页或在末尾追加新页（实时重绘 + 静默保存）。 */
  async fillPage(input: { fileId: string; slideIndex: number; specJson: string }): Promise<OfficeSlidesEditResult> {
    const data = await this.postEdit({
      mode: "apply",
      fileId: input.fileId,
      page: { slideIndex: input.slideIndex, specJson: input.specJson },
    // 与整册 generate 同级预算：嵌大图 + 栅格化 + 保存，30s 会把首页落页打成超时失败。
    }, 5 * 60_000);
    return { ...(data as unknown as OfficeSlidesEditResult), ok: data.ok !== false };
  }

  /** 活 Word/Excel describe：上下文 + 工具词汇表 + 指南（fileId 'active' = 当前打开的那个）。 */
  async describeAgentArtifact(
    input: {
      kind: "docx" | "spreadsheet";
      fileId: string;
      /** 会话所属 Room/工作区：桌面端为 headless 编辑补齐实例归属（可选，旧端忽略）。 */
      roomId?: string | null;
      workspaceId?: string | null;
    },
  ): Promise<OfficeAgentArtifactDescription> {
    const data = await this.postAgentTools({
      kind: input.kind,
      fileId: input.fileId,
      mode: "read",
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
    const describe = (data.describe ?? {}) as Record<string, unknown>;
    const result: OfficeAgentArtifactDescription = {
      context: typeof describe.context === "string" ? describe.context : "",
      tools: [],
      guides: {},
    };
    if (Array.isArray(describe.tools)) result.tools = describe.tools as NonNullable<OfficeAgentArtifactDescription["tools"]>;
    if (describe.guides && typeof describe.guides === "object") result.guides = describe.guides as Record<string, string>;
    if (typeof describe.commandsGuide === "string") result.commandsGuide = describe.commandsGuide;
    if (typeof describe.htmlRules === "string") result.htmlRules = describe.htmlRules;
    if (typeof describe.watermark === "string" || describe.watermark === null) {
      result.watermark = describe.watermark;
    }
    if (describe.pageSetup && typeof describe.pageSetup === "object") {
      result.pageSetup = describe.pageSetup as Record<string, unknown>;
    }
    if (typeof describe.operationsGuide === "string") result.operationsGuide = describe.operationsGuide;
    if (describe.documentState && typeof describe.documentState === "object") {
      result.documentState = describe.documentState as Record<string, unknown>;
    }
    return result;
  }

  /** 活 Word/Excel apply：渲染层执行 docs/sheets AI 工具调用（编辑实时重绘，随后静默保存）。 */
  async applyAgentArtifactTools(
    input: {
      kind: "docx" | "spreadsheet";
      fileId: string;
      calls: OfficeAgentToolCall[];
      /** 会话所属 Room/工作区：桌面端为 headless 编辑补齐实例归属（可选，旧端忽略）。 */
      roomId?: string | null;
      workspaceId?: string | null;
    },
  ): Promise<OfficeAgentToolsResult> {
    const data = await this.postAgentTools({
      kind: input.kind,
      fileId: input.fileId,
      calls: input.calls,
      mode: "apply",
      ...(input.roomId ? { roomId: input.roomId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
    const result: OfficeAgentToolsResult = {
      ok: true,
      results: [],
    };
    if (typeof data.error === "string") result.error = data.error;
    if (typeof data.version === "string") result.version = data.version;
    if (Array.isArray(data.results)) result.results = data.results as NonNullable<OfficeAgentToolsResult["results"]>;
    return result;
  }

  /** 视觉复检：已打开 slides 产物的一页 → 1x PNG base64（渲染层离屏栅格化，秒级）。 */
  async renderPage(input: { fileId: string; slideIndex: number }): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-render-page`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      // 渲染层栅格化 + 应答回传；桌面端主进程侧另有 20s 请求超时兜底。
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await response.json().catch(() => ({})) as {
      message?: unknown;
      data?: { pngBase64?: unknown };
    };
    if (!response.ok) {
      throw new Error(typeof parsed.message === "string" ? parsed.message : `Office render-page failed (${response.status})`);
    }
    const base64 = parsed.data?.pngBase64;
    if (typeof base64 !== "string" || base64.length === 0) throw new Error("Office render-page 返回缺少 pngBase64");
    return base64;
  }

  /** /v1/office-reformat describe：源论文 docx → 块大纲（装订映射的区间事实源）。 */
  async describeThesisDocx(input: { docxBase64: string }): Promise<{
    blockCount: number;
    outline: Array<{ index: number; kind: string; level?: number; text: string }>;
  }> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-reformat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ action: "describe", ...input }),
      signal: AbortSignal.timeout(60_000),
    });
    const parsed = await response.json().catch(() => ({})) as {
      message?: unknown;
      data?: { blockCount?: unknown; outline?: unknown };
    };
    if (!response.ok) {
      throw new Error(typeof parsed.message === "string" ? parsed.message : `Office reformat failed (${response.status})`);
    }
    const outline = Array.isArray(parsed.data?.outline)
      ? (parsed.data!.outline as Array<Record<string, unknown>>).map((block) => ({
        index: Number(block.index),
        kind: String(block.kind ?? "paragraph"),
        ...(block.level !== undefined && block.level !== null ? { level: Number(block.level) } : {}),
        text: String(block.text ?? "").slice(0, 400),
      }))
      : [];
    return { blockCount: Number(parsed.data?.blockCount ?? outline.length), outline };
  }

  /** /v1/office-reformat build：源 docx + 格式卡 + 装订规格 → 装订版 docx 入库并广播。 */
  async reformatThesisDocx(input: {
    docxBase64: string;
    /** 模版 docx（base64）：有则按「模板骨架」装订，模版元素按原位置保留。 */
    templateBase64?: string;
    formatCard: unknown;
    bindingSpec: unknown;
    /** 产物入库归属（工作区）：排版结果与源文件落在同一空间（资料库按空间隔离）。 */
    workspaceId: string;
    sourceFileName: string;
    sourceFileEntryId: string;
    idempotencyKey: string;
    /** false = 不回填模版 Logo（规则面板勾选项）。 */
    keepLogo?: boolean;
    /** true = 本次勾选了「AI 补写」，产物文件名要带 -ai补写版 后缀。 */
    aiFill?: boolean;
  }): Promise<OfficeGenerateResult> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-reformat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ action: "build", ...input }),
      // 解析 + 装订渲染 + 入库整链路可到分钟级。
      signal: AbortSignal.timeout(5 * 60_000),
    });
    const body = await response.json().catch(() => ({})) as { message?: unknown; data?: Record<string, unknown> };
    if (!response.ok) {
      throw new Error(typeof body.message === "string" ? body.message : `Office reformat failed (${response.status})`);
    }
    const data = body.data ?? {};
    const str = (key: string) => typeof data[key] === "string" ? data[key] as string : "";
    const warnings = Array.isArray(data.warnings)
      ? data.warnings.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    return {
      fileEntryId: str("fileEntryId"),
      fileVersionId: str("fileVersionId"),
      jobId: str("jobId"),
      contentHash: str("contentHash"),
      blobDeduped: data.blobDeduped === true,
      versionDeduped: data.versionDeduped === true,
      roomRequested: data.roomRequested === true,
      originalName: str("originalName"),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * /v1/office-apply-bytes：把 Agent 改好的字节写回「用户正开着的那份」，
   * 由桌面端完成工作副本覆盖、版本链回填、访达原文件写回与视图重开。
   */
  async applyFileBytes(input: OfficeApplyBytesInput): Promise<OfficeApplyBytesResult> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-apply-bytes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      // 覆盖工作副本 + 版本回填 + 视图重开；大文件走 base64，超时放宽。
      signal: AbortSignal.timeout(120_000),
    })
    const parsed = await response.json().catch(() => ({})) as {
      message?: unknown;
      data?: Record<string, unknown>;
    }
    const data = parsed.data ?? {}
    if (!response.ok) {
      const reason = typeof data.reason === "string" ? data.reason as OfficeApplyBytesResult["reason"] : "error"
      return {
        ok: false,
        ...(reason ? { reason } : {}),
        message: typeof data.message === "string"
          ? data.message
          : typeof parsed.message === "string" ? parsed.message : `Office apply failed (${response.status})`,
      }
    }
    return {
      ok: true,
      ...(typeof data.version === "number" ? { version: data.version } : {}),
      ...(typeof data.fileVersionId === "string" ? { fileVersionId: data.fileVersionId } : {}),
    }
  }

  /**
   * /v1/office-export-pdf：桌面端用 LibreOffice 把文件库里的 .docx 转成 PDF，
   * 并作为新文件入库（返回新 fileId/文件名）。网关不搬字节，只传目标与归属。
   */
  async exportPdf(input: OfficeExportPdfInput): Promise<OfficeExportPdfResult> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-export-pdf`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      // LibreOffice 转换 + PDF 入库整链路；大文档可到分钟级。
      signal: AbortSignal.timeout(5 * 60_000),
    });
    const parsed = await response.json().catch(() => ({})) as {
      message?: unknown;
      data?: Record<string, unknown>;
      ok?: unknown;
    };
    // 桌面端成功走 { data: {...} } 信封；个别错误路径直接给扁平 { ok:false, message }。
    const data = parsed.data ?? (parsed as Record<string, unknown>);
    const messageOf = (fallback: string): string =>
      typeof data.message === "string"
        ? data.message
        : typeof parsed.message === "string" ? parsed.message : fallback;
    if (!response.ok) throw new Error(messageOf(`Office export-pdf failed (${response.status})`));
    if (data.ok === false) throw new Error(messageOf("Office export-pdf failed"));
    const fileId = typeof data.fileId === "string" ? data.fileId.trim() : "";
    const originalName = typeof data.originalName === "string" ? data.originalName.trim() : "";
    if (!fileId) throw new Error("OFFICE_EXPORT_FAILED: 桌面端未返回 PDF 文件条目");
    return {
      ok: true,
      fileId,
      originalName: originalName || `${fileId}.pdf`,
      ...(typeof data.contentHash === "string" ? { contentHash: data.contentHash } : {}),
    };
  }

  private async postAgentTools(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-agent-tools`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      // 渲染层执行 + 一次静默保存；大文档的 insert/replace 可能接近这个量级。
      signal: AbortSignal.timeout(150_000),
    });
    const parsed = await response.json().catch(() => ({})) as {
      message?: unknown;
      data?: Record<string, unknown>;
    };
    if (!response.ok) {
      throw new Error(
        typeof parsed.message === "string" ? parsed.message : `Office agent-tools failed (${response.status})`,
      );
    }
    return parsed.data ?? {};
  }

  private async postEdit(body: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-edit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      // 常规 op 事务是内存应用 + 一次静默保存；fillPage 走整册 builder/merge 管线
      // + 实时重绘（带大图首页可超 30s），由调用方放宽。
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await response.json().catch(() => ({})) as {
      message?: unknown;
      code?: unknown;
      data?: Record<string, unknown>;
    };
    if (!response.ok) {
      // 桌面端 422 带结构化 code（not_open/not_editable）：挂在 Error 上，
      // 调用方按 code 判定，不再对中文文案跑正则（not_editable 文案会被 not_open 正则误伤）。
      const message = typeof parsed.message === "string" ? parsed.message : `Office edit failed (${response.status})`;
      const error = new Error(message) as Error & { code?: string };
      if (typeof parsed.code === "string" && parsed.code) error.code = parsed.code;
      throw error;
    }
    return parsed.data ?? {};
  }
}
