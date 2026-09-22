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
}
