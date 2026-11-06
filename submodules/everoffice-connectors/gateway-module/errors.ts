/**
 * 转换层错误（自宿主 ingest 模块迁入：统一理解引擎退役后，连接器子包自带）。
 * 保留 code / statusCode 语义，供 routes 映射 HTTP 状态。
 */
export type ConnectorConvertErrorCode =
  | "unsupported_type"
  | "convert_failed"
  | "empty_content"
  | "path_unreadable";

export class IngestError extends Error {
  constructor(
    message: string,
    readonly code: ConnectorConvertErrorCode,
    readonly statusCode = 422,
  ) {
    super(message);
    this.name = "IngestError";
  }
}
