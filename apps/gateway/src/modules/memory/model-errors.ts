/**
 * 记忆侧「模型档位还没就绪」的错误标记。
 *
 * 为什么要和普通调用失败分开：桌面端启动时模型档位是空的，要等运行时配置 gate /
 * SaaS 激活后由 `applyRuntimeConfig` patch 进 config。这个窗口期里的每一次提炼
 * 都会抛错——如果和网络/上游错误一样计进 `maxAttempts`（默认 3），三次机会会在
 * 档位就绪之前被烧光，会话内容此后**永久**不再提炼（游标停在 null、attempts=3，
 * 之后每次触发都是 attempts-exceeded）。2026-11-02 那次「我是李展萍」会话就是
 * 这么丢的（见 docs/hippo-memory-adoption-plan.zh-CN.md §14 同源问题）。
 *
 * 判定口径：档位未就绪 = 环境没准备好，**不消耗**重试次数；真正的调用失败
 * （网络、上游 5xx、解析不出 JSON）仍然计数，避免对坏端点无限重试。
 */
const MEMORY_MODEL_UNAVAILABLE_CODE = "memory_model_unavailable";

export class MemoryModelUnavailableError extends Error {
  readonly code = MEMORY_MODEL_UNAVAILABLE_CODE;

  constructor(message = "no model slot configured for memory") {
    super(message);
    this.name = "MemoryModelUnavailableError";
  }
}

/**
 * 是否「档位未就绪」：既认本模块的实例，也认跨边界复制过的对象（打包/序列化后
 * `instanceof` 会失效，按 code 兜底）。
 */
export function isMemoryModelUnavailable(error: unknown): boolean {
  if (error instanceof MemoryModelUnavailableError) return true;
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === MEMORY_MODEL_UNAVAILABLE_CODE;
}
