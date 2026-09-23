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
  fileName: string | null;
  idempotencyKey: string;
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

  /** 逐页填充：PageSpec 经与整册生成同一条 builder/merge 管线原地替换一页（实时重绘 + 静默保存）。 */
  async fillPage(input: { fileId: string; slideIndex: number; specJson: string }): Promise<OfficeSlidesEditResult> {
    const data = await this.postEdit({
      mode: "apply",
      fileId: input.fileId,
      page: { slideIndex: input.slideIndex, specJson: input.specJson },
    });
    return { ...(data as unknown as OfficeSlidesEditResult), ok: data.ok !== false };
  }

  private async postEdit(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.baseUrl}/v1/office-edit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      // 活会话事务（内存应用 + 一次静默保存），不是分钟级的生成链路。
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await response.json().catch(() => ({})) as {
      message?: unknown;
      data?: Record<string, unknown>;
    };
    if (!response.ok) {
      throw new Error(
        typeof parsed.message === "string" ? parsed.message : `Office edit failed (${response.status})`,
      );
    }
    return parsed.data ?? {};
  }
}
