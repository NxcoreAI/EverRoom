/** 记忆模块的业务错误，统一在 create-server 的错误处理器映射为 HTTP 响应。 */
export class MemoryGatewayError extends Error {
  constructor(
    readonly code:
      | "memory_disabled"
      | "memory_unreachable"
      | "memory_error",
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "MemoryGatewayError";
  }
}
