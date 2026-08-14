export class AsrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AsrError";
  }
}

export class AliyunAsrError extends AsrError {
  constructor(operation: string, message: string, options?: ErrorOptions) {
    super("aliyun_asr_error", `Aliyun ASR ${operation} failed: ${message}`, 502, options);
    this.name = "AliyunAsrError";
  }
}
