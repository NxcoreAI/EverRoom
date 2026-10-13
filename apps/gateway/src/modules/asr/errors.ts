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

export class OpenAiAsrError extends AsrError {
  constructor(operation: string, message: string, options?: ErrorOptions) {
    super("openai_asr_error", `OpenAI-compatible ASR ${operation} failed: ${message}`, 502, options);
    this.name = "OpenAiAsrError";
  }
}

export class NxCoreAsrError extends AsrError {
  constructor(operation: string, message: string, options?: ErrorOptions) {
    super("nxcore_asr_error", `nxcore-asr ${operation} failed: ${message}`, 502, options);
    this.name = "NxCoreAsrError";
  }
}
