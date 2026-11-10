import { describe, expect, it, vi } from "vitest";
import { dispatchWithConcurrencyRetry } from "../src/modules/subagents/tools.js";

/**
 * 2026-10-20 事故回归：slides 长链路 dispatch 遇到并发限额时，全局限额要等真实容量
 * （等待计入预算，超预算抛原错误），页级限额只做短退避，非并发错误立即抛出。
 * 全部用例用毫秒级等待，避免测试耗时。
 */
describe("dispatchWithConcurrencyRetry", () => {
  it("全局限额两次后等到容量再重试成功", async () => {
    const dispatch = vi.fn(async () => "ok");
    dispatch
      .mockRejectedValueOnce(new Error("subagent_global_concurrency_limit"))
      .mockRejectedValueOnce(new Error("subagent_global_concurrency_limit"));
    const awaitCapacity = vi.fn(async () => true);

    const result = await dispatchWithConcurrencyRetry(() => dispatch(), {
      awaitCapacity,
      capacityWaitMs: 5,
      budgetMs: 2000,
    });

    expect(result).toBe("ok");
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(awaitCapacity).toHaveBeenCalledTimes(2);
  });

  it("容量等待预算耗尽后抛原并发错误，不静默降级", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("subagent_global_concurrency_limit");
    });
    const awaitCapacity = vi.fn(async () => false);

    await expect(
      dispatchWithConcurrencyRetry(() => dispatch(), {
        awaitCapacity,
        capacityWaitMs: 5,
        budgetMs: 50,
      }),
    ).rejects.toThrow("subagent_global_concurrency_limit");
    // 等待计入预算：预算耗尽后不再继续尝试。
    expect(awaitCapacity).toHaveBeenCalledTimes(1);
  });

  it("非并发限额错误不重试，也不等容量", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("subagent_input_schema_invalid");
    });
    const awaitCapacity = vi.fn(async () => true);

    await expect(dispatchWithConcurrencyRetry(() => dispatch(), { awaitCapacity }))
      .rejects.toThrow("subagent_input_schema_invalid");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(awaitCapacity).not.toHaveBeenCalled();
  });

  it("页级限额走短退避，不等全局容量", async () => {
    const dispatch = vi.fn(async () => "ok");
    dispatch
      .mockRejectedValueOnce(new Error("subagent_concurrency_limit"))
      .mockRejectedValueOnce(new Error("subagent_concurrency_limit"));
    const awaitCapacity = vi.fn(async () => true);

    const result = await dispatchWithConcurrencyRetry(() => dispatch(), {
      awaitCapacity,
      delaysMs: [1, 1],
    });

    expect(result).toBe("ok");
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(awaitCapacity).not.toHaveBeenCalled();
  });
});
